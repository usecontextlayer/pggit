import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	cloneAndFsck,
	countObjects,
	type GcFixture,
	objectOids,
	pushDenied,
	pushFile,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"

/**
 * Denied-push reclamation + the deny-non-FF push contract
 * (originally `docs/2026-06-24-force-commit-gc-design.md` §4: GC-4, FC-1, FC-2 —
 * re-oriented 2026-07-05 when receive-pack grew the deny-non-FF policy).
 *
 * The old §1 force-commit workload (a ref moving to a NON-descendant each turn)
 * is retired: refs only advance now. The orphan source in the deny-non-FF era is
 * the DENIED push — the wire protocol ingests the pack before the policy pass,
 * so a refused push leaves its objects in Postgres as unreachable garbage while
 * the ref stays untouched. GC reclaims those orphans once they age past `grace`,
 * so steady-state storage tracks the CURRENT reachable tree rather than growing
 * with refused-push count.
 *
 * OBSERVABLE-ONLY: assertions read the real `git` oracle (clone/fetch/fsck/
 * rev-list), Postgres rows (`git_object` via the helpers), and the `gc()` return
 * value — never GC internals (temp tables, batch counts, CTE/txn shape). Grace is
 * made deterministic by pushing `graceSeconds: 0` (reclaim all unreachable) against
 * freshly-ingested-but-refused objects — no wall-clock sleep needed.
 */
describe("GC denied-push — reclamation, bound, and push contract (§4 GC-4/FC-1/FC-2, deny-non-FF era)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	// GC-4 (orphan reclamation): a denied force-push ingests a non-descendant
	// closure but never moves `main` — its commit + tree + unique blob are born
	// unreachable. With `graceSeconds: 0` (reclaim all unreachable) GC must delete
	// exactly those orphans and keep exactly the LIVE tip's closure — proved
	// against the real-git reachable closure (the independent survivor oracle)
	// and a clean clone.
	it("GC-4 — denied-push orphans (commit/tree/blob) are gone after GC; the live tip survives", async () => {
		const repo = "gc4-orphans"

		// First push establishes the ref; the second is an independent root commit
		// force-pushed and DENIED — objects ingested, ref untouched. Distinct
		// content ⇒ distinct blob/tree/commit OIDs on each side.
		const live = await pushFile(fx, repo, { content: "turn-1 transcript\n" })
		const denied = await pushDenied(fx, repo, { content: "turn-2 transcript\n" })

		// Sanity: the denied tip is a genuinely different, non-descendant commit,
		// so its unique objects are orphans (none shared — distinct content).
		expect(denied.head).not.toBe(live.head)
		const orphaned = denied.reachable.filter((oid) => !live.reachable.includes(oid))
		expect(orphaned.length).toBeGreaterThan(0)

		// Before GC: Postgres holds BOTH closures (the pack was ingested before the
		// policy refused the ref move).
		const before = await objectOids(fx.db, repo)
		for (const oid of orphaned) expect(before).toContain(oid)

		// GC with zero grace: reclaim every unreachable object. The orphans are a
		// LOWER bound on what GC reclaims, not an exact count. The exact
		// reclamation invariant is pinned by the survivor-set equality below
		// (`after == live.reachable`), which fixes BOTH no-under-delete (every
		// live oid present) and no-over-delete (nothing live removed).
		const result = await fx.gc.gc(repo, { graceSeconds: 0 })
		expect(result.deletedObjects).toBeGreaterThanOrEqual(orphaned.length)

		// After GC: the denied push's orphans are absent; the live tip's closure
		// remains; Postgres survivors == the real-git reachable closure of the
		// live tip (neither over- nor under-deletes).
		const after = await objectOids(fx.db, repo)
		for (const oid of orphaned) expect(after).not.toContain(oid)
		for (const oid of live.reachable) expect(after).toContain(oid)
		expect(after).toEqual([...live.reachable].sort())

		// And the repo still clones clean to the LIVE tip's content — the denied
		// push changed nothing an observer can see.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(live.head)
		expect(clone.fileContent).toBe("turn-1 transcript\n")
	})

	// GC-4 (storage bound): K denied-push-then-GC cycles with `graceSeconds: 0`
	// must NOT grow `git_object` with K. After every cycle the row count returns
	// to the live reachable-set size (a single-file commit = 3 objects: commit,
	// tree, blob) — flat in K, not K-proportional.
	it("GC-4 — K denied-push-then-GC cycles keep git_object ≈ the live reachable set (no growth in K)", async () => {
		const repo = "gc4-bound"
		const K = 6

		// Cycle 1: establish the ref, then GC.
		const c1 = await pushFile(fx, repo, { content: "cycle 1\n" })
		await fx.gc.gc(repo, { graceSeconds: 0 })
		const countAfter1 = await countObjects(fx.db, repo)
		const reachable1 = c1.reachable.length

		// Steady state after a single-file commit + zero-grace GC == its closure.
		expect(countAfter1).toBe(reachable1)

		// Cycles 2..K: each attempts (and is denied) a fresh non-descendant root,
		// then GCs. The live tip never moves, so the count must stay pinned at
		// cycle 1's reachable-set size.
		const countsPerCycle: number[] = [countAfter1]
		for (let k = 2; k <= K; k++) {
			await pushDenied(fx, repo, { content: `cycle ${k}\n` })
			await fx.gc.gc(repo, { graceSeconds: 0 })
			const count = await countObjects(fx.db, repo)
			// Each cycle's survivors == the LIVE tip closure (no orphan accretion).
			expect(await objectOids(fx.db, repo)).toEqual([...c1.reachable].sort())
			expect(count).toBe(reachable1)
			countsPerCycle.push(count)
		}
		// The bound: count after cycle K == count after cycle 1 (flat in K). If GC
		// failed to reclaim orphans this would be ≈ K * reachable1.
		expect(countsPerCycle[K - 1]).toBe(countAfter1)
		expect(Math.max(...countsPerCycle)).toBe(countAfter1)
		// Guard against a degenerate "all collapsed to 0" pass: there IS a real tree.
		expect(countAfter1).toBeGreaterThan(0)
	})

	// FC-1 (re-oriented) — Non-ff DENIED even on a CAS match. Pre-2026-07-05 a
	// `push --force` whose advertised old OID equaled the current tip was
	// accepted; the deny-non-FF policy now ng's it regardless. The ref keeps its
	// history, a clone yields the ORIGINAL content, and the denied pack's objects
	// sit in Postgres as GC food (pinned so the ingest-before-policy order is
	// caught if it regresses).
	it("FC-1 — non-ff push denied despite a matching CAS; clone yields the original tip's tree", async () => {
		const repo = "fc1-nonff"

		const first = await pushFile(fx, repo, { content: "alpha\n" })
		const denied = await pushDenied(fx, repo, { content: "beta\n" })
		expect(denied.head).not.toBe(first.head)

		// The ref never moved and a clone is fsck-clean with the ORIGINAL content.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(first.head)
		expect(clone.fileContent).toBe("alpha\n")

		// The denied pack was ingested (protocol order): its objects are present,
		// unreachable, awaiting GC.
		const oids = await objectOids(fx.db, repo)
		for (const oid of denied.reachable) expect(oids).toContain(oid)
	})

	// FC-2 — Stale push rejected at the STORE's CAS (unchanged by the policy: the
	// CAS keeps guarding concurrency; the FF policy lives a layer above in
	// receive-pack). A ref update whose advertised old OID != the current tip is
	// rejected, leaving the ref unchanged. Stock `git push` auto-fetches and
	// rewrites its `--force-with-lease` to the live tip, so a wire push can never
	// advertise a stale old OID; the condition is driven directly through the
	// store (`refs.applyRefUpdates`) with a deliberately wrong `oldOid`.
	it("FC-2 — ref update with a wrong advertised old OID is rejected; ref unchanged", async () => {
		const repo = "fc2-stale"

		// Establish `main`, then land a real, store-resident non-descendant commit
		// to use as the would-be new tip — the denied push ingests it (so the only
		// reason the update below fails is the wrong old OID, not a missing newOid
		// object) while leaving `main` at the established tip.
		const established = await pushFile(fx, repo, { content: "real tip\n" })
		const candidate = await pushDenied(fx, repo, {
			content: "would-be next tip\n",
		})

		// A well-formed but WRONG old OID: non-zero (so it is classified as an
		// `update`, hitting the CAS `WHERE oid = oldOid`), not all-zeros (that would be
		// a create), and != the current tip. The update advertises a valid, present
		// `newOid` (candidate.head) — so the ONLY reason it is refused is the CAS
		// mismatch on the stale old OID.
		const wrongOldOid = "1111111111111111111111111111111111111111"
		expect(wrongOldOid).not.toBe(established.head)
		const rejected = await fx.refs.applyRefUpdates(
			repo,
			[{ newOid: candidate.head, oldOid: wrongOldOid, ref: "refs/heads/main" }],
			false,
		)
		expect(rejected).toEqual([false])

		// The ref is unchanged — both via the store's own view and a real clone.
		const refs = await fx.refs.listRefs(repo)
		expect(refs).toContainEqual({ name: "refs/heads/main", oid: established.head })
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(established.head)
		expect(clone.fileContent).toBe("real tip\n")
	})
})

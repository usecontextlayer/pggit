import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	cloneAndFsck,
	countObjects,
	type GcFixture,
	objectOids,
	pushFile,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"

/**
 * Force-commit reclamation + force-commit contract
 * (`docs/2026-06-24-force-commit-gc-design.md` §4: GC-4, FC-1, FC-2).
 *
 * The §1 workload force-commits a snapshot ref each turn (the ref moves to a
 * NON-descendant commit), orphaning the prior commit/tree/blob objects; GC then
 * reclaims the orphans once they age past `grace`, so steady-state storage tracks
 * the CURRENT reachable tree rather than growing with the commit count.
 *
 * OBSERVABLE-ONLY: assertions read the real `git` oracle (clone/fetch/fsck/
 * rev-list), Postgres rows (`git_object` via the helpers), and the `gc()` return
 * value — never GC internals (temp tables, batch counts, CTE/txn shape). Grace is
 * made deterministic by pushing `graceSeconds: 0` (reclaim all unreachable) against
 * freshly-pushed-but-orphaned objects — no wall-clock sleep, no `ageObjects` needed
 * because the orphans are already older than a zero grace.
 *
 * RED now: `createGc().gc()` throws "not implemented (TDD stub)", so every `it`
 * that calls `gc()` fails for exactly that reason; FC-1/FC-2 exercise the
 * force-commit CAS path that already exists, so they pin pre-GC behaviour.
 */
describe("GC force-commit — reclamation, bound, and CAS contract (§4 GC-4/FC-1/FC-2)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	// GC-4 (orphan reclamation): a force-commit moves `main` to a non-descendant
	// commit; the prior commit + tree + unique blob become unreachable. With
	// `graceSeconds: 0` (reclaim all unreachable) GC must delete exactly those
	// orphans and keep exactly the new tip's closure — proved against the real-git
	// reachable closure (the independent survivor oracle) and a clean clone.
	it("GC-4 — force-commit orphans (old commit/tree/blob) are gone after GC; new tip survives", async () => {
		const repo = "gc4-orphans"

		// First push establishes the ref; second push force-commits to an
		// independent (non-descendant) root commit, orphaning the first tip's
		// objects. Distinct content ⇒ distinct blob/tree/commit OIDs on each side.
		const first = await pushFile(fx, repo, { content: "turn-1 transcript\n" })
		const second = await pushFile(fx, repo, {
			content: "turn-2 transcript\n",
			force: true,
		})

		// Sanity: the force-commit produced a genuinely different, non-descendant
		// tip, so the first tip's objects are now orphaned (none shared but for any
		// incidental collision — here none, distinct content).
		expect(second.head).not.toBe(first.head)
		const orphaned = first.reachable.filter((oid) => !second.reachable.includes(oid))
		expect(orphaned.length).toBeGreaterThan(0)

		// Before GC: Postgres still holds BOTH closures (force-commit only moved the
		// ref; nothing was reclaimed yet).
		const before = await objectOids(fx.db, repo)
		for (const oid of orphaned) expect(before).toContain(oid)

		// GC with zero grace: reclaim every unreachable object. The orphans are a
		// LOWER bound on what GC reclaims, not an exact count — a re-impl that also
		// reaped some other unreachable artifact (e.g. an extra empty tree) is still
		// correct. The exact reclamation invariant is pinned by the survivor-set
		// equality below (`after == second.reachable`), which fixes BOTH no-under-
		// delete (every live oid present) and no-over-delete (nothing live removed).
		const result = await fx.gc.gc(repo, { graceSeconds: 0 })
		expect(result.deletedObjects).toBeGreaterThanOrEqual(orphaned.length)

		// After GC: the orphaned objects are absent; the current tip's closure
		// remains; Postgres survivors == the real-git reachable closure of the
		// current tip (neither over- nor under-deletes).
		const after = await objectOids(fx.db, repo)
		for (const oid of orphaned) expect(after).not.toContain(oid)
		for (const oid of second.reachable) expect(after).toContain(oid)
		expect(after).toEqual([...second.reachable].sort())

		// And the repo still clones clean to the NEW tip's content.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(second.head)
		expect(clone.fileContent).toBe("turn-2 transcript\n")
	})

	// GC-4 (storage bound): K amend-then-GC cycles with `graceSeconds: 0` must NOT
	// grow `git_object` with K. After every cycle the row count returns to the
	// current reachable-set size (a single-file commit = 3 objects: commit, tree,
	// blob), so the count after cycle K equals the count after cycle 1 — flat in K,
	// not K-proportional.
	it("GC-4 — K amend-then-GC cycles keep git_object ≈ current reachable set (no growth in K)", async () => {
		const repo = "gc4-bound"
		const K = 6

		// Cycle 1: establish the ref, then GC. (First push needs no force.)
		const c1 = await pushFile(fx, repo, { content: "cycle 1\n" })
		await fx.gc.gc(repo, { graceSeconds: 0 })
		const countAfter1 = await countObjects(fx.db, repo)
		const reachable1 = c1.reachable.length

		// Steady state after a single-file commit + zero-grace GC == its closure.
		expect(countAfter1).toBe(reachable1)

		// Cycles 2..K: each force-commits a fresh non-descendant root (orphaning the
		// prior tip) then GCs. The count must stay pinned at the reachable-set size.
		const countsPerCycle: number[] = [countAfter1]
		for (let k = 2; k <= K; k++) {
			const ck = await pushFile(fx, repo, { content: `cycle ${k}\n`, force: true })
			await fx.gc.gc(repo, { graceSeconds: 0 })
			const count = await countObjects(fx.db, repo)
			// Each cycle's survivors == that cycle's tip closure (no orphan accretion).
			expect(await objectOids(fx.db, repo)).toEqual([...ck.reachable].sort())
			expect(count).toBe(ck.reachable.length)
			countsPerCycle.push(count)
		}

		// The bound: count after cycle K == count after cycle 1 (flat in K). If GC
		// failed to reclaim orphans this would be ≈ K * reachable1.
		expect(countsPerCycle[K - 1]).toBe(countAfter1)
		expect(Math.max(...countsPerCycle)).toBe(countAfter1)
		// Guard against a degenerate "all collapsed to 0" pass: there IS a real tree.
		expect(countAfter1).toBeGreaterThan(0)
	})

	// FC-1 — Non-ff accepted on CAS match. A `push --force` whose advertised old OID
	// equals the current tip moves `main` to a non-descendant commit and succeeds; a
	// clone afterwards yields the NEW tip's tree. (This is the force-commit half that
	// already exists — pinned so a regression is caught; independent of GC.)
	it("FC-1 — non-ff push accepted on CAS match; clone yields the new tip's tree", async () => {
		const repo = "fc1-nonff"

		const first = await pushFile(fx, repo, { content: "alpha\n" })
		// `push --force` from an independent repo: a fresh root, non-descendant of
		// `first.head`. pggit's ref CAS matches on the advertised old OID (the current
		// tip) and accepts the non-ff move (refs-store has no ancestry check).
		const second = await pushFile(fx, repo, { content: "beta\n", force: true })
		expect(second.head).not.toBe(first.head)

		// The ref advanced to the new (non-descendant) tip and a clone is fsck-clean
		// with the NEW content — proving the non-ff update was applied, not refused.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(second.head)
		expect(clone.fileContent).toBe("beta\n")

		// Postgres holds the new tip's closure (the wire-visible survivor set is at
		// least the reachable closure of the accepted tip).
		const oids = await objectOids(fx.db, repo)
		for (const oid of second.reachable) expect(oids).toContain(oid)
	})

	// FC-2 — Stale push rejected. A ref update whose advertised old OID != the
	// current tip is rejected by CAS, leaving the ref unchanged. Stock `git push`
	// auto-fetches and rewrites its `--force-with-lease` to the live tip, so a wire
	// push can never advertise a stale old OID; the condition is driven directly
	// through the receive-pack backend (`refs.applyRefUpdates`) with a deliberately
	// wrong `oldOid` (per the §4 FC-2 note). The CAS hits `WHERE oid = oldOid`,
	// matches no row, so the per-command flag is `false` and `main` is untouched.
	it("FC-2 — ref update with a wrong advertised old OID is rejected; ref unchanged", async () => {
		const repo = "fc2-stale"

		// Establish `main`, then capture a real, store-resident second commit oid to
		// use as the would-be new tip (so the only reason the update fails is the
		// wrong old OID, not a missing newOid object).
		const established = await pushFile(fx, repo, { content: "real tip\n" })
		const candidate = await pushFile(fx, repo, {
			content: "would-be next tip\n",
			force: true,
		})

		// Reset `main` back to the established tip via a CORRECT CAS, so the stale-OID
		// case below starts from a known current tip (`established.head`).
		const reset = await fx.refs.applyRefUpdates(
			repo,
			[{ newOid: established.head, oldOid: candidate.head, ref: "refs/heads/main" }],
			false,
		)
		expect(reset).toEqual([true])

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

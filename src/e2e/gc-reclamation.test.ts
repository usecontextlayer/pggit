import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	ageObjects,
	cloneAndFsck,
	edgeRows,
	type GcFixture,
	gitReachableOids,
	objectOids,
	pushFile,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
	withTempDir,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"

/**
 * GC reclamation & grace — `docs/2026-06-24-force-commit-gc-design.md` §4,
 * items GC-1 (liveness preserved), GC-2 (unreachable reclaimed), and GC-3
 * (grace protects recent).
 *
 * OBSERVABLE-ONLY: every assertion is on the real `git` oracle
 * (clone/fetch/fsck/rev-list), Postgres rows (`git_object`/`git_edge` via
 * `db.sql`), or the `gc()` return value. Nothing here probes GC internals
 * (temp tables, batch counts, CTE/transaction shape) — those stay free to
 * change. Grace is made deterministic by controlling `graceSeconds` and
 * `created_at` (`ageObjects`), never by sleeping on the wall clock.
 *
 * RED now: `createGc` is a throwing stub, so every `gc()` call rejects with
 * "pggit gc: not implemented (TDD stub)". GREEN once GC honours the §4 contract.
 */
describe("GC reclamation & grace (§4: GC-1, GC-2, GC-3)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	/**
	 * The reachable closure (sorted hex OIDs) of `repo`'s current `refs/heads/main`
	 * tip, computed by the real-git oracle from a throwaway fetch of that ref —
	 * independent of any `pushFile` return value. The expected-survivors oracle for
	 * GC-1 (it includes peeled tag targets via `gitReachableOids`).
	 */
	async function reachableOfTip(repo: string): Promise<string[]> {
		return withTempDir("pggit-gc-tip-", async (dir) => {
			await spawnGit(["init", "-q"], { cwd: dir })
			await spawnGit(
				["-c", "protocol.version=2", "fetch", repoUrl(fx, repo), "refs/heads/main"],
				{ cwd: dir },
			)
			// Point a local ref at the fetched tip so `rev-list --all` walks it.
			await spawnGit(["update-ref", "refs/heads/main", "FETCH_HEAD"], { cwd: dir })
			return gitReachableOids(dir)
		})
	}

	// GC-1 — Liveness preserved. After a force-commit orphans the old tip, GC with
	// grace=0 still keeps every object reachable from the CURRENT ref tip (incl.
	// peeled targets); a full clone after GC is byte-identical reachable content
	// and `git fsck --full` passes.
	it("GC-1: keeps the live closure and clones byte-identical + fsck-clean after GC", async () => {
		const repo = "gc1-liveness"

		// Initial push, then a force-commit that orphans the original tip's objects.
		await pushFile(fx, repo, { content: "first revision\n" })
		await pushFile(fx, repo, { content: "second revision\n", force: true })

		// Live survivor oracle: real-git reachable closure of the current tip.
		const liveOids = await reachableOfTip(repo)
		const cloneBefore = await cloneAndFsck(fx, repo)

		// Age everything so grace=0 is free to reclaim the orphans (not the live set).
		await ageObjects(fx.db, repo, "1 hour")
		await fx.gc.gc(repo, { graceSeconds: 0 })

		// Every live object is still present in Postgres. GC-1 only pins that nothing
		// live is lost (a superset is allowed here; GC-2 pins that orphans are gone).
		const survivors = new Set(await objectOids(fx.db, repo))
		for (const oid of liveOids) expect(survivors.has(oid)).toBe(true)

		// The clone after GC is identical to the clone before: same tip, same fetched
		// object set, same file content, and fsck still passes (`cloneAndFsck` throws
		// otherwise).
		const cloneAfter = await cloneAndFsck(fx, repo)
		expect(cloneAfter.head).toBe(cloneBefore.head)
		expect(cloneAfter.objects).toEqual(cloneBefore.objects)
		expect(cloneAfter.fileContent).toBe("second revision\n")
	})

	// GC-2 — Unreachable reclaimed. An object unreachable from all refs AND older
	// than grace is absent from `git_object` after GC, and its `git_edge` rows are
	// gone (no FK cascade — edges of deleted objects must be swept too).
	it("GC-2: removes orphaned objects and their edges after a force-commit (grace=0, aged)", async () => {
		const repo = "gc2-reclaim"

		// Push c1, capture its reachable closure, then force-commit c2 (independent
		// root → distinct commit/tree/blob) so c1's objects are orphaned.
		const r1 = await pushFile(fx, repo, { content: "old transcript\n" })
		const r2 = await pushFile(fx, repo, { content: "new transcript\n", force: true })
		expect(r2.head).not.toBe(r1.head)

		// Orphaned = reachable-from-c1 minus reachable-from-c2 (distinct content ⇒
		// disjoint closures, but compute the difference rather than assume it).
		const liveSet = new Set(r2.reachable)
		const orphaned = r1.reachable.filter((oid) => !liveSet.has(oid))
		expect(orphaned.length).toBeGreaterThan(0)

		// Age every object past the grace cutoff, then reclaim with grace=0.
		await ageObjects(fx.db, repo, "1 hour")
		const result = await fx.gc.gc(repo, { graceSeconds: 0 })
		expect(result.deletedObjects).toBeGreaterThanOrEqual(orphaned.length)

		// No orphaned object survives in `git_object`.
		const survivors = new Set(await objectOids(fx.db, repo))
		for (const oid of orphaned) expect(survivors.has(oid)).toBe(false)

		// No surviving edge references an orphaned object as parent or child.
		const orphanSet = new Set(orphaned)
		for (const edge of await edgeRows(fx.db, repo)) {
			expect(orphanSet.has(edge.parent)).toBe(false)
			expect(orphanSet.has(edge.child)).toBe(false)
		}

		// The repo still clones clean to the live tip.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(r2.head)
		expect(clone.fileContent).toBe("new transcript\n")
	})

	// GC-3 — Grace protects recent. An unreachable object YOUNGER than grace is
	// retained; the SAME object is reclaimed once grace is 0. Probed by flipping
	// only `graceSeconds` (huge → retains, 0 → reclaims) on freshly-created
	// (un-aged) rows — no wall-clock sleep.
	it("GC-3: a huge grace retains young orphans, grace=0 then reclaims them", async () => {
		const repo = "gc3-grace"

		const r1 = await pushFile(fx, repo, { content: "young v1\n" })
		const r2 = await pushFile(fx, repo, { content: "young v2\n", force: true })

		const liveSet = new Set(r2.reachable)
		const orphaned = r1.reachable.filter((oid) => !liveSet.has(oid))
		expect(orphaned.length).toBeGreaterThan(0)
		const expectedFlip = [...orphaned].sort()

		// Rows are freshly created (un-aged), so they are younger than any large
		// grace. A huge grace must retain every orphan and reclaim nothing.
		const huge = await fx.gc.gc(repo, { graceSeconds: 365 * 24 * 60 * 60 })
		expect(huge.deletedObjects).toBe(0)
		const afterHuge = new Set(await objectOids(fx.db, repo))
		for (const oid of orphaned) expect(afterHuge.has(oid)).toBe(true)

		// Same orphans, same age — only grace changes. Grace=0 now reclaims them.
		const zero = await fx.gc.gc(repo, { graceSeconds: 0 })
		expect(zero.deletedObjects).toBeGreaterThanOrEqual(orphaned.length)
		const afterZero = new Set(await objectOids(fx.db, repo))
		for (const oid of orphaned) expect(afterZero.has(oid)).toBe(false)

		// The presence of every orphan flipped purely on `graceSeconds`.
		const flipped = orphaned
			.filter((oid) => afterHuge.has(oid) && !afterZero.has(oid))
			.sort()
		expect(flipped).toEqual(expectedFlip)

		// And the live tip still clones clean after the reclaiming run.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(r2.head)
		expect(clone.fileContent).toBe("young v2\n")
	})

	// GC-3 (boundary) — Grace is compared against `created_at` AGE, not merely
	// "graceSeconds === 0". This pins the actual cutoff `created_at < clock() -
	// grace` by AGEING the orphans to ~now-1h and straddling that age with two
	// NON-ZERO graces: a 2h grace (cutoff now-2h) keeps the now-1h orphans (newer
	// than cutoff → retained); a 30m grace (cutoff now-30m) reclaims them (older
	// than cutoff → reclaimed). A grace==0-only impl would wrongly RETAIN at
	// graceSeconds:1800 and fail. Generous ±30m margins keep it non-flaky.
	it("GC-3: grace is compared against created_at age (boundary straddle)", async () => {
		const repo = "gc3-boundary"

		// Push c1, force-commit c2 (independent root → disjoint closure) so c1's
		// objects are orphaned. Orphaned = reachable(c1) \ reachable(c2).
		const r1 = await pushFile(fx, repo, { content: "boundary v1\n" })
		const r2 = await pushFile(fx, repo, { content: "boundary v2\n", force: true })
		const liveSet = new Set(r2.reachable)
		const orphaned = r1.reachable.filter((oid) => !liveSet.has(oid))
		expect(orphaned.length).toBeGreaterThan(0)

		// Age EVERY row by 1h: orphans now have created_at ~= now - 1h.
		await ageObjects(fx.db, repo, "3600 seconds")

		// grace=7200s → cutoff = now - 2h. Orphan age (~1h) is NEWER than the cutoff
		// → RETAINED. Nothing reclaimed, every orphan still present.
		const retained = await fx.gc.gc(repo, { graceSeconds: 7200 })
		expect(retained.deletedObjects).toBe(0)
		const afterRetain = new Set(await objectOids(fx.db, repo))
		for (const oid of orphaned) expect(afterRetain.has(oid)).toBe(true)

		// grace=1800s → cutoff = now - 30m. Orphan age (~1h) is OLDER than the cutoff
		// → RECLAIMED. A grace==0-only impl would still retain here.
		const reclaimed = await fx.gc.gc(repo, { graceSeconds: 1800 })
		expect(reclaimed.deletedObjects).toBeGreaterThanOrEqual(orphaned.length)
		const afterReclaim = new Set(await objectOids(fx.db, repo))
		for (const oid of orphaned) expect(afterReclaim.has(oid)).toBe(false)

		// The live tip still clones clean after the reclaiming run.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(r2.head)
		expect(clone.fileContent).toBe("boundary v2\n")
	})
})

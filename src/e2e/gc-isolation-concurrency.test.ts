/**
 * GC isolation & concurrency — `docs/2026-06-24-force-commit-gc-design.md` §4,
 * items GC-8, GC-9, GC-10. OBSERVABLE-ONLY: every assertion is on real-`git`
 * behaviour (clone/fetch/fsck), Postgres rows (`git_object`/`git_edge` via the
 * scaffold's `objectOids`/`countObjects`/`edgeRows`/`countEdges`), or the `gc()`
 * return value. Nothing here probes GC internals (temp tables, batch/transaction
 * counts, advisory locks, CTE/SQL shape) — those stay free to change. Grace is
 * made deterministic with `graceSeconds` + `ageObjects`, never a wall-clock sleep.
 *
 * RED now: `createGc` is a throwing stub, so every `gc()` call rejects with
 * "pggit gc: not implemented (TDD stub)". GREEN once GC honours the §4 contract.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	ageObjects,
	cloneAndFsck,
	countEdges,
	countObjects,
	edgeRows,
	type GcFixture,
	objectOids,
	pushFile,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"

describe("GC isolation & concurrency (§4: GC-8, GC-9, GC-10)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	// GC-8 — Tenant isolation. GC on repo A never deletes any object/edge of repo
	// B. We push two repos that share NO content (distinct file paths + bodies →
	// disjoint blob/tree/commit oids), orphan A's old objects via a force-commit,
	// then GC only A with grace=0. Repo B must be byte-for-byte untouched: its
	// git_object / git_edge row counts and oid sets are unchanged, and a clone of
	// B is still complete + fsck-clean.
	it("GC-8: GC on repo A leaves repo B's objects, edges, and clone untouched", async () => {
		const repoA = "gc8-a"
		const repoB = "gc8-b"

		// Repo A: an initial commit, then a force-commit that orphans the first.
		await pushFile(fx, repoA, { content: "A-v1\n" })
		const aTip = await pushFile(fx, repoA, { content: "A-v2\n", force: true })

		// Repo B: independent content, never force-committed (nothing orphaned).
		const bTip = await pushFile(fx, repoB, { content: "totally-different-B\n" })

		// Snapshot B's full observable state before A's GC.
		const bObjectsBefore = await objectOids(fx.db, repoB)
		const bEdgeRowsBefore = await edgeRows(fx.db, repoB)
		const bCountObjectsBefore = await countObjects(fx.db, repoB)
		const bCountEdgesBefore = await countEdges(fx.db, repoB)
		// Sanity: the two repos genuinely share no objects (disjoint storage).
		expect(bObjectsBefore.some((oid) => aTip.reachable.includes(oid))).toBe(false)

		// Make A's orphaned objects eligible (older than grace), then GC ONLY A.
		await ageObjects(fx.db, repoA, "1 hour")
		const reclaimed = await fx.gc.gc(repoA, { graceSeconds: 0 })
		// A actually reclaimed something (otherwise isolation is vacuous).
		expect(reclaimed.deletedObjects).toBeGreaterThan(0)

		// B is completely unchanged across A's GC — rows, edges, counts identical.
		expect(await objectOids(fx.db, repoB)).toEqual(bObjectsBefore)
		expect(await edgeRows(fx.db, repoB)).toEqual(bEdgeRowsBefore)
		expect(await countObjects(fx.db, repoB)).toBe(bCountObjectsBefore)
		expect(await countEdges(fx.db, repoB)).toBe(bCountEdgesBefore)

		// And B still clones complete + fsck-clean, with its tip + content intact.
		const cloneB = await cloneAndFsck(fx, repoB)
		expect(cloneB.head).toBe(bTip.head)
		expect(cloneB.fileContent).toBe("totally-different-B\n")
	})

	// GC-9 — LIVENESS SMOKE TEST: a GC fired around a push does not corrupt the
	// live tip. We bracket a `pushFile` with a `gc(grace=0)` before AND after it,
	// then assert the pushed-and-referenced tip clones complete + fsck-clean and
	// every object of that tip survives in Postgres. We assert via the git oracle
	// + rows, NOT via the §5 REPEATABLE-READ / advisory-lock internals.
	//
	// This is DELIBERATELY only a smoke test, not an in-flight-safety proof. The
	// Promise.all interleave cannot establish §5's guarantee: `pushFile` spawns a
	// real `git` subprocess whose startup dwarfs the in-process GC SQL, and the
	// post-push GC reads refs AFTER the push has committed, over fresh (un-aged)
	// objects at grace=0 — so the live tip is never actually in-flight relative to
	// either sweep. An implementation with ZERO §5 isolation passes this test;
	// that is why GC-9 only claims liveness-around-a-push here.
	//
	// TODO(impl): the genuine in-flight safety property (§5 REPEATABLE-READ live
	// set + advisory-locked ref read) requires a GC pause-seam between the
	// live-set read and the sweep; write that deterministic race test during GC
	// implementation.
	it("GC-9: a GC fired around a push does not corrupt the live tip (liveness smoke test)", async () => {
		const repo = "gc9"

		// Seed an initial commit so the repo exists, then orphan it via force so
		// there is genuine garbage for the bracketing GC to chase.
		await pushFile(fx, repo, { content: "gc9-seed\n" })
		await ageObjects(fx.db, repo, "1 hour")

		// Bracket a fresh force-commit push with a GC before AND after it. The
		// push's new tip + its objects must survive both sweeps intact. (This is a
		// liveness smoke test — see the block comment above; it does NOT prove the
		// §5 in-flight isolation property.)
		const firstGc = fx.gc.gc(repo, { graceSeconds: 0 })
		const push = pushFile(fx, repo, { content: "gc9-inflight\n", force: true })
		const [, pushed] = await Promise.all([firstGc, push])
		await fx.gc.gc(repo, { graceSeconds: 0 })

		// The pushed ref clones complete + fsck-clean, at exactly the pushed tip.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(pushed.head)
		expect(clone.fileContent).toBe("gc9-inflight\n")

		// Every object the pushed tip reaches still exists in Postgres (no object
		// of the live tip was reclaimed by the concurrent/bracketing GC).
		const survivors = await objectOids(fx.db, repo)
		for (const oid of pushed.reachable) {
			expect(survivors).toContain(oid)
		}
	})

	// GC-10 — Batch invariance. GC with batchLimit:1 reaches the SAME final
	// observable state (surviving oid set + a clean clone) as a large batchLimit,
	// for the same starting scenario. We build two equivalent repos (same push
	// sequence ⇒ identical oids, since identity + clock are pinned), age both, then
	// GC one with batchLimit:1 and the other with a large batchLimit. Their
	// surviving git_object sets and their clones must match.
	it("GC-10: batchLimit:1 and a large batchLimit reach the same surviving state", async () => {
		const repoSmall = "gc10-small"
		const repoLarge = "gc10-large"

		// Identical push sequences → identical object graphs (pinned identity/clock).
		await pushFile(fx, repoSmall, { content: "gc10-v1\n" })
		const smallTip = await pushFile(fx, repoSmall, { content: "gc10-v2\n", force: true })
		await pushFile(fx, repoLarge, { content: "gc10-v1\n" })
		const largeTip = await pushFile(fx, repoLarge, { content: "gc10-v2\n", force: true })

		// Equivalent starting scenarios: same tip, same full stored object set.
		expect(largeTip.head).toBe(smallTip.head)
		expect(await objectOids(fx.db, repoLarge)).toEqual(await objectOids(fx.db, repoSmall))

		// Age both so their orphans are equally eligible under grace=0.
		await ageObjects(fx.db, repoSmall, "1 hour")
		await ageObjects(fx.db, repoLarge, "1 hour")

		// One row at a time vs a sweep that takes everything in one bite.
		await fx.gc.gc(repoSmall, { batchLimit: 1, graceSeconds: 0 })
		await fx.gc.gc(repoLarge, { batchLimit: 1_000_000, graceSeconds: 0 })

		// Final observable state is identical: same surviving git_object oid set...
		const survivorsSmall = await objectOids(fx.db, repoSmall)
		const survivorsLarge = await objectOids(fx.db, repoLarge)
		expect(survivorsSmall).toEqual(survivorsLarge)

		// ...and each clone is complete + fsck-clean at the same tip + content.
		const cloneSmall = await cloneAndFsck(fx, repoSmall)
		const cloneLarge = await cloneAndFsck(fx, repoLarge)
		expect(cloneSmall.head).toBe(smallTip.head)
		expect(cloneLarge.head).toBe(largeTip.head)
		expect(cloneSmall.fileContent).toBe("gc10-v2\n")
		expect(cloneLarge.fileContent).toBe("gc10-v2\n")
		expect(cloneSmall.objects).toEqual(cloneLarge.objects)

		// Cross-check both against the real-git survivor oracle (grace=0 ⇒ survivors
		// == the reachable closure of the live tip): both batch sizes converge there.
		// Anchor BOTH paths to the oracle independently (defense-in-depth) — without
		// the large-batch assertion its correctness rests only on transitive equality
		// with the small-batch set, so a bug shared by both paths could pass unseen.
		expect(survivorsSmall).toEqual([...smallTip.reachable].sort())
		expect(survivorsLarge).toEqual([...largeTip.reachable].sort())
	})
})

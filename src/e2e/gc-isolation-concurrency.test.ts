/**
 * GC isolation & concurrency — `docs/2026-06-24-force-commit-gc-design.md` §4,
 * items GC-8, GC-9, GC-10. OBSERVABLE-ONLY: every assertion is on real-`git`
 * behaviour (clone/fetch/fsck), Postgres rows (`git_object`/`git_edge` via the
 * scaffold's `objectOids`/`countObjects`/`edgeRows`/`countEdges`), or the `gc()`
 * return value. Nothing here probes GC internals (temp tables, batch/transaction
 * counts, advisory locks, CTE/SQL shape) — those stay free to change. Grace is
 * made deterministic with `graceSeconds` + `ageObjects`, never a wall-clock sleep.
 *
 * GC-9 is the one exception to "observable-only": it passes the GC's documented
 * internal test seam (`_hooks.afterLiveSet`, gc.ts) — the ONLY internal coupling
 * allowed here — to interpose a real push between the live-set snapshot and the
 * sweep, turning §5's in-flight race into a deterministic, non-flaky test. Every
 * ASSERTION is still observable-only (git oracle + Postgres rows + gc() return).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GcResult } from "@/store/gc"
import {
	ageObjects,
	cloneAndFsck,
	countEdges,
	countObjects,
	edgeRows,
	type GcFixture,
	objectOids,
	type PushResult,
	pushFile,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"

/**
 * GC-9's documented internal test seam (gc.ts `InternalGcOptions._hooks`): not
 * part of the public `GcOptions` contract, so the test states the exact shape it
 * relies on. `afterLiveSet` is awaited after the live set is materialized and
 * before the object sweep — the one point §5 in-flight safety hinges on. This is
 * the SOLE internal coupling in this file; every assertion stays observable-only.
 */
type GcWithSeam = (
	repo: string,
	opts: {
		graceSeconds: number
		batchLimit?: number
		_hooks: { afterLiveSet: () => Promise<void> }
	},
) => Promise<GcResult>

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

	// GC-9 — IN-FLIGHT PUSH SAFETY (the real §5 race, deterministic). The property:
	// an object a push sends AND references DURING a GC's window — after GC has
	// snapshotted the live set, before/while it sweeps — must NOT be reclaimed,
	// even though it is absent from that already-fixed live set. §5's defence here
	// is the `created_at` time-grace (the write-path advisory lock is deferred to
	// §5.4 and not yet wired), so a push's fresh objects, younger than `grace`, are
	// retained across a sweep that snapshotted before they existed.
	//
	// The smoke test this replaces could not prove that: a `Promise.all` interleave
	// is non-deterministic (the `git` subprocess startup dwarfs the in-process GC
	// SQL, so the push always committed before either sweep) — the live tip was
	// never actually in-flight relative to a sweep. We make the race deterministic
	// with the documented `_hooks.afterLiveSet` seam: it fires a REAL force-commit
	// push of a FRESH commit (new objects + ref move) at exactly the moment §5
	// cares about — after the live set is materialized, before the sweep runs.
	//
	// Construction (all three states present in ONE sweep):
	//   c1  pre-existing orphan  — unreachable BEFORE the GC (orphaned by c2's
	//                              force-push) AND aged past grace ⇒ MUST be reclaimed.
	//   c2  the live tip at snapshot — reachable, captured in the live set.
	//   c3  the in-flight push    — sent inside the window, young (just created),
	//                              unreachable-at-snapshot ⇒ MUST survive (grace).
	// Grace sits between the two ages (orphans aged 1h ≫ grace ≫ c3's ~0s age), so
	// the SAME sweep reclaims the old orphan and protects the young in-flight tip.
	//
	// Why this catches a no-isolation impl: an implementation that reclaims anything
	// unreachable-at-snapshot regardless of age would delete c3's objects (c3 is not
	// in the live set), and the clone of the pushed tip would fail `fsck` / fetch
	// ("not our ref"). Only the grace (or, later, the advisory lock) keeps c3 alive
	// — so this test fails any impl that drops the §5 in-flight defence, while the
	// reclaimed c1 proves the sweep genuinely ran (not a vacuous no-op).
	it("GC-9: an in-flight push's objects survive a concurrent GC sweep while pre-existing orphans are reclaimed", async () => {
		const repo = "gc9"

		// c1: seed. c2: force-commit that orphans c1 BEFORE any GC runs — so c1 is
		// unreachable at the live-set snapshot, the precondition for it to be swept.
		const c1 = await pushFile(fx, repo, { content: "gc9-c1\n" })
		const c2 = await pushFile(fx, repo, { content: "gc9-c2\n", force: true })

		// Age every stored object back 1h. c1's orphans now sit past the grace
		// (eligible); c2 is reachable-at-snapshot so the live set protects it
		// regardless of age. c3 is pushed AFTER this, so it stays young.
		await ageObjects(fx.db, repo, "1 hour")

		// Run GC with a grace that straddles the two ages: 30min < 1h orphan age,
		// but ≫ c3's ~0s age. The seam fires the in-flight force-commit push of c3
		// after the live set is fixed (which captured c2, not c3) and before the
		// sweep — the exact §5 window.
		let c3: PushResult | undefined
		const reclaimed = await (fx.gc.gc as GcWithSeam)(repo, {
			_hooks: {
				afterLiveSet: async () => {
					c3 = await pushFile(fx, repo, { content: "gc9-c3-inflight\n", force: true })
				},
			},
			graceSeconds: 1800,
		})
		if (!c3) throw new Error("afterLiveSet seam did not fire")

		// The sweep genuinely ran: c1's aged orphans were reclaimed (not a no-op).
		expect(reclaimed.deletedObjects).toBeGreaterThan(0)
		const survivors = await objectOids(fx.db, repo)
		for (const oid of c1.reachable) {
			if (c2.reachable.includes(oid) || c3.reachable.includes(oid)) continue
			expect(survivors).not.toContain(oid)
		}

		// The in-flight tip survives intact: every object c3 reaches is still in
		// Postgres, even though it was absent from the snapshotted live set.
		for (const oid of c3.reachable) {
			expect(survivors).toContain(oid)
		}

		// And the pushed ref clones complete + fsck-clean, at exactly the c3 tip —
		// the end-to-end git oracle that a no-isolation impl (which swept c3) fails.
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(c3.head)
		expect(clone.fileContent).toBe("gc9-c3-inflight\n")
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

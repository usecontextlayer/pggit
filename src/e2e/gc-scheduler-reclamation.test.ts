import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGcScheduler } from "@/gc-scheduler"
import {
	ageObjects,
	cloneAndFsck,
	countObjects,
	edgeRows,
	type GcFixture,
	gitReachableOids,
	objectOids,
	pushFile,
	repoGcState,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
	withTempDir,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"

/**
 * GC-scheduler end-to-end reclamation THROUGH the drain loop —
 * `docs/2026-06-24-gc-scheduler-design.md` §6, items SCH-6 (end-to-end
 * reclamation + storage bound through the loop; GC-2/GC-4 reached via the
 * scheduler) and SCH-7 (no-lost-garbage across a post-snapshot push; the durable
 * analog of the GC primitive's GC-9).
 *
 * These drive `createGcScheduler(...).drainOnce()` — NOT `gc()` directly — so the
 * reclamation is observed as the scheduler's eligible-set decision + GC effect,
 * exactly as the background drain runs it. Eligibility (§2) is the whole policy:
 * a repo is drained iff `last_pushed_at IS NOT NULL AND (last_gc_at IS NULL OR
 * last_pushed_at > last_gc_at)`; a pass stamps each eligible repo's `last_gc_at`
 * to the pass start time, so a push landing after the stamp re-qualifies it.
 *
 * OBSERVABLE-ONLY: every assertion reads (a) the real `git` oracle
 * (fetch/clone/fsck/rev-list via `gitReachableOids`/`cloneAndFsck`), (b) Postgres
 * rows (`git_object` via `objectOids`/`countObjects`, the two scheduling columns
 * via `repoGcState`), or (c) the `DrainSummary` return value. Nothing here probes
 * scheduler internals (timer mechanics, the candidate SQL, concurrency
 * choreography, temp-table/txn shape) — those stay free to change. Grace is made
 * deterministic by constructing the scheduler with `graceSeconds: 0` and ageing
 * the orphans past the cutoff with `ageObjects`, never by sleeping on the wall
 * clock.
 *
 * RED now because `createGcScheduler` is a TDD stub: `drainOnce()` throws "pggit
 * gc-scheduler: not implemented (TDD stub)", and the store does not yet stamp
 * `repos.last_pushed_at`, so a pushed repo never becomes eligible. GREEN once the
 * store stamps `last_pushed_at` per push and `drainOnce()` drains the eligible set
 * per §6 (these tests assert that intended behaviour, not the stub's throw).
 */
describe("GC scheduler — end-to-end reclamation through drainOnce (§6: SCH-6, SCH-7)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	/**
	 * The real-git reachable closure (sorted hex OIDs) of `repo`'s current
	 * `refs/heads/main` tip, computed from a throwaway fetch — independent of any
	 * `pushFile` return value, so it remains a valid survivor oracle even after the
	 * scheduler mutates Postgres. (Mirrors the `reachableOfTip` oracle the GC
	 * primitive suite uses for GC-1/GC-2.)
	 */
	async function reachableOfTip(repo: string): Promise<string[]> {
		return withTempDir("pggit-sch-tip-", async (dir) => {
			await spawnGit(["init", "-q"], { cwd: dir })
			await spawnGit(
				["-c", "protocol.version=2", "fetch", repoUrl(fx, repo), "refs/heads/main"],
				{ cwd: dir },
			)
			await spawnGit(["update-ref", "refs/heads/main", "FETCH_HEAD"], { cwd: dir })
			return gitReachableOids(dir)
		})
	}

	// SCH-6 — End-to-end reclamation + storage bound THROUGH the loop. A push then a
	// force-commit orphans the prior tip; after ageing the orphans past the cutoff,
	// ONE `drainOnce()` (grace=0) must reduce the repo's surviving `git_object` to
	// exactly the current tip's real-git reachable closure (no orphan survives, no
	// live object lost), and the repo must clone fsck-clean at the latest content.
	// Then over K force-commit + age + drain cycles the row count stays pinned at the
	// single-tip reachable size — it does NOT grow with K. This is GC-2/GC-4 reached
	// through the scheduler: a stub `drainOnce` (throws) fails immediately; a drain
	// that never judged the repo eligible (no `last_pushed_at` stamp) would leave the
	// orphans in place and the survivor-equality / flat-count assertions would fail;
	// an over-deleting drain would drop a live object and break the clone.
	it("SCH-6 — drainOnce reduces git_object to the live closure and stays flat over K force-commit cycles", async () => {
		const repo = "sch6-loop-reclaim"
		const scheduler = createGcScheduler(fx.db.sql, {
			concurrency: 4,
			graceSeconds: 0,
			intervalMs: 30_000,
		})

		// Establish the ref, then force-commit an independent root → the first tip's
		// commit/tree/blob are orphaned (distinct content ⇒ disjoint closures).
		const first = await pushFile(fx, repo, { content: "turn-1 transcript\n" })
		const second = await pushFile(fx, repo, {
			content: "turn-2 transcript\n",
			force: true,
		})
		expect(second.head).not.toBe(first.head)

		// Independent survivor oracle: the current tip's real-git reachable closure.
		const liveOids = await reachableOfTip(repo)
		const orphaned = first.reachable.filter((oid) => !second.reachable.includes(oid))
		expect(orphaned.length).toBeGreaterThan(0)

		// Age every object past the grace=0 cutoff, then run ONE drain pass.
		await ageObjects(fx.db, repo, "1 hour")
		const summary = await scheduler.drainOnce()

		// The repo was judged eligible (it was pushed, never GC'd) → it appears in the
		// pass summary exactly once. The eligible SET is observable via the summary.
		expect(summary.filter((entry) => entry.repo === repo)).toHaveLength(1)

		// The DrainSummary's reclaim counts are REAL, not zeros: this pass deleted
		// exactly the orphaned objects (no more, no fewer) plus at least one of their
		// edges, surfaced per-repo. An impl that reclaims but reports {deletedObjects:0,
		// deletedEdges:0} — or miscounts — is caught here (the rest of the suite only
		// ever reads entry.repo, so this is the sole guard on the count surface).
		const entry = summary.find((e) => e.repo === repo)
		expect(entry?.deletedObjects).toBe(orphaned.length)
		expect(entry?.deletedEdges ?? 0).toBeGreaterThan(0)

		// Survivors == the current tip's reachable closure: nothing live lost AND no
		// orphan survives. Equality fixes both directions at once.
		const after = await objectOids(fx.db, repo)
		expect(after).toEqual([...liveOids].sort())
		for (const oid of orphaned) expect(after).not.toContain(oid)

		// Edge integrity through the loop (GC-5 reached via the scheduler): no surviving
		// edge references an orphaned object as parent or child (orphan edges were swept).
		const orphanSet = new Set(orphaned)
		for (const edge of await edgeRows(fx.db, repo)) {
			expect(orphanSet.has(edge.parent)).toBe(false)
			expect(orphanSet.has(edge.child)).toBe(false)
		}

		// The repo clones fsck-clean at the latest content (real-git oracle).
		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(second.head)
		expect(clone.fileContent).toBe("turn-2 transcript\n")

		// Storage bound through the loop: K force-commit + age + drain cycles must NOT
		// grow `git_object` with K. After each cycle the count returns to that cycle's
		// single-tip closure size, so the count after cycle K equals the count now.
		const boundAfterFirstDrain = await countObjects(fx.db, repo)
		expect(boundAfterFirstDrain).toBe(liveOids.length)
		expect(boundAfterFirstDrain).toBeGreaterThan(0)

		const K = 5
		const counts: number[] = [boundAfterFirstDrain]
		for (let k = 1; k <= K; k++) {
			const ck = await pushFile(fx, repo, { content: `turn-extra-${k}\n`, force: true })
			await ageObjects(fx.db, repo, "1 hour")
			await scheduler.drainOnce()
			// Each cycle's survivors == that cycle's tip closure (no orphan accretion).
			expect(await objectOids(fx.db, repo)).toEqual([...ck.reachable].sort())
			counts.push(await countObjects(fx.db, repo))
		}

		// Flat in K: every cycle's count equals the first drain's count. If the loop
		// failed to reclaim orphans this would climb to ≈ K × the closure size.
		expect(Math.max(...counts)).toBe(boundAfterFirstDrain)
		expect(counts[counts.length - 1]).toBe(boundAfterFirstDrain)
	})

	// SCH-7 — No-lost-garbage across a post-snapshot push (the DURABLE analog of the
	// GC primitive's GC-9). The precise mid-pass interleave — a push that lands
	// inside a single drain's GC window — is covered deterministically by GC-9 in
	// `gc-isolation-concurrency.test.ts` (the gc.ts `_hooks.afterLiveSet` seam); you
	// cannot interpose inside one `drainOnce()` from the outside. Here we assert the
	// DURABLE re-trigger that makes that safe at the scheduler layer: a push landing
	// AFTER a drain stamped `last_gc_at = t0` re-stamps `last_pushed_at > t0`, so the
	// repo is eligible AGAIN, and the NEXT drain reclaims the NEW orphans. Asserted
	// via two sequential push/drain rounds: a stub `drainOnce` (throws) fails at
	// round 1; a drain that forgot to advance `last_gc_at` (so the repo never settles)
	// or one whose eligibility ignored the re-stamp (so the new orphans are never
	// re-GC'd) is caught by the round-2 summary membership + the new-orphans-gone
	// survivor check.
	it("SCH-7 — a push after a drain re-qualifies the repo; the next drain reclaims the new orphans", async () => {
		const repo = "sch7-retrigger"
		const scheduler = createGcScheduler(fx.db.sql, {
			concurrency: 4,
			graceSeconds: 0,
			intervalMs: 30_000,
		})

		// Round 1: seed, force-commit (orphans the seed), age, drain. This stamps
		// `last_gc_at = t0` for the repo and reclaims round-1's orphans.
		await pushFile(fx, repo, { content: "round1-a\n" })
		const r1Tip = await pushFile(fx, repo, { content: "round1-b\n", force: true })
		await ageObjects(fx.db, repo, "1 hour")
		const summary1 = await scheduler.drainOnce()
		expect(summary1.filter((entry) => entry.repo === repo)).toHaveLength(1)

		// After the drain the repo is SETTLED: `last_gc_at` is set (the pass advanced
		// it) and is at/after `last_pushed_at`, so a follow-up drain with no new push
		// would NOT re-include it. This is the precondition for the re-trigger to be
		// meaningful (otherwise the repo would always be eligible).
		const settled = await repoGcState(fx.db, repo)
		expect(settled.lastGcAt).not.toBeNull()
		expect(settled.lastPushedAt).not.toBeNull()

		// A NEW force push AFTER that stamp orphans round-1's tip and re-stamps
		// `last_pushed_at`. The durable signal must now strictly exceed the prior GC
		// stamp — this is exactly what makes the repo re-qualify (the SCH-7 property).
		const r2Tip = await pushFile(fx, repo, { content: "round2\n", force: true })
		expect(r2Tip.head).not.toBe(r1Tip.head)
		const reStamped = await repoGcState(fx.db, repo)
		const gcAt = settled.lastGcAt as Date
		const pushedAt = reStamped.lastPushedAt as Date
		expect(pushedAt.getTime()).toBeGreaterThan(gcAt.getTime())

		// The NEW orphans (round-1's tip closure, now unreachable from round-2's tip)
		// are still in Postgres before the second drain — the drain must remove them.
		const newOrphans = r1Tip.reachable.filter((oid) => !r2Tip.reachable.includes(oid))
		expect(newOrphans.length).toBeGreaterThan(0)
		const beforeSecondDrain = await objectOids(fx.db, repo)
		for (const oid of newOrphans) expect(beforeSecondDrain).toContain(oid)

		// Round 2: age the new orphans past the cutoff, then drain again. The repo IS
		// in this pass's summary (re-qualified by the re-stamp), and afterwards its new
		// orphans are gone with the clone complete + fsck-clean at round-2's tip.
		await ageObjects(fx.db, repo, "1 hour")
		const summary2 = await scheduler.drainOnce()
		expect(summary2.filter((entry) => entry.repo === repo)).toHaveLength(1)

		const liveOids = await reachableOfTip(repo)
		const after = await objectOids(fx.db, repo)
		expect(after).toEqual([...liveOids].sort())
		for (const oid of newOrphans) expect(after).not.toContain(oid)

		const clone = await cloneAndFsck(fx, repo)
		expect(clone.head).toBe(r2Tip.head)
		expect(clone.fileContent).toBe("round2\n")
	})

	// §3 (ingest path) — a push that INGESTS objects but applies NO ref still stamps
	// activity, so its now-unreferenced orphans become GC-eligible and a drain reclaims
	// them. This is the connectivity-rejected push: receive-pack ingests the pack BEFORE
	// the connectivity check, so on rejection the objects + the `last_pushed_at` stamp
	// are already committed while no ref points at them. The design §3/§9 names this as
	// the reason `insertObjects` must stamp — a refactor that stamped only on the ref
	// path (or checked connectivity before ingest) would silently orphan these forever.
	// Driven at the store boundary (`putPack` ingests objects with no ref) — the exact
	// post-ingest state of a rejected push, asserted purely on Postgres rows + the
	// DrainSummary.
	it("§3 — ingested-but-unreferenced objects stamp activity and a drain reclaims them", async () => {
		const repo = "sch-orphan-ingest"
		const scheduler = createGcScheduler(fx.db.sql, {
			concurrency: 4,
			graceSeconds: 0,
			intervalMs: 30_000,
		})

		// A loose blob with no ref pointing at it — the residue of a connectivity-
		// rejected push (objects committed, ref rejected).
		const { oids } = await fx.objects.putPack(repo, [
			{ content: Buffer.from("orphan ingest\n"), type: "blob" },
		])
		expect(oids).toHaveLength(1)
		const orphan = oids[0] as string

		// The ingest stamped activity, so the repo is GC-eligible despite having no ref.
		expect((await repoGcState(fx.db, repo)).lastPushedAt).not.toBeNull()
		expect(await objectOids(fx.db, repo)).toContain(orphan)

		// Aged + drained: the unreferenced object is reclaimed (unreachable from every
		// ref), and the repo is reported in the pass summary.
		await ageObjects(fx.db, repo, "1 hour")
		const summary = await scheduler.drainOnce()
		expect(summary.filter((e) => e.repo === repo)).toHaveLength(1)
		expect(await objectOids(fx.db, repo)).not.toContain(orphan)
	})
})

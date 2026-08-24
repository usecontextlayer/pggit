import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGcScheduler } from "@/store/gc-scheduler"
import {
	countObjects,
	type GcFixture,
	objectOids,
	pushFile,
	repoGcState,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"

/**
 * GC scheduler — the drain loop's ELIGIBILITY policy
 * (`docs/2026-06-24-gc-scheduler-design.md` §6, items SCH-3, SCH-4, SCH-5).
 *
 * Eligibility is the whole policy (§2): a repo is drained by a pass iff
 * `last_pushed_at IS NOT NULL AND (last_gc_at IS NULL OR last_pushed_at >
 * last_gc_at)`. These cases pin WHICH repos a `drainOnce()` touches —
 * independent of how MUCH each reclaims — so the scheduler runs with a huge
 * grace (no orphan is ever old enough to reclaim) to fully decouple the
 * eligible-SET assertions from the reclaim amount. `drainOnce()` is driven
 * directly; the `setInterval` timer is never in the critical path (§7).
 *
 * OBSERVABLE-ONLY: every assertion is on the `DrainSummary` return value, the two
 * new `repos` columns via `repoGcState`, or `git_object` rows via
 * `objectOids`/`countObjects`. Nothing probes scheduler internals (timer
 * mechanics, candidate SQL, concurrency choreography, the per-repo guard) — those
 * stay free to change. Determinism comes from the scheduler's `graceSeconds`,
 * never a wall-clock wait.
 *
 * These cases pin the activity stamp and drain-loop contract under §6.
 */
describe("GC scheduler drain loop — eligibility (§6: SCH-3, SCH-4, SCH-5)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	// A grace so large no orphan is ever old enough to reclaim: these cases pin the
	// eligible SET, not the reclaim amount, so the rows must never move and the
	// summary's repo list is the observable under test.
	const HUGE_GRACE = 365 * 24 * 60 * 60

	// A pass SETTLES a repo (stamps last_gc_at) only when it ran past the grace
	// horizon of the repo's last push — otherwise young garbage would be orphaned
	// forever (see drainRepo). These set-discrimination cases model the settled
	// steady state, so each push that a drain is expected to settle gets its
	// last_pushed_at backdated PAST the huge grace. Only the repos row moves —
	// object created_at stays young, so nothing is ever reclaimed here.
	const backdatePastGrace = async (repo: string): Promise<void> => {
		// Both timestamps shift so the ELIGIBILITY ordering is preserved while the
		// push recedes past the grace horizon (SET expressions read the row's OLD
		// values, so last_gc_at lands strictly before the shifted last_pushed_at).
		await fx.db.sql`
			update repos set
				last_pushed_at = last_pushed_at - interval '2 years',
				last_gc_at = case
					when last_gc_at is null then null
					else last_pushed_at - interval '2 years' - interval '1 second'
				end
			where name = ${repo}`
	}

	const scheduler = () =>
		createGcScheduler(fx.db.sql, {
			concurrency: 4,
			graceSeconds: HUGE_GRACE,
			intervalMs: 30_000,
		})

	const summaryRepos = (summary: { repo: string }[]): string[] =>
		summary.map((entry) => entry.repo).sort()

	// SCH-3 — Drains exactly the eligible set. Three repos: A and C have been pushed
	// since their last GC (eligible); B was drained once with no push since (NOT
	// eligible on the second pass). The second `drainOnce()` summary must be exactly
	// {A, C}, B absent — and B's stored objects untouched by that pass. A wrong impl
	// that GCs ALL repos (or all repos that have objects) lists B in the summary and
	// fails the set assertion.
	it("SCH-3: a pass drains exactly the eligible set, not every repo", async () => {
		const repoA = "sch3-a"
		const repoB = "sch3-b"
		const repoC = "sch3-c"
		const sched = scheduler()

		// First, make all three eligible (last_gc_at is NULL after a push).
		await pushFile(fx, repoA, { content: "a1\n" })
		await pushFile(fx, repoB, { content: "b1\n" })
		await pushFile(fx, repoC, { content: "c1\n" })
		for (const r of [repoA, repoB, repoC]) await backdatePastGrace(r)

		// First pass drains all three (every repo has last_gc_at NULL).
		const first = await sched.drainOnce()
		expect(summaryRepos(first)).toEqual([repoA, repoB, repoC])

		// Re-push only A and C (a rewind advances their last_pushed_at past their
		// fresh last_gc_at). B is left untouched, so on the next pass B is NOT eligible.
		await pushFile(fx, repoA, { content: "a2\n", rewind: true })
		await pushFile(fx, repoC, { content: "c2\n", rewind: true })
		for (const r of [repoA, repoC]) await backdatePastGrace(r)

		// Snapshot B's stored objects right before the discriminating pass.
		const bObjectsBefore = await objectOids(fx.db, repoB)
		const bCountBefore = await countObjects(fx.db, repoB)

		// Second pass: eligible set is exactly {A, C}. B must be absent.
		const second = await sched.drainOnce()
		expect(summaryRepos(second)).toEqual([repoA, repoC])
		expect(second.map((entry) => entry.repo)).not.toContain(repoB)

		// And the pass left B's rows byte-identical (it never touched B).
		expect(await objectOids(fx.db, repoB)).toEqual(bObjectsBefore)
		expect(await countObjects(fx.db, repoB)).toBe(bCountBefore)
	})

	// SCH-4 — A pass advances last_gc_at and is self-terminating. After a repo is
	// drained, its last_gc_at is non-null and strictly later than the last_pushed_at
	// that made it eligible; a SECOND `drainOnce()` with no intervening push to that
	// repo returns an empty summary for it (it is no longer eligible). A wrong impl
	// that never stamps last_gc_at would re-drain the repo forever and fail the
	// empty-second-summary assertion.
	it("SCH-4: a pass advances last_gc_at and a re-run drains nothing without a new push", async () => {
		const repo = "sch4-self-terminating"
		const sched = scheduler()

		await pushFile(fx, repo, { content: "v1\n" })
		await backdatePastGrace(repo)

		// Before any drain: pushed (eligible), never GC'd.
		const beforeDrain = await repoGcState(fx.db, repo)
		if (beforeDrain.kind !== "pushed-never-drained") {
			throw new Error(`expected pushed, undrained repo ${repo}; got ${beforeDrain.kind}`)
		}

		// First pass processes the repo and stamps last_gc_at.
		const first = await sched.drainOnce()
		expect(summaryRepos(first)).toContain(repo)

		const afterDrain = await repoGcState(fx.db, repo)
		if (afterDrain.kind !== "pushed-and-drained") {
			throw new Error(`expected drained repo ${repo}; got ${afterDrain.kind}`)
		}
		// The stamp advanced past the last_pushed_at that made the repo eligible, so
		// the eligibility predicate (last_pushed_at > last_gc_at) is now false.
		expect(afterDrain.gcAt.getTime()).toBeGreaterThan(beforeDrain.pushedAt.getTime())

		// Second pass with NO intervening push: the repo is no longer eligible, so the
		// summary does not list it (self-terminating).
		const second = await sched.drainOnce()
		expect(second.map((entry) => entry.repo)).not.toContain(repo)
	})

	// SCH-5 — Idle repos untouched. Two flavours of "idle" must never appear in a
	// drain summary and must keep their git_object rows unchanged: (a) a repo that
	// was never pushed (last_pushed_at NULL), and (b) a repo pushed-then-drained with
	// no push since. A discriminating eligible repo is drained in the same pass to
	// prove the loop is doing work — the idle repos are excluded, not the loop inert.
	it("SCH-5: never-pushed and already-drained repos are excluded and unmutated", async () => {
		const idleNeverPushed = "sch5-never-pushed"
		const idleDrained = "sch5-already-drained"
		const eligible = "sch5-eligible"
		const sched = scheduler()

		// `idleDrained` gets pushed then drained, so it is no longer eligible.
		await pushFile(fx, idleDrained, { content: "drained-once\n" })
		await backdatePastGrace(idleDrained)
		const drainOne = await sched.drainOnce()
		expect(summaryRepos(drainOne)).toEqual([idleDrained])

		// `idleNeverPushed` is created lazily in Postgres by a push, so to model a
		// genuinely never-pushed repo we simply never push it: its row is absent.
		expect(await repoGcState(fx.db, idleNeverPushed)).toEqual({ kind: "absent" })

		// Now push the discriminating eligible repo so the pass has real work to do.
		await pushFile(fx, eligible, { content: "fresh\n" })
		await backdatePastGrace(eligible)

		// Snapshot the idle repos' rows before the discriminating pass.
		const drainedObjectsBefore = await objectOids(fx.db, idleDrained)
		const drainedCountBefore = await countObjects(fx.db, idleDrained)
		const neverCountBefore = await countObjects(fx.db, idleNeverPushed)

		// The pass drains ONLY the eligible repo; neither idle repo appears.
		const drainTwo = await sched.drainOnce()
		expect(summaryRepos(drainTwo)).toEqual([eligible])
		const drainedRepos = drainTwo.map((entry) => entry.repo)
		expect(drainedRepos).not.toContain(idleNeverPushed)
		expect(drainedRepos).not.toContain(idleDrained)

		// And both idle repos' rows are unchanged by that pass.
		expect(await objectOids(fx.db, idleDrained)).toEqual(drainedObjectsBefore)
		expect(await countObjects(fx.db, idleDrained)).toBe(drainedCountBefore)
		expect(await countObjects(fx.db, idleNeverPushed)).toBe(neverCountBefore)
	})
})

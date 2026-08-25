/**
 * Property-based scheduler differential — `docs/2026-06-24-gc-scheduler-design.md`
 * §6, item PBT-S1 ("Multi-repo differential"). For a RANDOM sequence of operations
 * across several repos — each op a push, a rewind, or a side-branch delete —
 * one `drainOnce({ graceSeconds: 0 })` with every object aged must, for EVERY repo:
 *
 *   (a) leave the surviving `git_object` rows (`objectOids`) exactly equal to that
 *       repo's real-git reachable closure of its CURRENT refs (the §6 git oracle:
 *       re-fetch every surviving ref → `gitReachableOids`) — independent of any
 *       `pushFile` return value; AND
 *   (b) appear in the returned `DrainSummary` iff it received any storage-mutating
 *       op. Because every repo here is created by (and only by) such ops and starts
 *       with `last_gc_at IS NULL`, the eligible set === ALL touched repos. So the
 *       summary's repo set must equal the set of touched repos; AND
 *   (c) carry `settled: true` in that summary — with `graceSeconds: 0` the settle
 *       stamp must land for every repo the pass drained; AND
 *   (d) be GONE from a second, immediately following `drainOnce()`. That second pass
 *       is the only place the `last_pushed_at <= last_gc_at` state — the one the
 *       eligibility predicate exists to EXCLUDE — is ever constructed here, so it is
 *       what pins over-selection. (b) alone cannot: a repo row is created by its
 *       first push, so an "untouched repo" has no row to be wrongly selected. With
 *       the drain's repack phase enabled, this also pins repack's own arm of the
 *       union predicate: the pass's completed repack stamped `last_repack_at`, so
 *       neither watermark re-qualifies the repo; AND
 *   (e) end the pass fully ENCODED (the drain-repack doc's coverage conjunct):
 *       every surviving sub-cap object has exactly one `git_pack_encoding` row
 *       (`encodingViolations` empty), and the post-drain oracle fetch — served
 *       through that tier — fscks clean.
 *
 * This GENERALISES the example-based scheduler cases: SCH-3 (drains exactly the
 * eligible set), SCH-6 (end-to-end reclamation through the loop), SCH-8 (tenant
 * isolation — every eligible repo ends up correctly GC'd regardless of the pass's
 * internal concurrency). The whole policy under test is the eligibility predicate
 * `last_pushed_at IS NOT NULL AND (last_gc_at IS NULL OR last_pushed_at > last_gc_at)`.
 *
 * OBSERVABLE-ONLY (§6, non-negotiable): every assertion reads only the real-`git`
 * oracle (`fetch` / `rev-list` via `gitReachableOids`), Postgres rows
 * (`objectOids` via `fx.db`), or the `drainOnce()` return value. Nothing here
 * probes scheduler internals — no temp tables, no candidate SQL, no batch/txn
 * shape, no concurrency choreography, no timer mechanics, no advisory locks. The
 * eligible SET and per-repo SURVIVORS are asserted as outcomes, never the
 * machinery that produced them. Determinism comes from `ageObjects` +
 * `graceSeconds: 0`, never a wall-clock sleep; the `setInterval` `start()` is
 * never exercised (only `drainOnce()` is driven).
 *
 * The property pins the scheduler's shipped eligibility and survivor contracts.
 */
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertNever } from "@/lang"
import { createGcScheduler } from "@/store/gc-scheduler"
import { IS_CI } from "@/testing/ci"
import {
	ageObjects,
	encodingViolations,
	type GcFixture,
	objectOids,
	pushBranch,
	pushFile,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import { gitReachableOids } from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

/** One operation against a single repo within a run. The generator emits a stream
 * of these; the test interprets them through a tiny per-repo model (below) so every
 * emitted op is a VALID storage mutation (wire pushes, plus the store-level moves
 * the wire policy no longer allows):
 *   - `push`  — write `refs/heads/main`: the repo's first push (create) when main is
 *               absent, else a rewind advancing main to an independent root
 *               (orphaning the prior tip).
 *   - `rewind`— same as a subsequent `push`: a store-level rewind of main (orphans
 *               the prior snapshot). Folded into `push` once main exists; kept as a
 *               distinct generated symbol so the sequence is push/rewind/delete.
 *   - `branch`— write a side branch `refs/heads/side-<n>` (so a later `delete` has a
 *               target); each carries fresh content → its own commit/tree/blob.
 *   - `delete`— delete the most-recent surviving side branch (a store ref-delete that
 *               ingests no object — SCH-2's case — orphaning that branch's
 *               exclusive objects). A no-op when no side branch exists. */
type RepoOp =
	| { kind: "push" }
	| { kind: "rewind" }
	| { kind: "branch" }
	| { kind: "delete" }

/** One generated step: which repo (by index into the run's repo pool) and the op. */
type Step = { repoIdx: number; op: RepoOp }

/** A per-repo model the test keeps so it only ever issues valid, storage-mutating
 * git ops (the same "sensible but randomized" discipline as `testing/repo-commands.ts`).
 * `touched` is the oracle for assertion (b): a repo is eligible iff it received any
 * storage-mutating op (and `last_gc_at` is null on a never-GC'd repo, so eligible
 * === touched). `sideBranches` is a stack of live side-branch names a `delete`
 * pops; `nextContent` keeps every blob/tree/commit oid distinct across ops. */
type RepoState = {
	mainExists: boolean
	sideBranches: string[]
	touched: boolean
	nextContent: number
}

const stepArb: fc.Arbitrary<Step> = fc.record({
	op: fc.oneof(
		{ arbitrary: fc.constant<RepoOp>({ kind: "push" }), weight: 3 },
		{ arbitrary: fc.constant<RepoOp>({ kind: "rewind" }), weight: 3 },
		{ arbitrary: fc.constant<RepoOp>({ kind: "branch" }), weight: 2 },
		{ arbitrary: fc.constant<RepoOp>({ kind: "delete" }), weight: 2 },
	),
	// Wraparound into the run's repo pool (size chosen per run); `% repoCount` applied
	// at interpretation so the arbitrary itself stays pool-size-agnostic.
	repoIdx: fc.nat({ max: 1_000_000 }),
})

/**
 * Delete a ref at the STORE level (ingesting no object) — SCH-2's
 * delete-only-orphans case, driven internally now that the wire denies deletes.
 */
async function deleteRef(
	fx: Pick<GcFixture, "refs">,
	repo: string,
	ref: string,
): Promise<void> {
	// The wire now DENIES ref deletion (deny-non-FF policy), so the workload's
	// delete-only-orphans case drives the STORE directly — the internal path a
	// deleted ref takes. An unconditional delete: zero new oid,
	// zero old oid (no CAS assertion).
	const done = await fx.refs.applyRefUpdates(
		repo,
		[{ newOid: "0".repeat(40), oldOid: "0".repeat(40), ref }],
		false,
	)
	if (done.some((ok) => !ok)) throw new Error(`deleteRef: store delete failed for ${ref}`)
}

/**
 * The real-git reachable closure over ALL of a repo's CURRENTLY-SURVIVING refs —
 * the §6 survivor oracle for assertion (a), computed independently of any
 * `pushFile`/operation return value. Mirror-fetch every `refs/heads/*` the server
 * still advertises into a throwaway repo (a deleted branch is simply not fetched),
 * point local heads at them, and walk `gitReachableOids` (`rev-list --objects
 * --all` + tag objects). When the repo has no surviving head (every branch
 * deleted) the closure is empty. Returns sorted hex, matching `objectOids`.
 */
async function reachableOverAllRefs(
	fx: Pick<GcFixture, "server">,
	repo: string,
): Promise<string[]> {
	return withTempDir("pggit-gcsch-oracle-", async (dir) => {
		await spawnGit(["init", "-q"], { cwd: dir })
		// Mirror every surviving head into a matching local head; if none survive the
		// fetch is a clean no-op and the closure is empty.
		await spawnGit(
			[
				"-c",
				"protocol.version=2",
				"fetch",
				repoUrl(fx, repo),
				"refs/heads/*:refs/heads/*",
			],
			{ cwd: dir },
		)
		// The post-drain fetch is served THROUGH the encoding tier (repack enabled),
		// so fsck here is the wire-integrity conjunct: a corrupt or mis-based stored
		// delta cannot survive it.
		await spawnGit(["fsck", "--full"], { cwd: dir })
		return gitReachableOids(dir)
	})
}

/** Interpret one step against the repo model, issuing the corresponding storage-
 * mutating git op and updating the model. Skips a `delete` with no live side branch
 * (keeps the sequence valid). Marks the repo `touched` on every op that actually
 * mutated storage — the eligibility oracle. */
async function applyStep(
	fx: GcFixture,
	repo: string,
	state: RepoState,
	op: RepoOp,
): Promise<void> {
	switch (op.kind) {
		case "push":
		case "rewind": {
			// First push to a fresh repo creates main (a plain wire push); every later
			// one is a store-level rewind advancing main to an independent root and
			// orphaning the prior tip.
			const rewind = state.mainExists
			await pushFile(fx, repo, {
				content: `main rev ${state.nextContent++}\n`,
				rewind,
			})
			state.mainExists = true
			state.touched = true
			return
		}
		case "branch": {
			const name = `side-${state.nextContent}`
			await pushBranch(fx, repo, name, `branch ${name} rev ${state.nextContent++}\n`)
			state.sideBranches.push(name)
			state.touched = true
			return
		}
		case "delete": {
			const name = state.sideBranches.pop()
			if (name === undefined) return // no live side branch → valid no-op
			await deleteRef(fx, repo, `refs/heads/${name}`)
			state.touched = true
			return
		}
	}
	return assertNever(op)
}

/**
 * Run counts: each candidate is several full PG+git round trips, so keep the count
 * modest locally and broaden under CI. Seed pinned (424_242) so every run — and
 * every shrink re-run — is reproducible.
 */
const NUM_RUNS = IS_CI ? 30 : 12

describe("§6 PBT-S1 — property-based scheduler differential", () => {
	let fx: GcFixture
	let runCounter = 0

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	it("PBT-S1 — one drainOnce(grace:0) reclaims every repo to its reachable closure and the summary's repo set == the touched repos", async () => {
		await fc.assert(
			fc.asyncProperty(
				// 2–5 repos per run, a handful of ops each.
				fc.integer({ max: 5, min: 2 }),
				fc.array(stepArb, { maxLength: 18, minLength: 1 }),
				async (repoCount, steps) => {
					// FRESH, run-unique repo names so candidates (incl. shrink re-runs) never
					// collide inside the one shared schema — helpers key purely off the name.
					const run = runCounter++
					const repos = Array.from({ length: repoCount }, (_, i) => `pbts1-r${run}-${i}`)
					const states: RepoState[] = repos.map(() => ({
						mainExists: false,
						nextContent: 0,
						sideBranches: [],
						touched: false,
					}))

					// Replay the random op stream across the repo pool (per-repo serialized).
					for (const { op, repoIdx } of steps) {
						const idx = repoIdx % repoCount
						const repo = repos[idx]
						const state = states[idx]
						if (repo === undefined || state === undefined) {
							throw new Error(`missing generated repo state at index ${idx}`)
						}
						await applyStep(fx, repo, state, op)
					}

					// Age EVERY object of EVERY repo so grace=0 is free to reclaim every
					// orphan (and nothing live, which is never older than now). Deterministic
					// substitute for a wall-clock grace wait.
					for (const repo of repos) await ageObjects(fx.db, repo, "1 hour")

					// THE pass under test: one drain over the whole schema, grace=0.
					const scheduler = createGcScheduler(fx.db.sql, {
						concurrency: 4,
						graceSeconds: 0,
						intervalMs: 30_000,
						repackEnabled: true,
					})
					const summary = await scheduler.drainOnce()

					// (b) Eligible set is observable and exact: the summary lists EXACTLY the
					// repos that received any storage-mutating op (each had last_gc_at NULL, so
					// touched ⟺ eligible). This catches an impl that drains too FEW — a
					// delete-only repo missed, or a repo already settled by an earlier
					// candidate's pass reappearing. It cannot catch draining too many: a repo
					// row exists only once something pushed to it, so an "untouched repo" has
					// no row to be wrongly selected. (d) is where over-selection is pinned.
					const touched = repos
						.filter((_, i) => {
							const state = states[i]
							if (state === undefined)
								throw new Error(`missing generated state at index ${i}`)
							return state.touched
						})
						.sort()
					const drained = summary.map((entry) => entry.repo).sort()
					expect(drained).toEqual(touched)

					// (c) Every drained repo SETTLED. With graceSeconds: 0 the settle predicate
					// (`last_pushed_at + 0 <= t0`) must fire for every repo the pass reclaimed,
					// so this reads the stamp directly instead of inferring it from (d).
					expect(
						summary
							.filter((entry) => entry.gc === null || !entry.gc.settled)
							.map((entry) => entry.repo),
						"a drained repo did not settle",
					).toEqual([])

					// (d) The over-selection direction. Every repo is now in the
					// `last_pushed_at <= last_gc_at` state the predicate exists to exclude, and
					// nothing has pushed since, so an immediate second pass must drain NOTHING.
					// A predicate that over-selects, or a settle stamp that never landed, fails
					// here — the states (b) is structurally unable to reach.
					expect(await scheduler.drainOnce()).toEqual([])

					// (a) Per-repo differential: after the single drain, each repo's surviving
					// Postgres objects == its real-git reachable closure over its current refs.
					// This pins BOTH liveness (no live object dropped) and reclamation (every
					// orphan from a rewind or a branch-delete gone) for EVERY repo at once
					// — the multi-repo generalisation of SCH-6, isolated per repo (SCH-8).
					for (const [i, repo] of repos.entries()) {
						const state = states[i]
						if (state === undefined) {
							throw new Error(`missing generated state at index ${i}`)
						}
						const survivors = await objectOids(fx.db, repo)
						const reachable = await reachableOverAllRefs(fx, repo)
						expect(survivors).toEqual(reachable)

						// Coverage conjunct (SCH-R1 generalised, drain-repack doc): with
						// repack enabled, the settled drain leaves every surviving sub-cap
						// object with exactly one encoding row — for every persisted repo,
						// whatever op sequence produced it.
						if (state.touched) {
							expect(await encodingViolations(fx.db, repo)).toEqual([])
						}
					}
				},
			),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)
	})
})

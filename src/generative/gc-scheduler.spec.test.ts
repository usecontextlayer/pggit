/**
 * Property-based scheduler differential — `docs/2026-06-24-gc-scheduler-design.md`
 * §6, item PBT-S1 ("Multi-repo differential"). For a RANDOM sequence of operations
 * across several repos — each op a push, a force-commit, or a side-branch delete —
 * one `drainOnce({ graceSeconds: 0 })` with every object aged must, for EVERY repo:
 *
 *   (a) leave the surviving `git_object` rows (`objectOids`) exactly equal to that
 *       repo's real-git reachable closure of its CURRENT refs (the §6 git oracle:
 *       re-fetch every surviving ref → `gitReachableOids`) — independent of any
 *       `pushFile` return value; AND
 *   (b) appear in the returned `DrainSummary` iff it received any storage-mutating
 *       op. Because every repo here is created by (and only by) such ops and starts
 *       with `last_gc_at IS NULL`, the eligible set === ALL touched repos. So the
 *       summary's repo set must equal the set of touched repos.
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
 * RED now because `createGcScheduler.drainOnce()` is a TDD stub that throws
 * "pggit gc-scheduler: not implemented (TDD stub)" and the store does not yet
 * stamp `repos.last_pushed_at`, so the eligible set is unobservable and nothing is
 * reclaimed. GREEN once the scheduler drains exactly the eligible set and reclaims
 * each repo to its reachable closure per §6.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGcScheduler } from "@/gc-scheduler"
import {
	ageObjects,
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

/** One operation against a single repo within a run. The generator emits a stream
 * of these; the test interprets them through a tiny per-repo model (below) so every
 * emitted op is a VALID, storage-mutating git operation:
 *   - `push`  — write `refs/heads/main`: the repo's first push (create) when main is
 *               absent, else a force-commit advancing main to an independent root
 *               (orphaning the prior tip).
 *   - `force` — same as a subsequent `push`: a force-commit on main (orphans the
 *               prior snapshot). Folded into `push` once main exists; kept as a
 *               distinct generated symbol so the sequence is push/force/delete.
 *   - `branch`— write a side branch `refs/heads/side-<n>` (so a later `delete` has a
 *               target); each carries fresh content → its own commit/tree/blob.
 *   - `delete`— delete the most-recent surviving side branch (a ref-delete that
 *               ingests no object — SCH-2's case — orphaning that branch's
 *               exclusive objects). A no-op when no side branch exists. */
type RepoOp =
	| { kind: "push" }
	| { kind: "force" }
	| { kind: "branch" }
	| { kind: "delete" }

/** One generated step: which repo (by index into the run's repo pool) and the op. */
type Step = { repoIdx: number; op: RepoOp }

/** A per-repo model the test keeps so it only ever issues valid, storage-mutating
 * git ops (the same "sensible but randomized" discipline as `generative/commands.ts`).
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
		{ arbitrary: fc.constant<RepoOp>({ kind: "force" }), weight: 3 },
		{ arbitrary: fc.constant<RepoOp>({ kind: "branch" }), weight: 2 },
		{ arbitrary: fc.constant<RepoOp>({ kind: "delete" }), weight: 2 },
	),
	// Wraparound into the run's repo pool (size chosen per run); `% repoCount` applied
	// at interpretation so the arbitrary itself stays pool-size-agnostic.
	repoIdx: fc.nat({ max: 1_000_000 }),
})

/**
 * Push a fresh single-file root commit to `refs/heads/<name>` from a throwaway
 * source (then discard it) — the side-branch creator. `pushFile` only ever targets
 * `refs/heads/main`, so a side branch needs this raw push; it mirrors `pushFile`'s
 * "independent root, discard the source" shape so the branch's objects survive only
 * in Postgres (where a later delete orphans them). `--force` is harmless on a fresh
 * ref and keeps the push path identical to a force-commit's.
 */
async function pushBranch(
	fx: Pick<GcFixture, "server">,
	repo: string,
	branch: string,
	content: string,
): Promise<void> {
	await withTempDir("pggit-gcsch-br-", async (src) => {
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, `${branch}.txt`), content)
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c"], { cwd: src })
		await spawnGit(["push", "--force", repoUrl(fx, repo), `HEAD:refs/heads/${branch}`], {
			cwd: src,
		})
	})
}

/**
 * Delete a ref on the server by pushing an empty source over it (`git push <url>
 * :<ref>`), the raw-git ref-delete that ingests no object — exactly SCH-2's
 * delete-only-orphans case. Run from a throwaway dir so it needs no local history.
 */
async function deleteRef(
	fx: Pick<GcFixture, "server">,
	repo: string,
	ref: string,
): Promise<void> {
	await withTempDir("pggit-gcsch-del-", async (dir) => {
		await spawnGit(["init", "-q"], { cwd: dir })
		await spawnGit(["push", repoUrl(fx, repo), `:${ref}`], { cwd: dir })
	})
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
		case "force": {
			// First push to a fresh repo creates main (no force); every later one is a
			// force-commit advancing main to an independent root, orphaning the prior tip.
			const force = state.mainExists
			await pushFile(fx, repo, {
				content: `main rev ${state.nextContent++}\n`,
				force,
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
}

/**
 * Run counts: each candidate is several full PG+git round trips, so keep the count
 * modest locally and broaden under CI. Seed pinned (424_242) so every run — and
 * every shrink re-run — is reproducible.
 */
const IS_CI = process.env.CI !== undefined && process.env.CI !== ""
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
						if (repo === undefined || state === undefined) continue
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
					})
					const summary = await scheduler.drainOnce()

					// (b) Eligible set is observable and exact: the summary lists EXACTLY the
					// repos that received any storage-mutating op (each had last_gc_at NULL, so
					// touched ⟺ eligible). A wrong impl that drains too few (misses a delete-only
					// repo) or too many (sweeps an untouched repo) fails here.
					const touched = repos.filter((_, i) => states[i]?.touched).sort()
					const drained = summary.map((entry) => entry.repo).sort()
					expect(drained).toEqual(touched)

					// (a) Per-repo differential: after the single drain, each repo's surviving
					// Postgres objects == its real-git reachable closure over its current refs.
					// This pins BOTH liveness (no live object dropped) and reclamation (every
					// orphan from a force-commit or a branch-delete gone) for EVERY repo at once
					// — the multi-repo generalisation of SCH-6, isolated per repo (SCH-8).
					for (const repo of repos) {
						const survivors = await objectOids(fx.db, repo)
						const reachable = await reachableOverAllRefs(fx, repo)
						expect(survivors).toEqual(reachable)
					}
				},
			),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)
	})
})

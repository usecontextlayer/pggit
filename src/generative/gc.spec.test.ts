/**
 * Property-based GC differential (`docs/2026-06-24-force-commit-gc-design.md` §4,
 * PBT-1/2/3). Random commit DAGs (the §6 `generative/commands.ts` generator) are
 * driven through real `git` + the served store, then GC is checked against the
 * real-git reachable-closure oracle. These GENERALISE the example-based GC cases:
 *
 *   PBT-1 — Reachability differential.  For a random DAG with a random ref SUBSET,
 *           GC with `graceSeconds: 0` leaves the surviving `git_object` rows ==
 *           the real-git reachable closure over exactly the seeded refs. The
 *           random subset is what creates the unreachable set: objects reachable
 *           only from a dropped ref must be reclaimed. Generalises GC-1/2/7.
 *   PBT-2 — Rewind storage bound.  Over a random-length sequence of store
 *           rewinds (each an independent root commit → the ref moves to a
 *           non-descendant, orphaning the prior snapshot), GC after every cycle
 *           pins `git_object` to the CURRENT reachable closure — it never grows
 *           with the sequence length K. Generalises GC-4.
 *   PBT-3 — Idempotence under random graphs.  GC∘GC == GC: after the reclaiming
 *           pass, a second pass deletes nothing and leaves rows + a clone-back
 *           byte-identical. Generalises GC-6.
 *
 * OBSERVABLE-ONLY: assertions read only the real-`git` oracle (rev-list / fetch /
 * fsck), Postgres rows (`git_object` via the helpers), and the `gc()` return value.
 * Nothing probes GC internals. Grace is made deterministic by `ageObjects` +
 * `graceSeconds: 0`, never a wall-clock sleep.
 *
 * SAMPLING (`NUM_RUNS` / `NUM_RUNS_REWIND`): the fast-check seed is pinned (424_242)
 * so every run is reproducible, but the run count is CI-aware — a small count
 * locally (each candidate is a full PG round-trip) and a broad count under `CI` so
 * the thin annotated-tag / nested-tree / dropped-ref corners actually get sampled.
 * Each property folds every candidate's shape into a `ShapeCoverage` tally and FLOORS
 * it after `fc.assert`: the floors are the counts the pinned seed realizes locally,
 * and a broader CI run only ever exceeds them (same seed ⇒ the local corpus is a
 * prefix of the CI one). Without those floors a generator regression that degenerated
 * every candidate — no dropped ref, hence nothing unreachable to reclaim — would leave
 * "GC deleted nothing" indistinguishable from "GC is correct", with every property green.
 *
 * Originated as the TDD spec for GC (§4) and ran RED against a throwing stub until GC
 * landed; it now pins the shipped contract. (`buildRepoFromCommands` builds in `/tmp`;
 * the caller cleans it.)
 */
import { rmSync } from "node:fs"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildRepoFromCommands, repoCommands } from "@/generative/commands"
import { IS_CI } from "@/testing/ci"
import {
	ageObjects,
	cloneAndFsck,
	type GcFixture,
	objectOids,
	pushFile,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import {
	branchAndTagRefsOf,
	loadAllObjects,
	parseRevListObjectOids,
} from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"

/**
 * The real-git reachable object closure over a SPECIFIC set of ref-tip oids (a
 * subset of the repo's refs) — the PBT-1/PBT-3 expected-survivors oracle. `git
 * rev-list --objects <tip…>` yields the commit/tree/blob closure of those tips,
 * and passing an annotated-tag object's oid peels it AND lists the tag object
 * itself, so this needs no extra tag incantation (cf. `git-fixtures`' all-refs
 * `gitReachableOids`, which must add tag objects because `--all` lists peeled
 * targets). Returns sorted hex, matching `objectOids` for a direct `toEqual`.
 */
async function gitClosureOver(dir: string, tipOids: string[]): Promise<string[]> {
	if (tipOids.length === 0) return []
	const out = await spawnGit(["rev-list", "--objects", ...tipOids], { cwd: dir })
	return [...new Set(parseRevListObjectOids(out.stdout))].sort()
}

/** Fetch `ref` into a throwaway dir and `fsck --full` it (throws on any dangling /
 * corruption) — the integrity half of the differential for generated repos whose
 * file set varies, so (unlike `cloneAndFsck`) it reads no specific file. */
async function fetchAndFsck(
	fx: Pick<GcFixture, "server">,
	repo: string,
	ref: string,
): Promise<void> {
	const url = repoUrl(fx, repo)
	await buildRepoFromCommands([]).then(async ({ dir }) => {
		try {
			await spawnGit(["-c", "protocol.version=2", "fetch", url, ref], { cwd: dir })
			await spawnGit(["fsck", "--full"], { cwd: dir })
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
}

/**
 * Seed a generated repo into the store under `repo`: ALL of its objects (reachable
 * AND unreachable) but only the chosen ref SUBSET. The objects reachable only from
 * a dropped ref are then genuinely present-but-unreachable — exactly what GC must
 * reclaim. Returns BOTH the kept refs and the dropped refs (each name + tip oid) so
 * the caller can build the expected-survivor oracle, pick a ref to fetch, AND
 * classify the candidate's shape coverage (`shapeOfCandidate`). HEAD is
 * intentionally NOT seeded: reachability walks ref tips, and a HEAD symref adds none.
 */
async function seedSubset(
	fx: GcFixture,
	repo: string,
	src: string,
	keepMask: boolean[],
): Promise<{
	kept: { name: string; oid: string }[]
	dropped: { name: string; oid: string }[]
}> {
	const allRefs = await branchAndTagRefsOf(src)
	// Apply the mask with wraparound; always keep at least one ref (index 0) so the
	// repo has a live set and something to fetch.
	const keptSet = new Set(
		allRefs.filter((_, i) => i === 0 || (keepMask[i % keepMask.length] ?? false)),
	)
	const kept = allRefs.filter((r) => keptSet.has(r))
	const dropped = allRefs.filter((r) => !keptSet.has(r))
	await fx.objects.putPack(repo, await loadAllObjects(src))
	for (const ref of kept) await fx.refs.setRef(repo, ref.name, ref.oid)
	return { dropped, kept }
}

/**
 * The shape-coverage classification of one seeded candidate (GAP-3). These are the
 * three corners the reviewer flagged as thinly sampled; tallying them (see
 * `ShapeCoverage`) and flooring the tally is what makes "the property actually
 * exercised them" a claim the suite can fail. All three are derived purely from the
 * real-`git` oracle over the on-disk source + the kept/dropped ref split — no GC
 * internals are touched.
 *
 *   - `annotatedTag` — a KEPT ref tip is itself an annotated-tag object (so GC must
 *     preserve a tag object and peel through it). Detected like `gitReachableOids`:
 *     a ref whose `objecttype` is `tag`.
 *   - `nestedTree`  — the KEPT closure contains a subdirectory tree (a tree that is
 *     a child of another tree, e.g. `sub/`, `deep/x/`). Detected via `ls-tree -r -t`
 *     over the kept tips reporting a `tree`-type entry — the non-flat-root case.
 *   - `droppedUnreachable` — at least one DROPPED ref carried an object the kept
 *     closure does NOT reach, so GC genuinely has an unreachable set to reclaim
 *     (an empty unreachable set would make GC-2/GC-7 vacuous for this candidate).
 */
type CandidateShape = {
	annotatedTag: boolean
	nestedTree: boolean
	droppedUnreachable: boolean
}

/** True if any of `tipOids` is itself an annotated-tag object in `dir`. */
async function anyAnnotatedTag(dir: string, tipOids: string[]): Promise<boolean> {
	for (const oid of tipOids) {
		const out = await spawnGit(["cat-file", "-t", oid], { cwd: dir })
		if (out.stdout.trim() === "tag") return true
	}
	return false
}

/** True if the kept closure contains a nested subtree (a tree child of a tree),
 * i.e. some tip resolves to a tree with a subdirectory — the non-flat-root shape.
 * `ls-tree -r -t <tip>` lists a `tree`-type row exactly when a subdirectory exists. */
async function anyNestedTree(dir: string, tipOids: string[]): Promise<boolean> {
	for (const oid of tipOids) {
		const out = await spawnGit(["ls-tree", "-r", "-t", oid], { cwd: dir })
		for (const line of out.stdout.trim().split("\n")) {
			if (line.split(/\s+/, 2)[1] === "tree") return true
		}
	}
	return false
}

/**
 * Classify a seeded candidate's shape from the on-disk source and the kept/dropped
 * ref split. `droppedUnreachable` compares the dropped refs' closure against the
 * kept closure: it is true when a dropped ref carried an object the kept tips do
 * not reach (the genuinely-reclaimable set).
 */
async function shapeOfCandidate(
	src: string,
	kept: { oid: string }[],
	dropped: { oid: string }[],
): Promise<CandidateShape> {
	const keptOids = kept.map((r) => r.oid)
	const keptClosure = new Set(await gitClosureOver(src, keptOids))
	const droppedClosure = await gitClosureOver(
		src,
		dropped.map((r) => r.oid),
	)
	return {
		annotatedTag: await anyAnnotatedTag(src, keptOids),
		droppedUnreachable: droppedClosure.some((oid) => !keptClosure.has(oid)),
		nestedTree: await anyNestedTree(src, keptOids),
	}
}

/**
 * A running tally of how many sampled candidates carried each flagged shape. This
 * is the lightweight, deterministic alternative to `fc.statistics` (whose own
 * standalone sampling pass would re-build repos and break the one-seed PG-round-trip
 * budget): the property folds each candidate's shape into the same counter, and the
 * test logs the fractions ONCE after `fc.assert` and then FLOORS them
 * (`expectShapeFloors`). A 0/N corner is a failure, not a number in the output.
 */
type ShapeCoverage = {
	total: number
	annotatedTag: number
	nestedTree: number
	droppedUnreachable: number
}

function newCoverage(): ShapeCoverage {
	return { annotatedTag: 0, droppedUnreachable: 0, nestedTree: 0, total: 0 }
}

function recordShape(cov: ShapeCoverage, shape: CandidateShape): void {
	cov.total++
	if (shape.annotatedTag) cov.annotatedTag++
	if (shape.nestedTree) cov.nestedTree++
	if (shape.droppedUnreachable) cov.droppedUnreachable++
}

/** A `pct/total` fraction (guards total=0 cleanly). */
function frac(n: number, total: number): string {
	const pct = total === 0 ? 0 : Math.round((100 * n) / total)
	return `${n}/${total} (${pct}%)`
}

/** Print the shape-coverage tally for one property (the GAP-3 visibility surface). */
function logCoverage(label: string, cov: ShapeCoverage): void {
	console.log(
		`[gc-pbt shape coverage] ${label}: ` +
			`annotated-tag=${frac(cov.annotatedTag, cov.total)} ` +
			`nested-tree=${frac(cov.nestedTree, cov.total)} ` +
			`dropped-unreachable=${frac(cov.droppedUnreachable, cov.total)}`,
	)
}

/**
 * The corner floors: what the pinned seed (424_242) realizes at the LOCAL run count.
 * `droppedUnreachable` is the load-bearing one — a corpus in which no candidate drops
 * a ref has an empty unreachable set everywhere, and "GC deleted nothing" then passes
 * PBT-1 and PBT-3 identically to "GC is correct". The other two guard the annotated-tag
 * and nested-subtree corners the generator is meant to reach. A broader CI run draws
 * the same candidate sequence and simply exceeds these.
 */
const SHAPE_FLOORS = {
	annotatedTag: 5,
	droppedUnreachable: 2,
	nestedTree: 16,
} as const

function expectShapeFloors(label: string, cov: ShapeCoverage): void {
	logCoverage(label, cov)
	expect(cov.total, `${label}: the property sampled nothing`).toBeGreaterThan(0)
	expect(
		cov.droppedUnreachable,
		`${label}: no candidate had an unreachable set — GC deleting nothing would pass`,
	).toBeGreaterThanOrEqual(SHAPE_FLOORS.droppedUnreachable)
	expect(
		cov.annotatedTag,
		`${label}: no candidate kept an annotated-tag ref tip`,
	).toBeGreaterThanOrEqual(SHAPE_FLOORS.annotatedTag)
	expect(
		cov.nestedTree,
		`${label}: no candidate kept a nested subtree`,
	).toBeGreaterThanOrEqual(SHAPE_FLOORS.nestedTree)
}

/**
 * Run counts: keep the PG-round-trip cost low LOCALLY, but let CI sample BROADLY so
 * the annotated-tag / nested-tree / dropped-ref corners are actually hit (GAP-3). The
 * seed stays pinned (424_242) so every run — local or CI — is reproducible. The
 * environment distinction is parsed once by the shared test-configuration boundary.
 *
 * The local count is 30 because MEASUREMENT set it, not taste: at the historical 12 the
 * corpus realizes ZERO candidates with a dropped-ref unreachable set, so PBT-1 and
 * PBT-3 had nothing for GC to reclaim and a GC that deleted nothing passed both. 30 is
 * the smallest round count at this seed that reaches that corner (see `SHAPE_FLOORS`,
 * which is what now holds it there); it costs a few seconds per property.
 */
const NUM_RUNS = IS_CI ? 200 : 30
// PBT-2 drives a per-cycle push+GC loop (heavier per candidate), so it scales lower.
const NUM_RUNS_REWIND = IS_CI ? 120 : 8

describe("§4 PBT — property-based GC differential", () => {
	let fx: GcFixture
	let counter = 0
	// Unique repo name per fast-check invocation (incl. shrink re-runs) so candidates
	// never collide inside the one shared schema; helpers key purely off the name.
	const nextRepo = (tag: string): string => `${tag}-${counter++}`

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	it("PBT-1 — graceSeconds:0 survivors == git reachable closure over a random ref subset", async () => {
		const cov = newCoverage()
		await fc.assert(
			fc.asyncProperty(
				repoCommands(25),
				fc.array(fc.boolean(), { maxLength: 8, minLength: 1 }),
				async (commands, keepMask) => {
					const { dir: src, model } = await buildRepoFromCommands(commands)
					try {
						fc.pre(model.commitCount > 0) // need at least one ref to keep
						const repo = nextRepo("pbt1")

						const { kept, dropped } = await seedSubset(fx, repo, src, keepMask)
						// Fold this candidate's shape into the tally (annotated-tag / nested-tree
						// / dropped-unreachable) so thin coverage is VISIBLE after the run.
						recordShape(cov, await shapeOfCandidate(src, kept, dropped))
						// All objects in (so the dropped refs' objects are present), then aged so
						// every row is unambiguously older than the grace=0 cutoff.
						await ageObjects(fx.db, repo, "1 hour")
						await fx.gc.gc(repo, { graceSeconds: 0 })

						// Survivors in Postgres == real-git reachable closure over the kept tips.
						const expected = await gitClosureOver(
							src,
							kept.map((r) => r.oid),
						)
						expect(await objectOids(fx.db, repo)).toEqual(expected)

						// And a fetch of a kept ref is fsck-clean (liveness preserved end-to-end).
						const keptRef = kept[0]
						if (keptRef === undefined) throw new Error("seedSubset kept no ref")
						await fetchAndFsck(fx, repo, keptRef.name)
					} finally {
						rmSync(src, { force: true, recursive: true })
					}
				},
			),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)
		expectShapeFloors("PBT-1", cov)
	})

	it("PBT-2 — repeated GC pins git_object to the current reachable closure (no growth with K)", async () => {
		// Rewind coverage: how many cycles were rewinds that ORPHANED a prior
		// snapshot (i > 0), and the longest amend chain (K) sampled. A 0-orphan
		// run would mean the storage-bound corner was never exercised — made visible.
		let rewindCycles = 0
		let maxChainK = 0
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.string({ maxLength: 40, minLength: 1 }), {
					maxLength: 8,
					minLength: 2,
				}),
				async (contents) => {
					const repo = nextRepo("pbt2")
					let last: { head: string; reachable: string[] } | undefined
					maxChainK = Math.max(maxChainK, contents.length)
					for (let i = 0; i < contents.length; i++) {
						// First push creates the ref; every later push REWINDS main (store level)
						// to an INDEPENDENT root commit → non-descendant tip, orphaning the prior
						// snapshot. `\n${i}` keeps each content (hence each oid) distinct.
						if (i > 0) rewindCycles++
						last = await pushFile(fx, repo, {
							content: `${contents[i]}\n${i}`,
							rewind: i > 0,
						})
						// Age + reclaim every cycle: the storage bound must hold AFTER EACH push,
						// not just at the end — that is what "no monotonic growth with K" means.
						await ageObjects(fx.db, repo, "1 hour")
						await fx.gc.gc(repo, { graceSeconds: 0 })
						// A single-file root commit's closure is exactly {commit, tree, blob}; the
						// surviving Postgres set must equal that closure, independent of i.
						expect(await objectOids(fx.db, repo)).toEqual([...last.reachable].sort())
					}

					// Final state: the latest snapshot clones back fsck-clean with its content.
					if (last) {
						const clone = await cloneAndFsck(fx, repo)
						expect(clone.head).toBe(last.head)
						expect(clone.fileContent).toBe(
							`${contents[contents.length - 1]}\n${contents.length - 1}`,
						)
					}
				},
			),
			{ numRuns: NUM_RUNS_REWIND, seed: 424_242 },
		)
		console.log(
			`[gc-pbt shape coverage] PBT-2: rewind-orphan-cycles=${rewindCycles} ` +
				`max-amend-chain-K=${maxChainK}`,
		)
		// The storage bound only means something once a cycle ORPHANED a prior snapshot:
		// with zero rewinds every candidate is a single push and "no growth with K" is
		// trivially true. Floored at what the pinned seed realizes locally.
		expect(
			rewindCycles,
			"too few rewinds — the storage-bound corner is under-exercised",
		).toBeGreaterThanOrEqual(27)
	})

	it("PBT-3 — GC∘GC == GC: a second pass deletes nothing and leaves rows + clone unchanged", async () => {
		const cov = newCoverage()
		await fc.assert(
			fc.asyncProperty(
				repoCommands(25),
				fc.array(fc.boolean(), { maxLength: 8, minLength: 1 }),
				async (commands, keepMask) => {
					const { dir: src, model } = await buildRepoFromCommands(commands)
					try {
						fc.pre(model.commitCount > 0)
						const repo = nextRepo("pbt3")

						const { kept, dropped } = await seedSubset(fx, repo, src, keepMask)
						// Same shape tally as PBT-1: idempotence is only a real test when the
						// first pass had a non-empty (annotated-tag / nested / dropped) set to act on.
						const shape = await shapeOfCandidate(src, kept, dropped)
						recordShape(cov, shape)
						// Age so the FIRST pass actually reclaims the unreachable set — idempotence
						// is only meaningful once the first run has done its deletions.
						await ageObjects(fx.db, repo, "1 hour")
						const first = await fx.gc.gc(repo, { graceSeconds: 0 })
						// ESTABLISH that precondition rather than assume it: when a dropped ref
						// carried objects the kept tips do not reach, the first pass MUST have
						// reclaimed something. Otherwise "GC∘GC == GC" below is just "nothing
						// happened twice".
						if (shape.droppedUnreachable) {
							expect(
								first.deletedObjects,
								"the dropped refs' exclusive objects survived the first pass",
							).toBeGreaterThan(0)
						}

						const afterFirst = await objectOids(fx.db, repo)
						const second = await fx.gc.gc(repo, { graceSeconds: 0 })

						// Second pass is a no-op: deletes nothing, leaves the survivor set identical.
						expect(second).toEqual({
							deletedObjects: 0,
							epoch: "unchanged",
						})
						expect(await objectOids(fx.db, repo)).toEqual(afterFirst)

						const keptRef = kept[0]
						if (keptRef === undefined) throw new Error("seedSubset kept no ref")
						await fetchAndFsck(fx, repo, keptRef.name)
					} finally {
						rmSync(src, { force: true, recursive: true })
					}
				},
			),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)
		expectShapeFloors("PBT-3", cov)
	})
})

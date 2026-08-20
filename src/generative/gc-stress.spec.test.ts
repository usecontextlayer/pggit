/**
 * Property-based GC STRESS differential (`docs/2026-06-24-force-commit-gc-design.md`
 * §4, §8). The existing PBT-1/2/3 (`gc.spec.test.ts`) sample MANY SMALL repos
 * (~25 commands). This file is the complement: FEW fast-check runs, each candidate
 * a DEEP + WIDE repo with a LARGE orphan set, so GC's batched DELETE + anti-join, the
 * commit-parent recursion, the tree→subtree walk, and the blob-from-tree enumeration
 * are all exercised at scale. It does NOT replace the small-candidate properties — it
 * stresses the axes they cannot reach.
 *
 *   DEEP — a long commit CHAIN (tens of commits) seeded as one history, so the
 *          reachable closure walks a deep commit-parent chain.
 *   WIDE — large NESTED trees: tens-to-low-hundreds of files across a deep
 *          directory nesting (`a/b/c/d/e/file.txt`), so each snapshot fans into a
 *          long tree→subtree walk and a wide blob set; PLUS many refs/branches, each
 *          with a commit and a file of its OWN, so the reachable closure genuinely
 *          spans many tips and the live-set materialization is wide.
 *   ORPHANS — many INDEPENDENT deep/wide histories are seeded into Postgres WITHOUT
 *          a ref, so GC has a large genuinely-unreachable set to reclaim in MANY
 *          batches.
 *
 * The §4 contract asserted here (observable-only, `graceSeconds: 0`):
 *
 *   STRESS-1 — Exact survivors at scale.  After `gc(graceSeconds:0)`, the surviving
 *              `git_object` rows == the real-git reachable closure over ALL live ref
 *              tips (the `gitReachableOids` oracle over the on-disk live source).
 *              Neither over- nor under-deletes, even with a deep chain + wide nested
 *              trees + a large orphan set. Generalises GC-1/2/7 at scale. A fetch of
 *              a live ref is then fsck-clean.
 *   STRESS-2 — Idempotence at scale.  A second `gc()` returns
 *              `{deletedObjects: 0}` and leaves the survivor set
 *              unchanged. Generalises GC-6 at scale.
 *   STRESS-3 — Batch invariance at scale.  On two byte-identical large repos
 *              (pinned identity + clock → identical OIDs), `gc(batchLimit: small)`
 *              and `gc(batchLimit: huge)` converge to the SAME survivor set — the
 *              key reason a deep/wide test matters: it crosses the multi-batch
 *              DELETE boundary many times. Generalises GC-10 at scale.
 *
 * OBSERVABLE-ONLY: assertions read only the real-`git` oracle (`rev-list` / fetch /
 * fsck), Postgres rows (`objectOids` / `countObjects` / `countDerivedRows`), and the
 * `gc()` return value. Nothing probes GC internals (temp tables, batch/CTE/txn
 * shape, advisory locks). Grace is made deterministic by `ageObjects` +
 * `graceSeconds: 0`, never a wall-clock sleep.
 *
 * PERFORMANCE: each candidate is a full PG round-trip seeding tens of thousands of
 * rows, so the run counts are deliberately TINY (`NUM_RUNS`) and the seed is pinned
 * (424_242) for determinism, matching the sibling specs. The deep/wide builder uses
 * `git fast-import` (one process per history) + the shared `loadAllObjects` batch
 * loader (one process for ALL object contents) — empirically ~0.5s to build+load a
 * 90-commit/120-file history. Both run through `spawnGit`, so they inherit the pinned
 * identity/clock and the GIT_* env scrub like every other oracle call. Each property logs the REALIZED
 * scale (chain depth, files, nesting, refs, orphan-set size) after `fc.assert` so the
 * deep/wide reach is VISIBLE.
 *
 * Originated as the TDD spec for GC at scale (§4/§8) and ran RED against a throwing
 * stub — the LARGE setup completed and the first `gc()` threw; it now pins the shipped
 * contract.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { PackInputObject } from "@/pack/write-pack"
import { FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import {
	ageObjects,
	countDerivedRows,
	countObjects,
	type GcFixture,
	objectOids,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import { gitReachableOids, loadAllObjects } from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

/**
 * The shape of ONE deep/wide history. `chainDepth` commits, each snapshot holding
 * `files` files nested `nesting` directories deep; `salt` makes every history's
 * blobs/trees/commits (hence OIDs) distinct, so an independent (salted) history
 * seeded without a ref is a GENUINELY unreachable orphan set.
 */
type HistorySpec = {
	chainDepth: number
	files: number
	nesting: number
	salt: number
	/** Extra branch tips forked off the chain — the WIDE-ref axis. Each gets a commit
	 * and a file of its OWN, so its closure is NOT a subset of `main`'s. `main` is
	 * always the chain tip and is never named here. */
	branches?: readonly string[]
}

/** `a/b/c/d/e/file<i>.txt` — a deep nested path so each snapshot tree fans into a
 * long tree→subtree walk (the WIDE+nested axis). `salt` rotates the
 * directory letters so different histories occupy different subtree OIDs. */
function nestedPath(fileIdx: number, nesting: number, salt: number): string {
	const parts: string[] = []
	for (let d = 0; d < nesting; d++) {
		parts.push(String.fromCharCode(97 + ((fileIdx + d + salt) % 5)))
	}
	parts.push(`file${fileIdx}.txt`)
	return parts.join("/")
}

/**
 * A `git fast-import` stream for one deep/wide history on `refs/heads/main`: a
 * `chainDepth`-long commit chain whose first commit writes every file and each
 * later commit mutates ~a third of them (so blobs/trees churn down the chain, the
 * DEEP axis), followed by one commit per extra branch (the WIDE-ref axis). The pinned
 * committer identity/clock keeps OIDs reproducible across a rebuild (STRESS-3).
 * Returns the stream text.
 */
function fastImportStream(spec: HistorySpec): string {
	const out: string[] = ["reset refs/heads/main"]
	for (let c = 0; c < spec.chainDepth; c++) {
		out.push(
			`commit refs/heads/main`,
			`mark :${c + 1}`,
			`committer ${FAST_IMPORT_COMMITTER}`,
		)
		const msg = `commit ${c} salt ${spec.salt}`
		out.push(`data ${Buffer.byteLength(msg)}`, msg)
		if (c > 0) out.push(`from :${c}`)
		for (let f = 0; f < spec.files; f++) {
			// First commit writes all files; later commits mutate a rotating third —
			// enough churn to grow blob/tree versions along the chain (DEEP), bounded
			// so the candidate stays feasible.
			if (c === 0 || f % 3 === c % 3) {
				const content = `file ${f} rev ${c} salt ${spec.salt}\n`
				out.push(`M 100644 inline ${nestedPath(f, spec.nesting, spec.salt)}`)
				out.push(`data ${Buffer.byteLength(content)}`, content)
			}
		}
	}
	// WIDE-ref axis. Each extra branch forks off the chain at a DIFFERENT depth and
	// adds one commit carrying a uniquely-named file, so its tip reaches a blob, a
	// subtree, a root tree and a commit that NO other tip reaches. Branches that were
	// merely `main~k` would each sit wholly inside main's closure, and then dropping
	// every ref but `main` would not change one assertion in this file — the multi-tip
	// live-set materialization would go unexercised while the header advertised it.
	const branches = spec.branches ?? []
	for (const [i, branch] of branches.entries()) {
		out.push(`commit refs/heads/${branch}`, `committer ${FAST_IMPORT_COMMITTER}`)
		const msg = `branch ${branch} salt ${spec.salt}`
		out.push(`data ${Buffer.byteLength(msg)}`, msg)
		// Fork point: mark `chainDepth - (i+1)` is commit index `chainDepth-i-2`, so
		// each branch hangs off the chain a little further back than the last.
		out.push(`from :${Math.max(1, spec.chainDepth - (i + 1))}`)
		const content = `branch ${branch} salt ${spec.salt}\n`
		out.push(`M 100644 inline branches/${branch}.txt`)
		out.push(`data ${Buffer.byteLength(content)}`, content)
	}
	return `${out.join("\n")}\n`
}

/** Feed a fast-import stream into a fresh repo `dir` (one process per history). */
async function fastImport(dir: string, stream: string): Promise<void> {
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: stream })
}

/** Build one deep/wide history on disk (fast-import), load all its objects, capture
 * its main tip, then DISCARD the dir. Returns the objects + the `refs/heads/main`
 * tip oid (for seeding a live ref, or — when seeded ref-less — an orphan set). */
async function buildHistory(
	spec: HistorySpec,
): Promise<{ objects: PackInputObject[]; tip: string }> {
	return withTempDir("pggit-stress-", async (dir) => {
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		await fastImport(dir, fastImportStream(spec))
		const tip = (await spawnGit(["rev-parse", "main"], { cwd: dir })).stdout.trim()
		return { objects: await loadAllObjects(dir), tip }
	})
}

/** The deep/wide branch names — the WIDE-ref axis. `main` is the chain tip; every
 * other name gets its own fork commit and its own file in the same fast-import
 * stream, so each tip contributes objects no other tip reaches. */
const BRANCHES = [
	"main",
	"feature",
	"topic",
	"dev",
	"release",
	"hotfix",
	"staging",
	"canary",
	"legacy",
	"wip",
] as const

/**
 * Build ONE on-disk live repo with a deep chain + wide nested trees + MANY branch
 * refs (each branch forks off the chain and adds a commit of its own, so the closure
 * genuinely spans them), seed its full object set + every branch ref into Postgres
 * under `repo`, then seed several INDEPENDENT (salted) deep/wide histories WITHOUT a
 * ref — the large orphan set GC must reclaim. Returns the on-disk live source dir
 * (the survivor oracle; CALLER cleans it) and the realized scale of the seed.
 *
 * Both stressor axes are ESTABLISHED here rather than advertised: the multi-tip
 * closure must be strictly larger than `main`'s alone, and the orphan seed must be
 * non-empty. Neither has a downstream assertion that would notice its absence.
 */
async function seedDeepWideRepo(
	fx: GcFixture,
	repo: string,
	params: {
		chainDepth: number
		files: number
		nesting: number
		refCount: number
		orphanChains: number
	},
): Promise<{ liveDir: string; orphanObjects: number }> {
	// BRANCHES[0] is `main` (the chain tip itself); the rest fork off it in-stream.
	const refCount = Math.min(params.refCount, BRANCHES.length)
	const extraBranches = BRANCHES.slice(1, refCount)

	const liveDir = mkdtempSync(join(tmpdir(), "pggit-stress-live-"))
	await spawnGit(["init", "-q", "-b", "main"], { cwd: liveDir })
	await fastImport(
		liveDir,
		fastImportStream({
			branches: extraBranches,
			chainDepth: params.chainDepth,
			files: params.files,
			nesting: params.nesting,
			salt: 0,
		}),
	)
	// fast-import wrote every ref, so the tips are read back rather than constructed.
	const liveRefs: { name: string; oid: string }[] = []
	for (const branch of ["main", ...extraBranches]) {
		const oid = (
			await spawnGit(["rev-parse", `refs/heads/${branch}`], { cwd: liveDir })
		).stdout.trim()
		liveRefs.push({ name: `refs/heads/${branch}`, oid })
	}
	// The WIDE-ref axis, established: the all-refs closure must reach objects `main`
	// alone does not, or "the live closure spans many tips" is a claim no assertion
	// in this file can feel.
	const mainClosure = (
		await spawnGit(["rev-list", "--objects", "main"], { cwd: liveDir })
	).stdout
		.trim()
		.split("\n")
		.filter(Boolean).length
	expect(
		(await gitReachableOids(liveDir)).length,
		"the branch tips reach nothing main does not — the WIDE-ref axis is not exercised",
	).toBeGreaterThan(mainClosure)

	await fx.objects.putPack(repo, await loadAllObjects(liveDir))
	for (const ref of liveRefs) await fx.refs.setRef(repo, ref.name, ref.oid)

	// ORPHAN axis: independent salted deep/wide histories, seeded ref-LESS → every
	// one of their objects is genuinely unreachable and must be reclaimed in batches.
	let orphanObjects = 0
	for (let s = 1; s <= params.orphanChains; s++) {
		const orphan = await buildHistory({
			chainDepth: Math.max(2, Math.floor(params.chainDepth / 2)),
			files: Math.max(2, Math.floor(params.files / 2)),
			nesting: params.nesting,
			salt: s,
		})
		await fx.objects.putPack(repo, orphan.objects)
		orphanObjects += orphan.objects.length
	}
	expect(
		orphanObjects,
		"no orphan objects seeded — the multi-batch DELETE stressor never happens",
	).toBeGreaterThan(0)
	return { liveDir, orphanObjects }
}

/** Fetch `refs/heads/main` of `repo` into a throwaway dir and `fsck --full` it
 * (throws on any dangling/corruption) — the integrity half of STRESS-1 over a repo
 * whose file set varies, so it reads no specific file. */
async function fetchAndFsck(fx: Pick<GcFixture, "server">, repo: string): Promise<void> {
	const url = repoUrl(fx, repo)
	await withTempDir("pggit-stress-back-", async (dir) => {
		await spawnGit(["init", "-q"], { cwd: dir })
		await spawnGit(["-c", "protocol.version=2", "fetch", url, "refs/heads/main"], {
			cwd: dir,
		})
		await spawnGit(["fsck", "--full"], { cwd: dir })
	})
}

/**
 * The realized scale of the sampled candidates, folded in per candidate and logged
 * ONCE after `fc.assert` so the deep/wide reach is VISIBLE in the test output (it
 * surfaces the scale, it asserts nothing). `maxOrphans` is the largest single
 * orphan-set reclaimed — the multi-batch DELETE stressor.
 */
type ScaleTally = {
	candidates: number
	maxChainDepth: number
	maxFiles: number
	maxNesting: number
	maxRefs: number
	maxOrphans: number
	maxObjectsSeeded: number
}

function newTally(): ScaleTally {
	return {
		candidates: 0,
		maxChainDepth: 0,
		maxFiles: 0,
		maxNesting: 0,
		maxObjectsSeeded: 0,
		maxOrphans: 0,
		maxRefs: 0,
	}
}

function recordScale(
	t: ScaleTally,
	p: { chainDepth: number; files: number; nesting: number; refs: number },
	orphans: number,
	objectsSeeded: number,
): void {
	t.candidates++
	t.maxChainDepth = Math.max(t.maxChainDepth, p.chainDepth)
	t.maxFiles = Math.max(t.maxFiles, p.files)
	t.maxNesting = Math.max(t.maxNesting, p.nesting)
	t.maxRefs = Math.max(t.maxRefs, p.refs)
	t.maxOrphans = Math.max(t.maxOrphans, orphans)
	t.maxObjectsSeeded = Math.max(t.maxObjectsSeeded, objectsSeeded)
}

function logScale(label: string, t: ScaleTally): void {
	console.log(
		`[gc-stress realized scale] ${label}: candidates=${t.candidates} ` +
			`max-chain-depth=${t.maxChainDepth} max-files=${t.maxFiles} ` +
			`max-nesting=${t.maxNesting} max-refs=${t.maxRefs} ` +
			`max-orphan-objects=${t.maxOrphans} max-objects-seeded=${t.maxObjectsSeeded}`,
	)
}

/**
 * The deep/wide parameter arbitrary. Each candidate is LARGE — the bounds were
 * chosen empirically so a candidate builds+seeds in ~0.5-7s (each candidate carves its
 * own fresh schema on the shared container):
 *   - chainDepth 40-120   (DEEP — tens-of-commits chain; empirically a 90/120
 *                          history loads in ~0.6s and seeds ~6.5k objects)
 *   - files 60-160        (WIDE — tens-to-low-hundreds of files per snapshot)
 *   - nesting 4-7         (DEEP paths — a/b/c/d/e/.. → long tree→subtree chains)
 *   - refCount 5-10       (WIDE refs — the closure spans many tips)
 *   - orphanChains 4-8    (ORPHANS — ~half-size independent histories → ~12k-19k
 *                          unreachable objects, the multi-batch DELETE stressor)
 */
const deepWideParams = fc.record({
	chainDepth: fc.integer({ max: 120, min: 40 }),
	files: fc.integer({ max: 160, min: 60 }),
	nesting: fc.integer({ max: 7, min: 4 }),
	orphanChains: fc.integer({ max: 8, min: 4 }),
	refCount: fc.integer({ max: 10, min: 5 }),
})

// FEW runs — each candidate seeds tens of thousands of rows over a full PG round
// trip; this complements (not replaces) the many-small-candidate PBT-1/2/3. Seed
// pinned (424_242) for determinism, matching the sibling specs.
const NUM_RUNS = 3

describe("§4 PBT stress — deep + wide GC differential at scale", () => {
	// A FRESH schema PER fast-check candidate (`withCandidate` below) on the shared
	// `globalSetup` Postgres container. The stress repos are huge, so seeding many of
	// them into one shared schema would pile every candidate's rows into the next
	// candidate's GC; the accumulated partition then skews the planner's statistics
	// until the sweep's anti-join flips to a per-row nested loop and a single GC blows
	// past the test budget. A fresh schema per candidate keeps each GC's stats
	// representative (and makes the property candidates genuinely independent). Repo
	// names can therefore be fixed — they never collide across candidates (each lives
	// in its own schema).

	/** Run one fast-check candidate against its OWN fresh schema fixture, torn down
	 * (server + schema) afterwards while the shared container keeps running. */
	const withCandidate = async (body: (fx: GcFixture) => Promise<void>): Promise<void> => {
		const fx = await setupGcFixture()
		try {
			await body(fx)
		} finally {
			await teardownGcFixture(fx)
		}
	}

	it("STRESS-1 — survivors == git reachable closure over many tips, deep chain + wide nested trees + large orphan set", async () => {
		const tally = newTally()
		await fc.assert(
			fc.asyncProperty(deepWideParams, async (params) => {
				await withCandidate(async (fx) => {
					const repo = "stress1"
					const { liveDir, orphanObjects } = await seedDeepWideRepo(fx, repo, params)
					try {
						const seeded = await countObjects(fx.db, repo)
						recordScale(
							tally,
							{
								chainDepth: params.chainDepth,
								files: params.files,
								nesting: params.nesting,
								refs: Math.min(params.refCount, BRANCHES.length),
							},
							orphanObjects,
							seeded,
						)
						// Age every row past the grace=0 cutoff so the orphan set is unambiguously
						// reclaimable (deterministic; no wall-clock wait).
						await ageObjects(fx.db, repo, "1 hour")

						await fx.gc.gc(repo, { graceSeconds: 0 })

						// GC reclaimed a LARGE set: the seed carried whole orphan histories, so
						// strictly fewer objects must survive than went in. Without this the
						// equality below is equally satisfied by a candidate whose orphan seed
						// silently never landed — which is exactly what a truncated load looks
						// like from here.
						const survivors = await objectOids(fx.db, repo)
						expect(
							survivors.length,
							"nothing was reclaimed — the orphan set never reached the store",
						).toBeLessThan(seeded)

						// Survivors in Postgres == real-git reachable closure over the on-disk live
						// source (all branch tips + peeled tags). Neither over- nor under-deletes.
						expect(survivors).toEqual(await gitReachableOids(liveDir))
						// And a live ref still fetches fsck-clean end-to-end.
						await fetchAndFsck(fx, repo)
					} finally {
						rmSync(liveDir, { force: true, recursive: true })
					}
				})
			}),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)
		logScale("STRESS-1", tally)
	}, 900_000)

	it("STRESS-2 — idempotence at scale: a second gc() deletes nothing and leaves the survivor set unchanged", async () => {
		const tally = newTally()
		await fc.assert(
			fc.asyncProperty(deepWideParams, async (params) => {
				await withCandidate(async (fx) => {
					const repo = "stress2"
					const { liveDir, orphanObjects } = await seedDeepWideRepo(fx, repo, params)
					try {
						const seeded = await countObjects(fx.db, repo)
						recordScale(
							tally,
							{
								chainDepth: params.chainDepth,
								files: params.files,
								nesting: params.nesting,
								refs: Math.min(params.refCount, BRANCHES.length),
							},
							orphanObjects,
							seeded,
						)
						await ageObjects(fx.db, repo, "1 hour")

						await fx.gc.gc(repo, { graceSeconds: 0 })
						const afterFirst = await objectOids(fx.db, repo)

						// Second pass is a no-op: deletes nothing, leaves rows + survivor set identical.
						const second = await fx.gc.gc(repo, { graceSeconds: 0 })
						expect(second).toEqual({
							deletedObjects: 0,
							epoch: "unchanged",
						})
						expect(await objectOids(fx.db, repo)).toEqual(afterFirst)
					} finally {
						rmSync(liveDir, { force: true, recursive: true })
					}
				})
			}),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)
		logScale("STRESS-2", tally)
	}, 900_000)

	it("STRESS-3 — batch invariance at scale: small vs huge batchLimit converge to the same survivor set", async () => {
		const tally = newTally()
		await fc.assert(
			fc.asyncProperty(deepWideParams, async (params) => {
				await withCandidate(async (fx) => {
					// Two byte-identical large repos: pinned identity + clock → identical OIDs,
					// so the survivor sets are directly comparable across batch sizes. The
					// small-batchLimit run (256) still crosses the multi-batch DELETE boundary
					// many times (~hundreds of batches at this scale); `1` is avoided because it
					// is O(orphans × survivors) — every one-row batch rescans the live set to
					// find the next victim — and is far smaller than anything production uses
					// (the drain's default is 10_000).
					const repoSmall = "stress3-small"
					const repoHuge = "stress3-huge"
					const small = await seedDeepWideRepo(fx, repoSmall, params)
					const huge = await seedDeepWideRepo(fx, repoHuge, params)
					try {
						const seeded = await countObjects(fx.db, repoSmall)
						recordScale(
							tally,
							{
								chainDepth: params.chainDepth,
								files: params.files,
								nesting: params.nesting,
								refs: Math.min(params.refCount, BRANCHES.length),
							},
							small.orphanObjects,
							seeded,
						)
						await ageObjects(fx.db, repoSmall, "1 hour")
						await ageObjects(fx.db, repoHuge, "1 hour")

						await fx.gc.gc(repoSmall, { batchLimit: 256, graceSeconds: 0 })
						await fx.gc.gc(repoHuge, { batchLimit: 1_000_000, graceSeconds: 0 })

						// Same final observable state regardless of batch size: identical survivor
						// OIDs (the two seeds are byte-identical) AND identical row counts.
						const survivorsSmall = await objectOids(fx.db, repoSmall)
						expect(survivorsSmall).toEqual(await objectOids(fx.db, repoHuge))
						expect(await countObjects(fx.db, repoSmall)).toEqual(
							await countObjects(fx.db, repoHuge),
						)
						expect(await countDerivedRows(fx.db, repoSmall)).toEqual(
							await countDerivedRows(fx.db, repoHuge),
						)
						// And the survivor set is exactly git's reachable closure (anchors invariance
						// to the correct answer, not merely "both batches did the same wrong thing").
						expect(survivorsSmall).toEqual(await gitReachableOids(small.liveDir))
					} finally {
						rmSync(small.liveDir, { force: true, recursive: true })
						rmSync(huge.liveDir, { force: true, recursive: true })
					}
				})
			}),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)
		logScale("STRESS-3", tally)
	}, 900_000)
})

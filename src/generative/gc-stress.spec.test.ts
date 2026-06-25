/**
 * Property-based GC STRESS differential (`docs/2026-06-24-force-commit-gc-design.md`
 * §4, §8). The existing PBT-1/2/3 (`gc.spec.test.ts`) sample MANY SMALL repos
 * (~25 commands). This file is the complement: FEW fast-check runs, each candidate
 * a DEEP + WIDE repo with a LARGE orphan set, so GC's batched DELETE + anti-join,
 * the `git_edge` recursion, and the blob-from-tree enumeration are all exercised at
 * scale. It does NOT replace the small-candidate properties — it stresses the axes
 * they cannot reach.
 *
 *   DEEP — a long commit CHAIN (tens of commits) seeded as one history, so the
 *          reachable closure walks a deep kind-2 (commit-parent) edge chain.
 *   WIDE — large NESTED trees: tens-to-low-hundreds of files across a deep
 *          directory nesting (`a/b/c/d/e/file.txt`), so each snapshot fans into a
 *          long kind-3 (tree→subtree) edge chain and a wide blob set; PLUS many
 *          refs/branches, so the reachable closure and the live-set materialization
 *          are wide.
 *   ORPHANS — many INDEPENDENT deep/wide histories are seeded into Postgres WITHOUT
 *          a ref (and, for the force-commit half, prior force-committed snapshots),
 *          so GC has a large genuinely-unreachable set to reclaim in MANY batches.
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
 *              `{deletedObjects:0, deletedEdges:0}` and leaves the survivor set
 *              unchanged. Generalises GC-6 at scale.
 *   STRESS-3 — Batch invariance at scale.  On two byte-identical large repos
 *              (pinned identity + clock → identical OIDs), `gc(batchLimit: small)`
 *              and `gc(batchLimit: huge)` converge to the SAME survivor set — the
 *              key reason a deep/wide test matters: it crosses the multi-batch
 *              DELETE boundary many times. Generalises GC-10 at scale.
 *
 * OBSERVABLE-ONLY: assertions read only the real-`git` oracle (`rev-list` / fetch /
 * fsck), Postgres rows (`objectOids` / `countObjects` / `countEdges`), and the
 * `gc()` return value. Nothing probes GC internals (temp tables, batch/CTE/txn
 * shape, advisory locks). Grace is made deterministic by `ageObjects` +
 * `graceSeconds: 0`, never a wall-clock sleep.
 *
 * PERFORMANCE: each candidate is a full PG round-trip seeding tens of thousands of
 * rows, so the run counts are deliberately TINY (`NUM_RUNS`) and the seed is pinned
 * (424_242) for determinism, matching the sibling specs. The deep/wide builder uses
 * `git fast-import` (one process per history) + a single `cat-file --batch` loader
 * (one process for ALL object contents) — empirically ~0.5s to build+load a
 * 90-commit/120-file history vs ~128s for a per-object `cat-file` spawn loop, which
 * is why a bespoke builder exists rather than `buildRepoFromCommands` /
 * `loadAllObjects`. Each property logs the REALIZED scale (chain depth, files,
 * nesting, refs, orphan-set size) after `fc.assert` so the deep/wide reach is
 * VISIBLE.
 *
 * RED until GC is implemented: the LARGE setup (build + seed) COMPLETES, then the
 * first `gc()` call throws the TDD stub's "pggit gc: not implemented (TDD stub)".
 * Each property goes green once GC honours the §4 contract. No assertion is weakened.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitObjectType } from "@/object/object"
import type { PackInputObject } from "@/pack/write-pack"
import {
	ageObjects,
	countEdges,
	countObjects,
	type GcFixture,
	gcFixtureOnContainer,
	gitReachableOids,
	objectOids,
	repoUrl,
	teardownGcSchema,
} from "@/testing/gc-helpers"
import { startPostgres } from "@/testing/pg"
import { PINNED_DATE, PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

// fast-import's committer line wants `<unix-seconds> <tz>`, NOT git's `@<seconds>`
// env form, but the OID-pinning identity must be byte-identical to PINNED_DATE so a
// rebuilt repo (STRESS-3) yields the same OIDs. PINNED_DATE is `@1700000000 +0000`;
// strip the leading `@` for the fast-import `committer` line.
const FI_WHEN = PINNED_DATE.replace(/^@/, "")
const FI_COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${FI_WHEN}`

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
}

/** `a/b/c/d/e/file<i>.txt` — a deep nested path so each snapshot tree fans into a
 * long kind-3 (tree→subtree) edge chain (the WIDE+nested axis). `salt` rotates the
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
 * DEEP axis). The pinned committer identity/clock keeps OIDs reproducible across a
 * rebuild (STRESS-3). Returns the stream text.
 */
function fastImportStream(spec: HistorySpec): string {
	const out: string[] = ["reset refs/heads/main"]
	for (let c = 0; c < spec.chainDepth; c++) {
		out.push(`commit refs/heads/main`, `mark :${c + 1}`, `committer ${FI_COMMITTER}`)
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
	return `${out.join("\n")}\n`
}

/** Feed a fast-import stream into a fresh repo `dir` (one process per history). */
function fastImport(dir: string, stream: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn("git", ["fast-import", "--quiet"], { cwd: dir })
		const err: Buffer[] = []
		child.stderr.on("data", (d: Buffer) => err.push(d))
		child.on("error", reject)
		child.on("close", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`fast-import exited ${code}: ${Buffer.concat(err)}`)),
		)
		child.stdin.write(stream)
		child.stdin.end()
	})
}

/**
 * Load EVERY object of a repo as pack inputs through a SINGLE `cat-file --batch`
 * process — the scale-critical alternative to `loadAllObjects` (which spawns one
 * `git` per object: ~128s for 6.5k objects vs ~120ms here). The `--batch` stream is
 * `<oid> <type> <size>\n<raw bytes>\n` per object; binary-safe (sizes drive the
 * cut, never newlines). Idempotent re-seeds in pggit dedupe by OID, so loading the
 * full object set (reachable + churned) is exactly the orphan-bearing seed GC must
 * reclaim down to the reachable closure.
 */
function loadAllObjectsBatched(dir: string): Promise<PackInputObject[]> {
	return new Promise<PackInputObject[]>((resolve, reject) => {
		const list = spawn("git", [
			"-C",
			dir,
			"cat-file",
			"--batch-all-objects",
			"--batch-check=%(objectname)",
		])
		const idChunks: Buffer[] = []
		list.stdout.on("data", (d: Buffer) => idChunks.push(d))
		list.on("error", reject)
		list.on("close", () => {
			const oids = Buffer.concat(idChunks).toString("utf8").trim().split("\n")
			const cat = spawn("git", ["-C", dir, "cat-file", "--batch"])
			const chunks: Buffer[] = []
			cat.stdout.on("data", (d: Buffer) => chunks.push(d))
			cat.on("error", reject)
			cat.on("close", () => {
				const buf = Buffer.concat(chunks)
				const objs: PackInputObject[] = []
				let pos = 0
				while (pos < buf.length) {
					const nl = buf.indexOf(0x0a, pos)
					const [, type, sizeStr] = buf.toString("utf8", pos, nl).split(" ")
					const size = Number.parseInt(sizeStr ?? "", 10)
					const start = nl + 1
					objs.push({
						content: buf.subarray(start, start + size),
						type: type as GitObjectType,
					})
					pos = start + size + 1 // skip the record's trailing LF
				}
				resolve(objs)
			})
			for (const oid of oids) cat.stdin.write(`${oid}\n`)
			cat.stdin.end()
		})
	})
}

/** Build one deep/wide history on disk (fast-import), load all its objects, capture
 * its main tip, then DISCARD the dir. Returns the objects + the `refs/heads/main`
 * tip oid (for seeding a live ref, or — when seeded ref-less — an orphan set). */
async function buildHistory(
	spec: HistorySpec,
): Promise<{ objects: PackInputObject[]; tip: string }> {
	const dir = mkdtempSync(join(tmpdir(), "pggit-stress-"))
	try {
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		await fastImport(dir, fastImportStream(spec))
		const tip = (await spawnGit(["rev-parse", "main"], { cwd: dir })).stdout.trim()
		return { objects: await loadAllObjectsBatched(dir), tip }
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

/** The deep/wide branch names — the WIDE-ref axis. One live history is published
 * under several of these (each branch a window onto the same chain at a different
 * depth), so the reachable closure spans many ref tips. */
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
 * refs (each branch points at a distinct commit along the chain so the closure
 * genuinely spans them), seed its full object set + every branch ref into Postgres
 * under `repo`, then seed several INDEPENDENT (salted) deep/wide histories WITHOUT a
 * ref — the large orphan set GC must reclaim. Returns the on-disk live source dir
 * (the survivor oracle; CALLER cleans it) and the realized scale of the seed.
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
	const liveDir = mkdtempSync(join(tmpdir(), "pggit-stress-live-"))
	await spawnGit(["init", "-q", "-b", "main"], { cwd: liveDir })
	await fastImport(
		liveDir,
		fastImportStream({
			chainDepth: params.chainDepth,
			files: params.files,
			nesting: params.nesting,
			salt: 0,
		}),
	)
	// WIDE-ref axis: branch `refCount` names off commits spread along the chain, so
	// the live closure spans many tips (not all reaching the same single tip).
	const refCount = Math.min(params.refCount, BRANCHES.length)
	const liveRefs: { name: string; oid: string }[] = []
	for (let i = 0; i < refCount; i++) {
		const branch = BRANCHES[i] ?? "main"
		// Commit `chainDepth - 1 - i` (clamped): `main` = tip, later branches sit a
		// few commits back, so dropping none still spans distinct closures per tip.
		const depthBack = Math.min(i, params.chainDepth - 1)
		const oid = (
			await spawnGit(["rev-parse", `main~${depthBack}`], { cwd: liveDir })
		).stdout.trim()
		liveRefs.push({ name: `refs/heads/${branch}`, oid })
	}
	// Materialize every branch on disk too, so the on-disk oracle's `--all` closure
	// matches exactly what Postgres holds as live (the STRESS-1 differential).
	for (const ref of liveRefs) {
		const branch = ref.name.replace("refs/heads/", "")
		if (branch !== "main") {
			await spawnGit(["branch", branch, ref.oid], { cwd: liveDir })
		}
	}

	await fx.objects.putPack(repo, await loadAllObjectsBatched(liveDir))
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
	return { liveDir, orphanObjects }
}

/** Fetch `refs/heads/main` of `repo` into a throwaway dir and `fsck --full` it
 * (throws on any dangling/corruption) — the integrity half of STRESS-1 over a repo
 * whose file set varies, so it reads no specific file. */
async function fetchAndFsck(fx: Pick<GcFixture, "server">, repo: string): Promise<void> {
	const url = repoUrl(fx, repo)
	const dir = mkdtempSync(join(tmpdir(), "pggit-stress-back-"))
	try {
		await spawnGit(["init", "-q"], { cwd: dir })
		await spawnGit(["-c", "protocol.version=2", "fetch", url, "refs/heads/main"], {
			cwd: dir,
		})
		await spawnGit(["fsck", "--full"], { cwd: dir })
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
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
 * chosen empirically so a candidate builds+seeds in ~0.5-7s (one container-up cost
 * amortized across the few runs):
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
	// ONE container for the whole suite, but a FRESH schema PER fast-check candidate
	// (`withCandidate` below). The stress repos are huge, so seeding many of them into
	// one shared schema would pile every candidate's rows into the next candidate's GC;
	// the accumulated partition then skews the planner's statistics until the sweep's
	// anti-join flips to a per-row nested loop and a single GC blows past the test
	// budget. A fresh schema per candidate keeps each GC's stats representative (and
	// makes the property candidates genuinely independent). Repo names can therefore be
	// fixed — they never collide across candidates (each lives in its own schema).
	let container: StartedPostgreSqlContainer

	beforeAll(async () => {
		container = await startPostgres()
	}, 180_000)

	afterAll(async () => {
		await container.stop()
	})

	/** Run one fast-check candidate against its OWN fresh schema fixture, torn down
	 * (server + schema) afterwards while the shared container keeps running. */
	const withCandidate = async (body: (fx: GcFixture) => Promise<void>): Promise<void> => {
		const fx = await gcFixtureOnContainer(container)
		try {
			await body(fx)
		} finally {
			await teardownGcSchema(fx)
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

						// Survivors in Postgres == real-git reachable closure over the on-disk live
						// source (all branch tips + peeled tags). Neither over- nor under-deletes.
						expect(await objectOids(fx.db, repo)).toEqual(await gitReachableOids(liveDir))
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
						expect(second).toEqual({ deletedEdges: 0, deletedObjects: 0 })
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
						// OIDs (the two seeds are byte-identical) AND identical row/edge counts.
						const survivorsSmall = await objectOids(fx.db, repoSmall)
						expect(survivorsSmall).toEqual(await objectOids(fx.db, repoHuge))
						expect(await countObjects(fx.db, repoSmall)).toEqual(
							await countObjects(fx.db, repoHuge),
						)
						expect(await countEdges(fx.db, repoSmall)).toEqual(
							await countEdges(fx.db, repoHuge),
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

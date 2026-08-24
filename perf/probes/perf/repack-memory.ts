/**
 * PROBE: `createRepack`'s content cache is unbounded, so the pass holds roughly
 * the repo's tree bytes in memory. How big must a repo be
 * before one offline pass in the platform process needs gigabytes, and how does
 * that compare to what real `git repack -adf` needs for the same job?
 *
 * Shape: ONE wide flat directory (20k entries ⇒ ~0.8 MB per tree version) edited
 * by M commits — tree BYTES grow fast while the object COUNT stays flat.
 *
 * Memory is measured the only honest way: the repack runs in a FRESH child
 * process under `/usr/bin/time -l`, so the number is the OS's peak RSS for a
 * process that does nothing but connect and repack — directly comparable to the
 * `/usr/bin/time -l git repack -adf` number beside it. A no-op child measures the
 * interpreter floor, which is subtracted.
 *
 * Run it from the repo root: the child is re-invoked by the path in `SELF`, and
 * the parent's resolved `--pg=` is forwarded so both halves reach the same server.
 *
 *   NODE_OPTIONS=--expose-gc npx tsx perf/probes/perf/repack-memory.ts [--commits=100,200,400]
 */
import { rmSync } from "node:fs"
import {
	increasingIntegerListArg,
	nonemptyStringArg,
	parseArgs,
	pgUrlArg,
	positiveIntegerArg,
} from "@perf/args"
import { table } from "@perf/probes/_table"
import {
	cleanupTmp,
	gitRepack,
	importRepo,
	mb,
	secs,
	seedRepo,
	timedSpawn,
} from "@perf/probes/perf/_util"
import postgres from "postgres"
import { z } from "zod"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { createRepack } from "@/store/repack"
import { FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	gitObjectInventory,
	loadAllReachableObjects,
	repackEligibleObjects,
	requiredAt,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO_ID = "probe/mem"
/** Peak RSS above git's at which this is called broken. */
const RSS_RATIO_LIMIT = 2
const DEFAULT_WIDTH = 20_000
const DEFAULT_COMMITS = [100, 200, 400]

const parentArgs = z
	.object({
		commits: increasingIntegerListArg(DEFAULT_COMMITS),
		pg: pgUrlArg,
		width: positiveIntegerArg.default(DEFAULT_WIDTH),
	})
	.strict()
	.transform(({ commits, pg, width }) => ({
		commits,
		mode: "parent" as const,
		pg,
		width,
	}))

const childArgs = z
	.object({
		"child-mode": z.enum(["noop", "repack"]),
		"child-schema": nonemptyStringArg,
		pg: pgUrlArg,
	})
	.strict()
	.transform((raw) => ({
		childMode: raw["child-mode"],
		mode: "child" as const,
		pg: raw.pg,
		schema: raw["child-schema"],
	}))

const args = parseArgs(z.union([childArgs, parentArgs]))
type ChildArgs = Extract<typeof args, { mode: "child" }>
type ParentArgs = Extract<typeof args, { mode: "parent" }>

// ── child mode: connect to one schema, repack once, print the numbers ────────
async function runChild({ childMode, pg, schema }: ChildArgs): Promise<void> {
	const sql = postgres(pg, {
		connection: { search_path: schema },
		max: 4,
		onnotice: () => {},
	})
	try {
		if (childMode === "repack") {
			const t0 = Date.now()
			const r = await createRepack(sql).repack(REPO_ID)
			const [objects, eligible, encodings] = await Promise.all([
				sql<{ n: string }[]>`select count(*)::text as n from git_object`,
				sql<{ n: string }[]>`
					select count(*)::text as n from git_object where size < ${MAX_INLINE_BYTEA_BYTES}`,
				sql<{ n: string }[]>`select count(*)::text as n from git_pack_encoding`,
			])
			const objectCount = Number(requiredAt(objects, 0, "child object census").n)
			const eligibleCount = Number(requiredAt(eligible, 0, "child eligibility census").n)
			const encodingCount = Number(requiredAt(encodings, 0, "child encoding census").n)
			if (
				!Number.isSafeInteger(objectCount) ||
				objectCount <= 0 ||
				!Number.isSafeInteger(eligibleCount) ||
				eligibleCount <= 0 ||
				!Number.isSafeInteger(encodingCount) ||
				encodingCount <= 0 ||
				r.wholes + r.deltas !== eligibleCount ||
				r.deltas <= 0 ||
				encodingCount !== eligibleCount
			) {
				throw new Error(
					`repack coverage: receipt=${r.wholes} wholes + ${r.deltas} deltas, rows=${encodingCount}, eligible=${eligibleCount}, objects=${objectCount}`,
				)
			}
			console.log(`child: ${r.wholes}w+${r.deltas}d in ${Date.now() - t0}ms`)
		}
	} finally {
		await sql.end()
	}
}

function stream(commits: number, width: number): string {
	const out: string[] = []
	let mark = 0
	const changes: string[] = []
	for (let i = 0; i < width; i++) {
		const m = ++mark
		const body = `v0-${i}\n`
		out.push(`blob\nmark :${m}\ndata ${body.length}\n${body}\n`)
		changes.push(`M 100644 :${m} wide/f${String(i).padStart(6, "0")}.txt`)
	}
	let prev = ++mark
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nseed\n${changes.join("\n")}\n`,
	)
	for (let c = 0; c < commits; c++) {
		const m = ++mark
		const body = `v${c + 1}-${c}\n`
		out.push(`blob\nmark :${m}\ndata ${body.length}\n${body}\n`)
		const cm = ++mark
		const msg = `c${c}`
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${prev}\n` +
				`M 100644 :${m} wide/f${String(c % width).padStart(6, "0")}.txt\n`,
		)
		prev = cm
	}
	return out.join("")
}

/** Total bytes by object type, WITHOUT holding any content in the harness. */
async function bytesByType(dir: string): Promise<Map<string, number>> {
	const totals = new Map<string, number>()
	for (const { size, type } of (await gitObjectInventory(dir)).values()) {
		totals.set(type, (totals.get(type) ?? 0) + size)
	}
	return totals
}

const SELF = "perf/probes/perf/repack-memory.ts"
const ROOT = process.cwd()

async function main({ commits: commitCounts, pg, width }: ParentArgs): Promise<void> {
	// The interpreter floor: same child, same imports, no repack.
	const floorDb = await createIsolatedSchema(pg)
	let floor: Awaited<ReturnType<typeof timedSpawn>>
	try {
		floor = await timedSpawn(
			"npx",
			[
				"tsx",
				SELF,
				`--child-schema=${floorDb.schema}`,
				"--child-mode=noop",
				`--pg=${pg}`,
			],
			ROOT,
		)
	} finally {
		await floorDb.drop()
	}
	if (floor.ms <= 0 || floor.peakRss <= 0) {
		throw new Error(
			`interpreter-floor measurement invalid: ms=${floor.ms}, peak=${floor.peakRss}`,
		)
	}

	const rows: (string | number)[][] = []
	let worst = 0
	let worstShare = 0

	for (const commits of commitCounts) {
		const dir = await importRepo(`mem-${commits}`, stream(commits, width))
		try {
			const commitCount = Number(
				(
					await spawnGit(["rev-list", "--count", "refs/heads/main"], { cwd: dir })
				).stdout.trim(),
			)
			const fileCount = (
				await spawnGit(["ls-tree", "-r", "--name-only", "refs/heads/main"], { cwd: dir })
			).stdout
				.trim()
				.split("\n")
				.filter(Boolean).length
			if (commitCount !== commits + 1 || fileCount !== width) {
				throw new Error(
					`canonical fixture shape mismatch: commits=${commitCount}/${commits + 1}, files=${fileCount}/${width}`,
				)
			}
			const totals = await bytesByType(dir)
			const treeBytes = totals.get("tree")
			if (treeBytes === undefined || treeBytes <= 0) {
				throw new Error("canonical fixture contains no tree bytes")
			}
			const git = await gitRepack(dir, `mem-git-${commits}`)
			if (git.ms <= 0 || git.peakRss <= 0) {
				throw new Error("git repack wall/peak-RSS measurement missing")
			}
			const db = await createIsolatedSchema(pg)
			try {
				const seeded = await seedRepo(db.sql, REPO_ID, dir)
				if (seeded.objects <= 0) throw new Error("fixture seeded no objects")
				const child = await timedSpawn(
					"npx",
					[
						"tsx",
						SELF,
						`--child-schema=${db.schema}`,
						"--child-mode=repack",
						`--pg=${pg}`,
					],
					ROOT,
				)
				if (child.ms <= 0) throw new Error(`child repack took ${child.ms}ms`)
				if (child.peakRss <= floor.peakRss) {
					throw new Error(
						`repack child peak ${child.peakRss} did not exceed interpreter floor ${floor.peakRss}`,
					)
				}
				const canonicalObjects = await loadAllReachableObjects(dir)
				await assertCanonicalStoreFixture(db.sql, REPO_ID, {
					encodings: {
						kind: "exact",
						objects: repackEligibleObjects(canonicalObjects),
					},
					objects: canonicalObjects,
					refs: await canonicalStoreRefsOf(dir),
				})
				const rss = child.peakRss - floor.peakRss
				const ratio = rss / git.peakRss
				const share = rss / treeBytes
				worst = Math.max(worst, ratio)
				worstShare = Math.max(worstShare, share)
				rows.push([
					commits,
					seeded.objects,
					mb(treeBytes),
					secs(child.ms),
					mb(child.peakRss),
					mb(rss),
					`${share.toFixed(2)}×`,
					secs(git.ms),
					mb(git.peakRss),
					`${ratio.toFixed(1)}×`,
				])
			} finally {
				await db.drop()
			}
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}

	console.log(`# repack memory — one ${width}-entry flat directory, M commits\n`)
	console.log(
		`interpreter floor (same child, no repack): ${mb(floor.peakRss)} MB peak RSS\n`,
	)
	console.log(
		table(
			[
				"commits",
				"objects",
				"tree MB",
				"repack s",
				"child peak RSS MB",
				"minus floor",
				"RSS / tree bytes",
				"git repack s",
				"git peak RSS MB",
				"pggit/git RSS",
			],
			rows,
		),
	)
	console.log(
		`\nFAIL CONDITION: repack's peak RSS > ${RSS_RATIO_LIMIT}× what git needs for the same repack.`,
	)
	console.log(
		`observed: worst ${worst.toFixed(1)}× git; repack resident ≈ ${worstShare.toFixed(2)}× the repo's tree bytes`,
	)
	if (worst > RSS_RATIO_LIMIT) process.exitCode = 1
}

const run = args.mode === "child" ? runChild(args) : main(args)
run
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

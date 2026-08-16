/**
 * PROBE: `createRepack`'s content cache is unbounded (design concern C1 — "the
 * pass holds roughly the repo's tree bytes in memory"). How big must a repo be
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
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--repack-memory.ts [--commits=100,200,400]
 */
import { rmSync } from "node:fs"
import postgres from "postgres"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"
import {
	cleanupTmp,
	flag,
	gitRepack,
	importRepo,
	mb,
	PG_URL,
	secs,
	seedRepo,
	table,
	timedSpawn,
} from "./_perf-util"

const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const WIDTH = Number(flag("width", "20000"))
const COMMITS = flag("commits", "100,200,400").split(",").map(Number)
const REPO_ID = "probe/mem"
/** Peak RSS above git's at which this is called broken. */
const RSS_RATIO_LIMIT = 2

// ── child mode: connect to one schema, repack once, print the numbers ────────
const childSchema = process.argv.find((a) => a.startsWith("--child="))?.slice(8)
if (childSchema !== undefined) {
	const sql = postgres(PG_URL, {
		connection: { search_path: childSchema },
		max: 4,
		onnotice: () => {},
	})
	if (!process.argv.includes("--noop")) {
		const t0 = Date.now()
		const r = await createRepack(sql).repack(REPO_ID)
		console.log(`child: ${r.wholes}w+${r.deltas}d in ${Date.now() - t0}ms`)
	}
	await sql.end()
	process.exit(0)
}

function stream(commits: number): string {
	const out: string[] = []
	let mark = 0
	const changes: string[] = []
	for (let i = 0; i < WIDTH; i++) {
		const m = ++mark
		const body = `v0-${i}\n`
		out.push(`blob\nmark :${m}\ndata ${body.length}\n${body}\n`)
		changes.push(`M 100644 :${m} wide/f${String(i).padStart(6, "0")}.txt`)
	}
	let prev = ++mark
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${changes.join("\n")}\n`,
	)
	for (let c = 0; c < commits; c++) {
		const m = ++mark
		const body = `v${c + 1}-${c}\n`
		out.push(`blob\nmark :${m}\ndata ${body.length}\n${body}\n`)
		const cm = ++mark
		const msg = `c${c}`
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${prev}\n` +
				`M 100644 :${m} wide/f${String(c % WIDTH).padStart(6, "0")}.txt\n`,
		)
		prev = cm
	}
	return out.join("")
}

/** Total bytes by object type, WITHOUT holding any content in the harness. */
async function bytesByType(dir: string): Promise<Map<string, number>> {
	const out = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectsize)"],
		{ cwd: dir },
	)
	const totals = new Map<string, number>()
	for (const line of out.stdout.split("\n")) {
		const [type, size] = line.split(" ")
		if (!type || !size) continue
		totals.set(type, (totals.get(type) ?? 0) + Number(size))
	}
	return totals
}

const SELF = "perf/breakage/perf--repack-memory.ts"
const ROOT = process.cwd()

async function main(): Promise<void> {
	// The interpreter floor: same child, same imports, no repack.
	const floorDb = await createIsolatedSchema(PG_URL)
	const floor = await timedSpawn(
		"npx",
		["tsx", SELF, `--child=${floorDb.schema}`, `--pg=${PG_URL}`, "--noop"],
		ROOT,
	)
	await floorDb.drop()

	const rows: (string | number)[][] = []
	let worst = 0
	let worstShare = 0

	for (const commits of COMMITS) {
		const dir = await importRepo(`mem-${commits}`, stream(commits))
		try {
			const totals = await bytesByType(dir)
			const treeBytes = totals.get("tree") ?? 0
			const git = await gitRepack(dir, `mem-git-${commits}`)
			const db = await createIsolatedSchema(PG_URL)
			try {
				const seeded = await seedRepo(db.sql, REPO_ID, dir)
				const child = await timedSpawn(
					"npx",
					["tsx", SELF, `--child=${db.schema}`, `--pg=${PG_URL}`],
					ROOT,
				)
				if (child.code !== 0) throw new Error(`child repack exited ${child.code}`)
				const rss = child.peakRss - floor.peakRss
				const ratio = rss / Math.max(git.peakRss, 1)
				const share = rss / Math.max(treeBytes, 1)
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

	console.log(`# repack memory — one ${WIDTH}-entry flat directory, M commits\n`)
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

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

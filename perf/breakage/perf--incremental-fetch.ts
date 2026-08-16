/**
 * PROBE: what does ONE incremental fetch cost after the encoding tier exists, and
 * does that cost depend on how much history the client already has?
 *
 * A client that is one commit behind should pay for one commit. `buildPack`
 * computes the FULL reachable closure of the wants AND the full closure of the
 * haves on every fetch, then LEFT JOINs the encoding table per batch — so the
 * suspicion is that a one-commit fetch costs O(whole repo).
 *
 * Both sides are driven identically: all objects exist server-side up front, the
 * ref is walked forward one commit at a time, and a real `git fetch` runs after
 * each step — against pggit's wire server, and against canonical git serving the
 * same objects over `file://` (upload-pack). Every object already carries an
 * encoding row (a full repack runs first), so this measures the serve path only.
 *
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--incremental-fetch.ts [--sizes=250,500,1000,2000]
 */
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { serveOnPort } from "@/server"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { cleanupTmp, flag, mb, mkTmp, PG_URL, secs, seedRepo, table } from "./_perf-util"

const SIZES = flag("sizes", "250,500,1000,2000").split(",").map(Number)
/** Incremental steps measured per size (the last N commits are held back). */
const STEPS = 8
/** pggit/git per-fetch latency ratio at which this is called broken. */
const RATIO_LIMIT = 5

const median = (xs: number[]): number =>
	[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
/** The least contention-polluted statistic on a loaded machine: the best case. */
const best = (xs: number[]): number => Math.min(...xs)

type Row = {
	n: number
	objects: number
	pggitMs: number
	pggitBest: number
	gitMs: number
	gitBest: number
	packBytes: number
	closureShare: number
}

async function measure(n: number): Promise<Row> {
	const src = await createAppendOnlyRepo({ docs: 8, runs: n })
	try {
		const commits = await commitsOldestFirst(src)
		const start = commits.length - STEPS - 1
		const tip = (i: number): string => commits[start + i] as string

		// --- canonical git: a bare repo holding every object, ref rewound ----
		const gitRemote = join(mkTmp(`inc-git-${n}`), "remote.git")
		await spawnGit(["clone", "--bare", "-q", src, gitRemote], { cwd: "/tmp" })
		await spawnGit(["update-ref", "refs/heads/main", tip(0)], { cwd: gitRemote })
		const gitClient = join(mkTmp(`inc-gitc-${n}`), "c")
		await spawnGit(["clone", "-q", "--no-local", `file://${gitRemote}`, gitClient], {
			cwd: "/tmp",
		})
		const gitFetches: number[] = []
		for (let i = 1; i <= STEPS; i++) {
			await spawnGit(["update-ref", "refs/heads/main", tip(i)], { cwd: gitRemote })
			const t0 = Date.now()
			await spawnGit(["fetch", "-q", "origin"], { cwd: gitClient })
			gitFetches.push(Date.now() - t0)
		}

		// --- pggit: same objects, same walk ---------------------------------
		const db = await createIsolatedSchema(PG_URL)
		try {
			const seeded = await seedRepo(db.sql, "probe/inc", src)
			await createRepack(db.sql).repack("probe/inc")
			const refs = createRefStore(db.sql)
			await refs.setRef("probe/inc", "refs/heads/main", tip(0))
			const server = await serveOnPort(
				createGitApp(createGitDeps(db.sql), { instrument: true }),
				0,
			)
			const client = join(mkTmp(`inc-pggit-${n}`), "c")
			mkdirSync(client, { recursive: true })
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				`http://127.0.0.1:${server.port}/probe/inc`,
				client,
			])
			const pggitFetches: number[] = []
			const packs: number[] = []
			const closures: number[] = []
			for (let i = 1; i <= STEPS; i++) {
				await refs.setRef("probe/inc", "refs/heads/main", tip(i))
				resetCollected()
				const t0 = Date.now()
				await spawnGit(["-c", "protocol.version=2", "fetch", "-q", "origin"], {
					cwd: client,
				})
				pggitFetches.push(Date.now() - t0)
				const run = collectedRuns().find((r) => r.label === "fetch")
				packs.push(run?.counters.get("packBytes") ?? 0)
				const closure = run?.phaseMs.get("closure") ?? 0
				const encode = run?.phaseMs.get("pack-encode") ?? 0
				closures.push(closure / Math.max(closure + encode, 1))
			}
			await server.close()
			return {
				closureShare: median(closures),
				gitBest: best(gitFetches),
				gitMs: median(gitFetches),
				n,
				objects: seeded.objects,
				packBytes: median(packs),
				pggitBest: best(pggitFetches),
				pggitMs: median(pggitFetches),
			}
		} finally {
			await db.drop()
		}
	} finally {
		rmSync(src, { force: true, recursive: true })
	}
}

async function main(): Promise<void> {
	const rows: Row[] = []
	for (const n of SIZES) rows.push(await measure(n))

	console.log("# incremental fetch: one commit behind, N commits of history\n")
	console.log(
		table(
			[
				"commits",
				"objects",
				"pggit fetch ms (best)",
				"pggit (median)",
				"git fetch ms (best)",
				"git (median)",
				"pggit/git best",
				"pack KB",
				"closure share of server time",
			],
			rows.map((r) => [
				r.n + 1,
				r.objects,
				r.pggitBest,
				r.pggitMs,
				r.gitBest,
				r.gitMs,
				`${(r.pggitBest / Math.max(r.gitBest, 1)).toFixed(1)}×`,
				(r.packBytes / 1000).toFixed(1),
				`${(r.closureShare * 100).toFixed(0)}%`,
			]),
		),
	)

	const exps: (string | number)[][] = []
	for (let i = 1; i < rows.length; i++) {
		const a = rows[i - 1] as Row
		const b = rows[i] as Row
		const k = Math.log2(b.n / a.n)
		exps.push([
			`${a.n}→${b.n}`,
			(Math.log2(b.pggitBest / a.pggitBest) / k).toFixed(2),
			(Math.log2(b.gitBest / Math.max(a.gitBest, 1)) / k).toFixed(2),
		])
	}
	console.log(
		"\n## latency exponent in history length, best-case fetches (0 = flat, 1 = linear)\n",
	)
	console.log(table(["step", "pggit exp", "git exp"], exps))

	const last = rows[rows.length - 1] as Row
	const ratio = last.pggitBest / Math.max(last.gitBest, 1)
	console.log(
		`\nFAIL CONDITION: a one-commit fetch costs > ${RATIO_LIMIT}× canonical git's, or grows with history length.`,
	)
	console.log(`observed: ${ratio.toFixed(1)}× at ${last.n + 1} commits`)
	if (ratio > RATIO_LIMIT) process.exitCode = 1
	console.log(`(median pack ${mb(last.packBytes)} MB, wall ${secs(last.pggitMs)}s)`)
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

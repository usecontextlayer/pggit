/**
 * PROBE: what does ONE incremental fetch cost after the encoding tier exists, and
 * does that cost depend on how much history the client already has?
 *
 * A client that is one commit behind should pay for one commit. The derived-state
 * spine routes haveful fetches through the frontier and computes same-path warm
 * tree deltas against the boundary; this is the standing regression gate that
 * the retired two-full-closure serve path does not return.
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
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import type { Oid } from "@/oid"
import { serveOnPort } from "@/server"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	listDifferences,
	repackEligibleObjects,
	requiredAt,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { increasingIntegerListArg, parseArgs, pgUrlArg } from "../args"
import {
	requiredCollector,
	requiredPhase,
	requiredPositiveCounter,
} from "../collector-evidence"
import {
	cleanupTmp,
	mb,
	mkTmp,
	reachableObjects,
	secs,
	seedRepo,
	table,
} from "./_perf-util"

const { pg: PG_URL, sizes: SIZES } = parseArgs(
	z
		.object({
			pg: pgUrlArg,
			sizes: increasingIntegerListArg([250, 500, 1000, 2000]),
		})
		.strict(),
)
/** Incremental steps measured per size (the last N commits are held back). */
const STEPS = 8
/** pggit/git per-fetch latency ratio at which this is called broken. */
const RATIO_LIMIT = 5

const median = (xs: number[]): number =>
	requiredAt(
		[...xs].sort((a, b) => a - b),
		Math.floor(xs.length / 2),
		"median sample",
	)
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
		if (commits.length <= STEPS) {
			throw new Error(`fixture has ${commits.length} commits; need more than ${STEPS}`)
		}
		const start = commits.length - STEPS - 1
		const tip = (i: number) => requiredAt(commits, start + i, "incremental-fetch commit")

		// --- canonical git: a bare repo holding every object, ref rewound ----
		const gitRemote = join(mkTmp(`inc-git-${n}`), "remote.git")
		await spawnGit(["clone", "--bare", "-q", src, gitRemote], { cwd: "/tmp" })
		await spawnGit(["update-ref", "refs/heads/main", tip(0)], { cwd: gitRemote })
		const gitClient = join(mkTmp(`inc-gitc-${n}`), "c")
		await spawnGit(["clone", "-q", "--no-local", `file://${gitRemote}`, gitClient], {
			cwd: "/tmp",
		})
		const gitFetches: number[] = []
		const gitStates: { objectsServed: number; oids: Oid[]; tip: Oid }[] = []
		let previousGitOids = await allObjectOids(gitClient)
		for (let i = 1; i <= STEPS; i++) {
			await spawnGit(["update-ref", "refs/heads/main", tip(i)], { cwd: gitRemote })
			const t0 = Date.now()
			await spawnGit(["fetch", "-q", "origin"], { cwd: gitClient })
			gitFetches.push(Date.now() - t0)
			const oids = await allObjectOids(gitClient)
			gitStates.push({
				objectsServed: listDifferences(oids, previousGitOids).onlyLeft.length,
				oids,
				tip: await revParse(gitClient, "refs/remotes/origin/main"),
			})
			previousGitOids = oids
		}

		// --- pggit: same objects, same walk ---------------------------------
		const db = await createIsolatedSchema(PG_URL)
		let server: Awaited<ReturnType<typeof serveOnPort>> | undefined
		try {
			const expectedObjects = await reachableObjects(src)
			const seeded = await seedRepo(db.sql, "probe/inc", src, expectedObjects)
			const repacked = await createRepack(db.sql).repack("probe/inc")
			if (
				repacked.wholes + repacked.deltas !== seeded.eligibleObjects ||
				repacked.deltas <= 0
			) {
				throw new Error(
					`delta fixture repacked ${repacked.wholes} wholes + ${repacked.deltas} deltas for ${seeded.eligibleObjects} eligible objects`,
				)
			}
			await assertCanonicalStoreFixture(db.sql, "probe/inc", {
				encodings: {
					kind: "exact",
					objects: repackEligibleObjects(expectedObjects),
				},
				objects: expectedObjects,
				refs: await canonicalStoreRefsOf(src),
			})
			const refs = createRefStore(db.sql)
			await refs.setRef("probe/inc", "refs/heads/main", tip(0))
			server = await serveOnPort(
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
				const context = `incremental-fetch step ${i}`
				const run = requiredCollector(collectedRuns(), "fetch", context)
				const packBytes = requiredPositiveCounter(run, "packBytes", context)
				const objectsServed = requiredPositiveCounter(run, "objectsServed", context)
				requiredPositiveCounter(run, "deltasServed", context)
				const closure = requiredPhase(run, "closure", context)
				const encode = requiredPhase(run, "pack-encode", context)
				const expected = gitStates[i - 1]
				if (!expected) throw new Error(`step ${i}: missing canonical state`)
				if (objectsServed !== expected.objectsServed) {
					throw new Error(
						`step ${i}: served ${String(objectsServed)}/${expected.objectsServed} canonical new objects`,
					)
				}
				packs.push(packBytes)
				closures.push(closure / (closure + encode))
				const gotOids = await allObjectOids(client)
				const gotTip = await revParse(client, "refs/remotes/origin/main")
				if (
					gotTip !== expected.tip ||
					gotOids.length !== expected.oids.length ||
					gotOids.some((oid, j) => oid !== expected.oids[j])
				) {
					throw new Error(`step ${i}: pggit fetch diverged from canonical git`)
				}
				await assertCanonicalStoreFixture(db.sql, "probe/inc", {
					encodings: {
						kind: "exact",
						objects: repackEligibleObjects(expectedObjects),
					},
					objects: expectedObjects,
					refs: [
						{ kind: "direct", name: "refs/heads/main", oid: tip(i) },
						{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
					],
				})
			}
			if (pggitFetches.some((ms) => ms <= 0) || gitFetches.some((ms) => ms <= 0)) {
				throw new Error("fetch timer recorded a nonpositive latency")
			}
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
			try {
				await server?.close()
			} finally {
				await db.drop()
			}
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
				`${(r.pggitBest / r.gitBest).toFixed(1)}×`,
				(r.packBytes / 1000).toFixed(1),
				`${(r.closureShare * 100).toFixed(0)}%`,
			]),
		),
	)

	const exps: (string | number)[][] = []
	for (let i = 1; i < rows.length; i++) {
		const a = requiredAt(rows, i - 1, "previous incremental-fetch measurement")
		const b = requiredAt(rows, i, "current incremental-fetch measurement")
		const k = Math.log2(b.n / a.n)
		exps.push([
			`${a.n}→${b.n}`,
			(Math.log2(b.pggitBest / a.pggitBest) / k).toFixed(2),
			(Math.log2(b.gitBest / a.gitBest) / k).toFixed(2),
		])
	}
	console.log(
		"\n## latency exponent in history length, best-case fetches (0 = flat, 1 = linear)\n",
	)
	console.log(table(["step", "pggit exp", "git exp"], exps))

	const last = requiredAt(rows, rows.length - 1, "largest incremental-fetch measurement")
	const ratio = last.pggitBest / last.gitBest
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

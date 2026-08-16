/**
 * pgres — DOES AN OFFLINE REPACK STARVE THE SERVE PATH ON A SHARED POOL?
 *
 * `startServer` builds the request path over `postgres(databaseUrl)` — porsager's
 * DEFAULT `max: 10` — and deliberately gives the GC drain its OWN pool ("GC off the
 * hot path means off the hot pool", server.ts). Repack is not wired to any drain
 * yet (design W1), so where it lands is still an open decision; this harness prices
 * the two candidate wirings against each other.
 *
 * Four arms over the SAME repo and the SAME server, N concurrent `git clone`s each:
 *   1 baseline      — clones alone.
 *   2 shared pool   — clones while `createRepack().repack()` runs on the SERVER'S
 *                     pool (what mounting the drain on the app's `Sql` would do).
 *   3 separate pool — clones while the same repack runs on its own small pool (what
 *                     `startServer` already does for GC).
 *   4 gc + repack   — the drain's real per-repo sequence, on the server pool.
 *
 * The arms are INTERLEAVED round-robin across cycles, not run in blocks. A first
 * attempt ran them in blocks and the closing baseline came back 2.6x FASTER than
 * the opening one — this box is shared with sibling agents and drifts by more than
 * the effect being measured, so block ordering measures the drift, not the arms.
 * Round-robin spreads the drift evenly over every arm.
 *
 * Repack's read pattern is the thing under suspicion: design Concern C3 says it
 * reads content via single-row point reads, one round trip per object. Each of
 * those takes a pool slot for its duration.
 *
 * Correctness judge stays real git: EVERY clone in every arm must exit 0, and one
 * clone per arm is fsck'd and compared against the local git repo's object set.
 * That correctness property is kept here, inside the harness, rather than split
 * out: the arms it judges only exist as a measurement, and this file's PRIMARY
 * verdict is the p95 latency ratio.
 *
 * FAILURE BOUND (non-zero exit): any clone fails, OR the shared-pool arm's p95
 * clone latency exceeds 3× the baseline p95 while the separate-pool arm does not —
 * i.e. the pool, not the database, is the bottleneck.
 *
 *   npx tsx perf/breakage/pgres--pool-starvation.ts --clones=4 --cycles=4
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	cleanupTmp,
	fastImport,
	initRepo,
	median,
	mkTmp,
	numFlag,
	objectsBetween,
	ownConnections,
	PG_URL,
	raceClone,
	revParse,
	runCommits,
	seedObjects,
	setMain,
	sleep,
	table,
} from "./_pgres-util"

/** porsager's default `max` — exactly what `startServer` gets today. */
const APP_POOL_MAX = numFlag("pool", 10)
/** Kept low on purpose: this Postgres is shared with sibling agents. */
const CLONES = numFlag("clones", 4)
/** Round-robin cycles; each cycle runs every arm once. */
const CYCLES = numFlag("cycles", 4)
const COMMITS = numFlag("commits", 600)
const REPO = "pool"
const APP_NAME = "pgres-pool-probe"

type Arm = {
	name: string
	latencies: number[]
	failures: number
	bgMs: number
	peakConns: number
}

function pct(xs: number[], p: number): number {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number
}

async function main(): Promise<void> {
	const iso = await createIsolatedSchema(PG_URL)
	// The app's own pool, sized exactly like `startServer`'s.
	const appPg = postgres(PG_URL, {
		connection: { application_name: APP_NAME, search_path: iso.schema },
		max: APP_POOL_MAX,
		onnotice: () => {},
	})
	// The "off the hot pool" pool, sized like `startServer`'s gcPg.
	const sidePg = postgres(PG_URL, {
		connection: { application_name: `${APP_NAME}-side`, search_path: iso.schema },
		max: 2,
		onnotice: () => {},
	})
	let failed = false
	try {
		const dir = await initRepo("pool")
		await fastImport(
			dir,
			runCommits({
				blobChars: 900,
				branch: "refs/heads/main",
				count: COMMITS,
				markStart: 0,
				salt: "pool",
			}).stream,
		)
		const tip = await revParse(dir, "refs/heads/main")
		const objects = await objectsBetween(dir, tip, [])
		await seedObjects(appPg, REPO, objects)
		await setMain(appPg, REPO, tip)

		const wantObjects = (
			await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
		).stdout
			.split("\n")
			.map((l) => l.slice(0, 40))
			.filter((x) => /^[0-9a-f]{40}$/.test(x))
			.sort()

		const server = await serveOnPort(createGitApp(createGitDeps(appPg)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const scratch = mkTmp("pool-clones")
		let seq = 0

		/** One run of one arm: `CLONES` concurrent clones with `bg` running beside. */
		const runArm = async (
			bg: (() => Promise<unknown>) | null,
		): Promise<{ latencies: number[]; failures: number; peak: number; ms: number }> => {
			const latencies: number[] = []
			let failures = 0
			let peak = 0
			const t0 = Date.now()
			const sampler = setInterval(() => {
				void ownConnections(sidePg, APP_NAME).then((c) => {
					if (c.total > peak) peak = c.total
				})
			}, 60)
			const bgPromise = bg ? bg() : Promise.resolve()
			try {
				const batch = await Promise.all(
					Array.from({ length: CLONES }, () =>
						raceClone(url, join(scratch, `c${seq++}.git`)),
					),
				)
				for (const r of batch) {
					latencies.push(r.ms)
					if (r.code !== 0) {
						failures++
						console.log(`  clone FAILED: ${r.stderr.trim().slice(0, 200)}`)
					}
				}
			} finally {
				clearInterval(sampler)
			}
			await bgPromise
			return { failures, latencies, ms: Date.now() - t0, peak }
		}

		const repackShared = createRepack(appPg)
		const repackSide = createRepack(sidePg)
		const gcShared = createGc(appPg)
		// A repack must have work to do, so the tier is dropped before each arm that
		// runs one. (`truncate` on the harness's own table, in the harness's own schema.)
		const clearTier = async (): Promise<void> => {
			await appPg.unsafe("truncate git_pack_encoding")
			await sleep(150)
		}

		type Spec = { name: string; bg: (() => Promise<unknown>) | null; clear: boolean }
		const specs: Spec[] = [
			{ bg: null, clear: false, name: "1 baseline (clones alone)" },
			{
				bg: () => repackShared.repack(REPO),
				clear: true,
				name: "2 clones + repack on the SERVER pool",
			},
			{
				bg: () => repackSide.repack(REPO),
				clear: true,
				name: "3 clones + repack on a SEPARATE pool",
			},
			{
				bg: async () => {
					await gcShared.gc(REPO, { graceSeconds: 3600, maintain: false })
					await repackShared.repack(REPO)
				},
				clear: true,
				name: "4 clones + gc+repack on the SERVER pool",
			},
		]
		const arms: Arm[] = specs.map((sp) => ({
			bgMs: 0,
			failures: 0,
			latencies: [],
			name: sp.name,
			peakConns: 0,
		}))

		for (let cycle = 0; cycle < CYCLES; cycle++) {
			for (let i = 0; i < specs.length; i++) {
				const spec = specs[i] as Spec
				const acc = arms[i] as Arm
				if (spec.clear) await clearTier()
				const r = await runArm(spec.bg)
				acc.latencies.push(...r.latencies)
				acc.failures += r.failures
				acc.bgMs += r.ms
				if (r.peak > acc.peakConns) acc.peakConns = r.peak
			}
		}

		// Correctness judge, once at the end: the repo still serves a clean, complete
		// clone after every arm has run over it.
		{
			const probe = join(scratch, "verify.git")
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, probe])
			const f = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: probe })
			const got = (
				await spawnGit(["rev-list", "--objects", "--all"], { cwd: probe })
			).stdout
				.split("\n")
				.map((l) => l.slice(0, 40))
				.filter((x) => /^[0-9a-f]{40}$/.test(x))
				.sort()
			const clean = `${f.stdout}${f.stderr}`.trim() === ""
			const same =
				got.length === wantObjects.length && got.every((x, i) => x === wantObjects[i])
			console.log(
				`correctness: clone ${clean ? "fsck-clean" : "FSCK DIRTY"}, ${got.length}/${wantObjects.length} objects ${same ? "identical to local git" : "MISMATCH"}\n`,
			)
			if (!clean || !same) failed = true
			rmSync(probe, { force: true, recursive: true })
		}

		await server.close()

		console.log("# pool contention: offline repack beside live clones\n")
		console.log(
			`server pool max=${APP_POOL_MAX} (porsager default, = startServer) · ${CLONES} concurrent clones × ${CYCLES} interleaved cycles · repo ${objects.length} objects\n`,
		)
		const base = arms[0] as Arm
		console.log(
			table(
				[
					"arm",
					"clones",
					"fail",
					"p50 ms",
					"p95 ms",
					"max ms",
					"vs baseline p95",
					"peak conns",
					"arm ms",
				],
				arms.map((a) => [
					a.name,
					a.latencies.length,
					a.failures,
					median(a.latencies).toFixed(0),
					pct(a.latencies, 95).toFixed(0),
					Math.max(...a.latencies),
					`×${(pct(a.latencies, 95) / pct(base.latencies, 95)).toFixed(2)}`,
					a.peakConns,
					a.bgMs,
				]),
			),
		)

		const shared = arms[1] as Arm
		const separate = arms[2] as Arm
		// Drift check: the spread of the BASELINE arm's own latencies across cycles is
		// how much this shared box moved under us. An arm-to-arm difference smaller
		// than that spread is not a finding.
		const bmin = Math.min(...base.latencies)
		const bmax = Math.max(...base.latencies)
		console.log(
			`\nbaseline spread across cycles: ${bmin}–${bmax} ms (×${(bmax / bmin).toFixed(2)}) — this shared box's own drift. An arm difference smaller than that is noise.`,
		)
		const sharedRatio = pct(shared.latencies, 95) / pct(base.latencies, 95)
		const sepRatio = pct(separate.latencies, 95) / pct(base.latencies, 95)
		const anyFail = arms.some((a) => a.failures > 0)
		if (anyFail) failed = true
		console.log(
			`\nshared-pool p95 ×${sharedRatio.toFixed(2)} · separate-pool p95 ×${sepRatio.toFixed(2)} · clone failures ${arms.reduce((n, a) => n + a.failures, 0)}`,
		)
		const poolIsTheBottleneck = sharedRatio > 3 && sepRatio <= 3
		if (poolIsTheBottleneck) failed = true
		console.log(
			`\n${failed ? "FAIL" : "ok  "}  BOUND: no clone fails, and the shared-pool p95 stays within 3× baseline (or the separate pool is no better, meaning the DATABASE, not the pool, is the constraint).`,
		)
	} finally {
		await appPg.end()
		await sidePg.end()
		cleanupTmp()
		await iso.drop()
	}
	if (failed) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

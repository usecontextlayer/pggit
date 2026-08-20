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
 *   4 gc + repack   — the candidate per-repo sequence, on the server pool.
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
 * Correctness judge stays real git: EVERY clone in every arm must exit 0, be
 * fsck-clean, and match the local git repo's refs and object set. That correctness
 * property is kept here, inside the harness, rather than split out: the arms it
 * judges only exist as a measurement, and this file's PRIMARY verdict is the p95
 * latency ratio.
 *
 * FAILURE BOUND (non-zero exit): any clone fails, OR the shared-pool arm's p95
 * clone latency exceeds 3× the baseline p95 while the separate-pool arm does not —
 * i.e. the pool, not the database, is the bottleneck.
 *
 *   npx tsx perf/breakage/pgres--pool-starvation.ts --clones=4 --cycles=4
 */
import { join } from "node:path"
import postgres from "postgres"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { branchAndTagRefsOf, parseRevListObjectOids } from "@/testing/git-fixtures"
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
	PG_URL,
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
	bgMs: number
	peakConns: number
	overlapRuns: number
}

function pct(xs: number[], p: number): number {
	if (xs.length === 0 || xs.some((x) => !Number.isFinite(x) || x <= 0)) {
		throw new Error("latency percentile requires finite positive samples")
	}
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number
}

async function main(): Promise<void> {
	if (APP_POOL_MAX < 2 || CLONES < 1 || CYCLES < 1 || COMMITS < 1) {
		throw new Error(
			"pool, clones, cycles, and commits must be positive; pool must be at least 2",
		)
	}
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
	let server: Awaited<ReturnType<typeof serveOnPort>> | undefined
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

		const wantObjects = parseRevListObjectOids(
			(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })).stdout,
		).sort()
		const wantRefs = await branchAndTagRefsOf(dir)

		server = await serveOnPort(createGitApp(createGitDeps(appPg)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const scratch = mkTmp("pool-clones")
		let seq = 0

		const verifyClone = async (dest: string): Promise<void> => {
			const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			if (`${fsck.stdout}${fsck.stderr}`.trim() !== "") {
				throw new Error(`${dest}: clone is not fsck-clean`)
			}
			const gotObjects = parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dest })).stdout,
			).sort()
			const gotRefs = await branchAndTagRefsOf(dest)
			if (
				gotObjects.length !== wantObjects.length ||
				gotObjects.some((oid, i) => oid !== wantObjects[i]) ||
				JSON.stringify(gotRefs) !== JSON.stringify(wantRefs)
			) {
				throw new Error(
					`${dest}: clone differs from canonical git (objects ${gotObjects.length}/${wantObjects.length}, refs ${gotRefs.length}/${wantRefs.length})`,
				)
			}
		}

		/** One run of one arm: `CLONES` concurrent clones with `bg` running beside. */
		const runArm = async (
			bg: (() => Promise<unknown>) | null,
		): Promise<{ latencies: number[]; overlap: boolean; peak: number; ms: number }> => {
			const latencies: number[] = []
			let peak = 0
			let overlap = false
			let sampling = true
			const t0 = Date.now()
			const sampler = (async () => {
				while (sampling) {
					const [sample] = await iso.sql<
						{
							active: string
							encodings: string
							total: string
						}[]
					>`
						select count(*) filter (
								where application_name in (${APP_NAME}, ${`${APP_NAME}-side`})
									and state = 'active'
							)::text as active,
							count(*) filter (
								where application_name in (${APP_NAME}, ${`${APP_NAME}-side`})
							)::text as total,
							(select count(*)::text from git_pack_encoding) as encodings
						from pg_stat_activity`
					if (!sample) throw new Error("pool-overlap sampler returned no row")
					peak = Math.max(peak, Number(sample.total))
					const encodings = Number(sample.encodings)
					if (
						bg &&
						Number(sample.active) >= 2 &&
						encodings > 0 &&
						encodings < objects.length
					) {
						overlap = true
					}
					await sleep(10)
				}
			})()
			const destinations = Array.from({ length: CLONES }, () =>
				join(scratch, `c${seq++}.git`),
			)
			const clonePromise = Promise.all(
				destinations.map(async (dest) => {
					const started = Date.now()
					await spawnGit([
						"-c",
						"protocol.version=2",
						"clone",
						"-q",
						"--mirror",
						url,
						dest,
					])
					return Date.now() - started
				}),
			)
			const bgPromise = bg ? bg() : Promise.resolve()
			try {
				const [clonesResult, bgResult] = await Promise.allSettled([
					clonePromise,
					bgPromise,
				])
				if (clonesResult.status === "rejected") throw clonesResult.reason
				if (bgResult.status === "rejected") throw bgResult.reason
				latencies.push(...clonesResult.value)
			} finally {
				sampling = false
				await sampler
			}
			await Promise.all(destinations.map(verifyClone))
			return { latencies, ms: Date.now() - t0, overlap, peak }
		}

		const repackShared = createRepack(appPg)
		const repackSide = createRepack(sidePg)
		const gcShared = createGc(appPg)
		// A repack must have work to do, so the tier is dropped before each arm that
		// runs one. (`truncate` on the harness's own table, in the harness's own schema.)
		const clearTier = async (): Promise<void> => {
			await appPg.unsafe("truncate git_pack_encoding")
			const [row] = await appPg<
				{ n: string }[]
			>`select count(*)::text as n from git_pack_encoding`
			if (!row || Number(row.n) !== 0) throw new Error("encoding tier did not clear")
			await sleep(150)
		}
		const checkedRepack = async (
			repack: ReturnType<typeof createRepack>,
		): Promise<void> => {
			const result = await repack.repack(REPO)
			const [row] = await appPg<
				{ n: string }[]
			>`select count(*)::text as n from git_pack_encoding`
			if (
				result.wholes + result.deltas !== objects.length ||
				!row ||
				Number(row.n) !== objects.length
			) {
				throw new Error(
					`repack did not cover the fixture: receipt=${result.wholes + result.deltas}/${objects.length}, rows=${row?.n ?? "missing"}`,
				)
			}
		}

		type Spec = { name: string; bg: (() => Promise<unknown>) | null; clear: boolean }
		const specs: Spec[] = [
			{ bg: null, clear: true, name: "1 baseline (clones alone)" },
			{
				bg: () => checkedRepack(repackShared),
				clear: true,
				name: "2 clones + repack on the SERVER pool",
			},
			{
				bg: () => checkedRepack(repackSide),
				clear: true,
				name: "3 clones + repack on a SEPARATE pool",
			},
			{
				bg: async () => {
					const gcResult = await gcShared.gc(REPO, {
						graceSeconds: 3600,
						maintain: false,
					})
					if (gcResult.deletedObjects !== 0) {
						throw new Error(`no-op GC deleted ${gcResult.deletedObjects} objects`)
					}
					await checkedRepack(repackShared)
				},
				clear: true,
				name: "4 clones + gc+repack on the SERVER pool",
			},
		]
		const arms: Arm[] = specs.map((sp) => ({
			bgMs: 0,
			latencies: [],
			name: sp.name,
			overlapRuns: 0,
			peakConns: 0,
		}))

		for (let cycle = 0; cycle < CYCLES; cycle++) {
			for (let i = 0; i < specs.length; i++) {
				const spec = specs[i] as Spec
				const acc = arms[i] as Arm
				if (spec.clear) await clearTier()
				const r = await runArm(spec.bg)
				acc.latencies.push(...r.latencies)
				acc.bgMs += r.ms
				if (r.overlap) acc.overlapRuns++
				if (r.peak > acc.peakConns) acc.peakConns = r.peak
				if (spec.bg && !r.overlap) {
					throw new Error(
						`${spec.name}: sampler did not observe clones overlapping a partial repack`,
					)
				}
			}
		}

		console.log("# pool contention: offline repack beside live clones\n")
		console.log(
			`server pool max=${APP_POOL_MAX} (porsager default, = startServer) · ${CLONES} concurrent clones × ${CYCLES} interleaved cycles · repo ${objects.length} objects\n`,
		)
		const base = arms[0] as Arm
		const expectedSamples = CLONES * CYCLES
		for (const arm of arms) {
			if (
				arm.latencies.length !== expectedSamples ||
				arm.latencies.some((ms) => !Number.isFinite(ms) || ms <= 0)
			) {
				throw new Error(
					`${arm.name}: expected ${expectedSamples} finite positive clone latencies, got ${JSON.stringify(arm.latencies)}`,
				)
			}
		}
		const baseP95 = pct(base.latencies, 95)
		if (!Number.isFinite(baseP95) || baseP95 <= 0) {
			throw new Error(`baseline p95 must be positive, got ${baseP95}`)
		}
		console.log(
			table(
				[
					"arm",
					"clones",
					"p50 ms",
					"p95 ms",
					"max ms",
					"vs baseline p95",
					"peak conns",
					"overlap runs",
					"arm ms",
				],
				arms.map((a) => [
					a.name,
					a.latencies.length,
					median(a.latencies).toFixed(0),
					pct(a.latencies, 95).toFixed(0),
					Math.max(...a.latencies),
					`×${(pct(a.latencies, 95) / baseP95).toFixed(2)}`,
					a.peakConns,
					`${a.overlapRuns}/${a.name.startsWith("1 ") ? 0 : CYCLES}`,
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
		if (!Number.isFinite(bmin) || bmin <= 0) {
			throw new Error(`baseline minimum latency must be positive, got ${bmin}`)
		}
		console.log(
			`\nbaseline spread across cycles: ${bmin}–${bmax} ms (×${(bmax / bmin).toFixed(2)}) — this shared box's own drift. An arm difference smaller than that is noise.`,
		)
		const sharedRatio = pct(shared.latencies, 95) / baseP95
		const sepRatio = pct(separate.latencies, 95) / baseP95
		console.log(
			`\nshared-pool p95 ×${sharedRatio.toFixed(2)} · separate-pool p95 ×${sepRatio.toFixed(2)} · every measured clone passed canonical ref/OID/fsck verification`,
		)
		const poolIsTheBottleneck = sharedRatio > 3 && sepRatio <= 3
		if (poolIsTheBottleneck) failed = true
		console.log(
			`\n${failed ? "FAIL" : "ok  "}  BOUND: no clone fails, and the shared-pool p95 stays within 3× baseline (or the separate pool is no better, meaning the DATABASE, not the pool, is the constraint).`,
		)
	} finally {
		try {
			await server?.close()
		} finally {
			try {
				await appPg.end()
			} finally {
				try {
					await sidePg.end()
				} finally {
					cleanupTmp()
					await iso.drop()
				}
			}
		}
	}
	if (failed) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

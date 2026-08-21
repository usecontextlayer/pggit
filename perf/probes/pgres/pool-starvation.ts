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
 *   npx tsx perf/probes/pgres/pool-starvation.ts --clones=4 --cycles=4
 */
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs, pgUrlArg, positiveIntegerArg } from "@perf/args"
import { median, percentile, requireSamples } from "@perf/memory"
import { table } from "@perf/probes/_table"
import {
	cleanupTmp,
	fastImport,
	initRepo,
	mkTmp,
	objectsBetween,
	runCommits,
	seedObjects,
	setMain,
} from "@perf/probes/pgres/_util"
import postgres from "postgres"
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import {
	assertCanonicalStoreFixture,
	assertGitReachableObjects,
	branchAndTagRefsOf,
	gitReachableOids,
	repackEligibleObjects,
	requiredAt,
	requireGitOid,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** porsager's default `max` — exactly what `startServer` gets today. */
const args = parseArgs(
	z
		.object({
			clones: positiveIntegerArg.default(4),
			commits: positiveIntegerArg.default(600),
			cycles: positiveIntegerArg.default(4),
			pg: pgUrlArg,
			pool: positiveIntegerArg.default(10),
		})
		.strict(),
)
const APP_POOL_MAX = args.pool
/** Kept low on purpose: this Postgres is shared with sibling agents. */
const CLONES = args.clones
/** Round-robin cycles; each cycle runs every arm once. */
const CYCLES = args.cycles
const COMMITS = args.commits
const PG_URL = args.pg
const REPO = "pool"
const APP_NAME = "pgres-pool-probe"

type Arm = {
	kind: "background" | "baseline"
	name: string
	latencies: number[]
	wallMs: number
	peakConns: number
	overlapRuns: number
}

type RepackReceipt = { deltas: number; wholes: number }
type Workload =
	| { kind: "baseline" }
	| { kind: "background"; run: () => Promise<RepackReceipt> }
type WorkloadEvidence =
	| { kind: "baseline" }
	| { kind: "background"; receipt: RepackReceipt }

function latencyPercentile(xs: number[], p: number): number {
	if (xs.length === 0 || xs.some((x) => !Number.isFinite(x) || x <= 0)) {
		throw new Error("latency percentile requires finite positive samples")
	}
	return percentile(requireSamples(xs), p)
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
		const eligibleObjects = repackEligibleObjects(objects)
		if (eligibleObjects.length === 0) {
			throw new Error("pool fixture produced no repack-eligible objects")
		}
		await seedObjects(appPg, REPO, objects)
		await setMain(appPg, REPO, tip)

		const wantObjects = await gitReachableOids(dir)
		const wantRefs = await branchAndTagRefsOf(dir)

		server = await serveOnPort(createGitApp(createGitDeps(appPg)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const scratch = mkTmp("pool-clones")
		let seq = 0

		const verifyClone = async (dest: string): Promise<void> => {
			await assertGitReachableObjects(dest, wantObjects, `clone ${dest}`)
			const gotRefs = await branchAndTagRefsOf(dest)
			if (JSON.stringify(gotRefs) !== JSON.stringify(wantRefs)) {
				throw new Error(
					`${dest}: clone refs differ from canonical git (${gotRefs.length}/${wantRefs.length})`,
				)
			}
		}

		/** One run of one arm: `CLONES` concurrent clones with background work beside. */
		const runArm = async (
			workload: Workload,
		): Promise<{
			latencies: number[]
			ms: number
			overlap: boolean
			peak: number
			workload: WorkloadEvidence
		}> => {
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
						workload.kind === "background" &&
						Number(sample.active) >= 2 &&
						encodings > 0 &&
						encodings < eligibleObjects.length
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
			const backgroundPromise: Promise<WorkloadEvidence> =
				workload.kind === "background"
					? workload.run().then((receipt) => ({ kind: "background", receipt }))
					: Promise.resolve({ kind: "baseline" })
			let evidence: WorkloadEvidence | undefined
			let wallMs = 0
			try {
				const [clonesResult, backgroundResult] = await Promise.allSettled([
					clonePromise,
					backgroundPromise,
				])
				if (clonesResult.status === "rejected") throw clonesResult.reason
				if (backgroundResult.status === "rejected") throw backgroundResult.reason
				latencies.push(...clonesResult.value)
				evidence = backgroundResult.value
				wallMs = Date.now() - t0
			} finally {
				sampling = false
				await sampler
			}
			await Promise.all(destinations.map(verifyClone))
			if (evidence === undefined || wallMs <= 0) {
				throw new Error(
					"pool arm completed without workload evidence or positive wall time",
				)
			}
			return { latencies, ms: wallMs, overlap, peak, workload: evidence }
		}

		const repackShared = createRepack(appPg)
		const repackSide = createRepack(sidePg)
		const gcShared = createGc(appPg)
		const requireFixture = async (encodings: "absent" | "present"): Promise<void> => {
			await assertCanonicalStoreFixture(appPg, REPO, {
				encodings:
					encodings === "present"
						? { kind: "exact", objects: eligibleObjects }
						: { kind: "exact", objects: [] },
				objects,
				refs: [
					{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
					{
						kind: "direct",
						name: "refs/heads/main",
						oid: requireGitOid(tip, "pool fixture main tip"),
					},
				],
			})
		}
		// A repack must have work to do, so the tier is dropped before each arm that
		// runs one. (`truncate` on the harness's own table, in the harness's own schema.)
		const clearTier = async (): Promise<void> => {
			await appPg.unsafe("truncate git_pack_encoding")
			await requireFixture("absent")
			await sleep(150)
		}
		const requireRepack = async (receipt: RepackReceipt): Promise<void> => {
			if (receipt.wholes + receipt.deltas !== eligibleObjects.length) {
				throw new Error(
					`repack did not cover the eligible fixture: receipt=${receipt.wholes + receipt.deltas}/${eligibleObjects.length}`,
				)
			}
			await requireFixture("present")
		}

		type Spec =
			| { kind: "baseline"; name: string }
			| { kind: "background"; name: string; run: () => Promise<RepackReceipt> }
		const specs: Spec[] = [
			{ kind: "baseline", name: "1 baseline (clones alone)" },
			{
				kind: "background",
				name: "2 clones + repack on the SERVER pool",
				run: () => repackShared.repack(REPO),
			},
			{
				kind: "background",
				name: "3 clones + repack on a SEPARATE pool",
				run: () => repackSide.repack(REPO),
			},
			{
				kind: "background",
				name: "4 clones + gc+repack on the SERVER pool",
				run: async () => {
					const gcResult = await gcShared.gc(REPO, {
						graceSeconds: 3600,
						maintain: false,
					})
					if (gcResult.deletedObjects !== 0) {
						throw new Error(`no-op GC deleted ${gcResult.deletedObjects} objects`)
					}
					return repackShared.repack(REPO)
				},
			},
		]
		const arms: Arm[] = specs.map((sp) => ({
			kind: sp.kind,
			latencies: [],
			name: sp.name,
			overlapRuns: 0,
			peakConns: 0,
			wallMs: 0,
		}))

		for (let cycle = 0; cycle < CYCLES; cycle++) {
			for (let i = 0; i < specs.length; i++) {
				const spec = requiredAt(specs, i, "pool-starvation arm spec")
				const acc = requiredAt(arms, i, "pool-starvation arm result")
				await clearTier()
				const workload: Workload =
					spec.kind === "baseline"
						? { kind: "baseline" }
						: { kind: "background", run: spec.run }
				const r = await runArm(workload)
				if (spec.kind === "background") {
					if (r.workload.kind !== "background") {
						throw new Error(`${spec.name}: missing background receipt`)
					}
					await requireRepack(r.workload.receipt)
				} else if (r.workload.kind !== "baseline") {
					throw new Error(`${spec.name}: baseline reported background evidence`)
				}
				acc.latencies.push(...r.latencies)
				acc.wallMs += r.ms
				if (r.overlap) acc.overlapRuns++
				if (r.peak > acc.peakConns) acc.peakConns = r.peak
				if (spec.kind === "background" && !r.overlap) {
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
		const base = requiredAt(arms, 0, "baseline arm")
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
		const baseP95 = latencyPercentile(base.latencies, 95)
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
					median(requireSamples(a.latencies)).toFixed(0),
					latencyPercentile(a.latencies, 95).toFixed(0),
					Math.max(...a.latencies),
					`×${(latencyPercentile(a.latencies, 95) / baseP95).toFixed(2)}`,
					a.peakConns,
					`${a.overlapRuns}/${a.kind === "baseline" ? 0 : CYCLES}`,
					a.wallMs,
				]),
			),
		)

		const shared = requiredAt(arms, 1, "shared-pool arm")
		const separate = requiredAt(arms, 2, "separate-pool arm")
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
		const sharedRatio = latencyPercentile(shared.latencies, 95) / baseP95
		const sepRatio = latencyPercentile(separate.latencies, 95) / baseP95
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

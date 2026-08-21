import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { generateRepo } from "@perf/harness/fast-import"
import {
	type PgHandle,
	type RttEvidence,
	type RttMode,
	startLatencyPg,
	startPlainPg,
} from "@perf/harness/pg-latency"
import { collectProcessMetrics, type ProcessMetrics } from "@perf/harness/process-metrics"
import { type ProfileResult, startProfile, stopProfile } from "@perf/harness/profile"
import { assembleReport, type Report } from "@perf/harness/report"
import type { Scenario } from "@perf/harness/scenarios"
import { type MemoryReport, startMemorySampler } from "@perf/memory"
import { createGitApp } from "@/index"
import { type Collector, collectedRuns, resetCollected } from "@/instrument"
import type { Oid } from "@/object/oid"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	assertCanonicalStoreFixture,
	assertGitReachableObjects,
	canonicalStoreRefsOf,
	gitReachableOids,
	loadAllObjects,
	parseLsRemoteRefs,
	seedGitRefs,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

const REPO_ID = "perf"

function settledValue<T>(result: PromiseSettledResult<T>): T {
	if (result.status === "rejected") throw result.reason
	return result.value
}

type RunOptions = {
	scenario: Scenario
	seed: number
	repeat: number
	outDir: string
	rtt: RttMode
}

type PgRuntime =
	| { kind: "loopback"; pg: Awaited<ReturnType<typeof startPlainPg>> }
	| {
			kind: "sweep"
			pg: Awaited<ReturnType<typeof startLatencyPg>>
			requestedMs: number
	  }

async function seedStore(
	srcRepo: string,
	db: Awaited<ReturnType<typeof createIsolatedSchema>>,
) {
	const objects = createObjectStore(db.sql)
	const refs = createRefStore(db.sql)
	const allObjects = await loadAllObjects(srcRepo)
	if (allObjects.length === 0)
		throw new Error("generated perf fixture has no reachable objects")
	await objects.putPack(REPO_ID, allObjects)
	await seedGitRefs(REPO_ID, srcRepo, refs)
	await assertCanonicalStoreFixture(db.sql, REPO_ID, {
		encodings: { kind: "exact", objects: [] },
		objects: allObjects,
		refs: await canonicalStoreRefsOf(srcRepo),
	})
	return { objectCount: allObjects.length, objects, refs }
}

/** One `git clone` over loopback; returns its wall time in ms. */
async function cloneOnce(port: number, expectedOids: readonly Oid[]): Promise<number> {
	return withTempDir("pggit-perf-clone-", async (dest) => {
		const t0 = process.hrtime.bigint()
		await spawnGit([
			"clone",
			"-c",
			"protocol.version=2",
			"--quiet",
			`http://127.0.0.1:${port}/${REPO_ID}`,
			dest,
		])
		const wallMs = Number(process.hrtime.bigint() - t0) / 1e6
		await assertGitReachableObjects(dest, expectedOids, "clone")
		return wallMs
	})
}

export async function runScenario(opts: RunOptions): Promise<Report> {
	const scratch = createScratchArena()
	const runtime: PgRuntime =
		opts.rtt.kind === "loopback"
			? { kind: "loopback", pg: await startPlainPg() }
			: {
					kind: "sweep",
					pg: await startLatencyPg(),
					requestedMs: opts.rtt.requestedMs,
				}
	const pg: PgHandle = runtime.pg
	const db = await createIsolatedSchema(pg.baseUrl)
	let server: GitServer | undefined
	try {
		const srcRepo = await generateRepo(opts.scenario, opts.seed)
		scratch.own(srcRepo)
		const { objects, refs, objectCount } = await seedStore(srcRepo, db)
		const expectedOids = await gitReachableOids(srcRepo)
		if (expectedOids.length === 0)
			throw new Error("canonical source has no reachable objects")

		server = await serveOnPort(createGitApp({ objects, refs }, { instrument: true }), 0)
		const port = server.port
		const [canonicalRefs, servedRefs] = await Promise.all([
			spawnGit(["ls-remote", srcRepo]),
			spawnGit(["ls-remote", `http://127.0.0.1:${port}/${REPO_ID}`]),
		])
		const expectedRefs = parseLsRemoteRefs(canonicalRefs.stdout, "canonical source")
		const actualRefs = parseLsRemoteRefs(servedRefs.stdout, "pggit")
		if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
			throw new Error(
				`served refs differ from canonical source: expected ${expectedRefs.length}, got ${actualRefs.length}`,
			)
		}

		// Best-of-N wall timing at zero latency (no profiler overhead skewing it).
		const wallMsRuns: number[] = []
		for (let i = 0; i < opts.repeat; i++) {
			wallMsRuns.push(await cloneOnce(port, expectedOids))
		}

		// Two separate instrumented clones so the measurements never contaminate each
		// other. The PROFILER clone wraps ONLY the clone (no fsck/teardown) and runs no
		// samplers, so its main-thread flamegraph is pure server work — a memory
		// sampler's `setInterval` would otherwise dominate the hotspots of a short
		// clone. The MEMORY clone runs the RSS/breakdown samplers without the profiler's
		// sampling overhead. Both clones are deterministic (same repo), so the
		// collectors, profile, and memory all describe the same workload.
		const profDest = scratch.make("perf-prof")
		resetCollected()
		const cpu0 = process.cpuUsage()
		startProfile()
		const [profileClone] = await Promise.allSettled([
			spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${port}/${REPO_ID}`,
				profDest,
			]),
		])
		const [profileStop] = await Promise.allSettled([stopProfile(opts.outDir)])
		settledValue(profileClone)
		const profile: ProfileResult = settledValue(profileStop)
		const cpu = process.cpuUsage(cpu0)
		const collectors: readonly Collector[] = [...collectedRuns()]
		await assertGitReachableObjects(profDest, expectedOids, "profile clone")

		const memDest = scratch.make("perf-mem")
		const proc = collectProcessMetrics()
		const memory = startMemorySampler()
		const [memoryClone] = await Promise.allSettled([
			spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${port}/${REPO_ID}`,
				memDest,
			]),
		])
		// Stop the GC observer BEFORE the memory sampler forces a GC for its retained-set
		// read, so the forced collection never pollutes the GC counts. Capture both
		// outcomes so one failed stop never prevents the other sampler from stopping.
		const [processStop] = await Promise.allSettled([
			Promise.resolve().then(() => proc.stop()),
		])
		const [memoryStop] = await Promise.allSettled([memory.stop()])
		settledValue(memoryClone)
		const processMetrics: ProcessMetrics = settledValue(processStop)
		const memoryReport: MemoryReport = settledValue(memoryStop)
		await writeFile(
			join(opts.outDir, "memory.json"),
			JSON.stringify({
				rssSeries: memoryReport.rssSeries,
				sampler: memoryReport.sampler,
			}),
		)
		await assertGitReachableObjects(memDest, expectedOids, "memory clone")

		// RTT sweep: clone wall at 0ms vs the requested latency (same repo, via proxy).
		let rtt: RttEvidence = { kind: "loopback" }
		if (runtime.kind === "sweep") {
			await runtime.pg.setLatencyMs(0)
			const loopback = { rttMs: 0, wallMs: await cloneOnce(port, expectedOids) }
			await runtime.pg.setLatencyMs(runtime.requestedMs)
			const delayed = {
				rttMs: runtime.requestedMs,
				wallMs: await cloneOnce(port, expectedOids),
			}
			await runtime.pg.setLatencyMs(0)
			rtt = {
				kind: "sweep",
				requestedMs: runtime.requestedMs,
				samples: [loopback, delayed],
			}
		}

		return assembleReport({
			collectors,
			gitVersion: (await spawnGit(["--version"])).stdout.trim(),
			hotspots: profile.hotspots,
			memory: memoryReport,
			objectsInRepo: objectCount,
			outDir: opts.outDir,
			process: processMetrics,
			repeat: opts.repeat,
			rtt,
			scenario: opts.scenario,
			serverSystemMs: cpu.system / 1000,
			serverUserMs: cpu.user / 1000,
			wallMsRuns,
		})
	} finally {
		await server?.close()
		await db.drop()
		await pg.stop()
		scratch.cleanup()
	}
}

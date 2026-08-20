import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGitApp } from "@/index"
import { type Collector, collectedRuns, resetCollected } from "@/instrument"
import type { Oid } from "@/oid"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	type GitObjectWithOid,
	gitReachableOids,
	loadGitObjects,
	requireGitOid,
	seedGitRefs,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { generateRepo } from "./fast-import"
import { type MemoryReport, startMemorySampler } from "./memory"
import {
	type PgHandle,
	type RttEvidence,
	type RttMode,
	startLatencyPg,
	startPlainPg,
} from "./pg-latency"
import { collectProcessMetrics, type ProcessMetrics } from "./process-metrics"
import { type ProfileResult, startProfile, stopProfile } from "./profile"
import { assembleReport, type Report } from "./report"
import type { Scenario } from "./scenarios"

const REPO_ID = "perf"

type Outcome<T> = { status: "success"; value: T } | { status: "failure"; error: unknown }

async function outcomeOf<T>(work: () => Promise<T>): Promise<Outcome<T>> {
	try {
		return { status: "success", value: await work() }
	} catch (error) {
		return { error, status: "failure" }
	}
}

function outcomeOfSync<T>(work: () => T): Outcome<T> {
	try {
		return { status: "success", value: work() }
	} catch (error) {
		return { error, status: "failure" }
	}
}

function outcomeValue<T>(outcome: Outcome<T>): T {
	if (outcome.status === "failure") throw outcome.error
	return outcome.value
}

export type RunOptions = {
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

/** Load every object from a real repo (the m0 seeding path: real git, real store). */
async function loadAllObjects(dir: string): Promise<GitObjectWithOid[]> {
	return loadGitObjects(dir, await gitReachableOids(dir))
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

async function verifyClone(dir: string, expectedOids: readonly Oid[]): Promise<void> {
	await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dir })
	const actual = await gitReachableOids(dir)
	const expected = [...expectedOids].sort()
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`clone object set differs from canonical source: expected ${expected.length}, got ${actual.length}`,
		)
	}
}

function normalizedLsRemote(stdout: string, source: string): string[] {
	const rows = stdout.trim().split("\n").filter(Boolean)
	if (rows.length === 0) throw new Error(`${source} advertised no refs`)
	return rows
		.map((line) => {
			const fields = line.split("\t")
			const [oid, name] = fields
			if (
				fields.length !== 2 ||
				oid === undefined ||
				name === undefined ||
				name.length === 0
			) {
				throw new Error(
					`${source} emitted malformed ls-remote row ${JSON.stringify(line)}`,
				)
			}
			return `${requireGitOid(oid, `${source} ls-remote row`)}\t${name}`
		})
		.sort()
}

/** One `git clone` over loopback; returns its wall time in ms. */
async function cloneOnce(port: number, expectedOids: readonly Oid[]): Promise<number> {
	const dest = mkdtempSync(join(tmpdir(), "pggit-perf-clone-"))
	try {
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
		await verifyClone(dest, expectedOids)
		return wallMs
	} finally {
		rmSync(dest, { force: true, recursive: true })
	}
}

export async function runScenario(opts: RunOptions): Promise<Report> {
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
	let srcRepo: string | undefined
	try {
		srcRepo = await generateRepo(opts.scenario, opts.seed)
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
		const expectedRefs = normalizedLsRemote(canonicalRefs.stdout, "canonical source")
		const actualRefs = normalizedLsRemote(servedRefs.stdout, "pggit")
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
		const profDest = mkdtempSync(join(tmpdir(), "pggit-perf-prof-"))
		resetCollected()
		const cpu0 = process.cpuUsage()
		startProfile()
		const profileClone = await outcomeOf(() =>
			spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${port}/${REPO_ID}`,
				profDest,
			]),
		)
		const profileStop = await outcomeOf(() => stopProfile(opts.outDir))
		outcomeValue(profileClone)
		const profile: ProfileResult = outcomeValue(profileStop)
		const cpu = process.cpuUsage(cpu0)
		const collectors: readonly Collector[] = [...collectedRuns()]
		await verifyClone(profDest, expectedOids)
		rmSync(profDest, { force: true, recursive: true })

		const memDest = mkdtempSync(join(tmpdir(), "pggit-perf-mem-"))
		const proc = collectProcessMetrics()
		const memory = startMemorySampler()
		const memoryClone = await outcomeOf(() =>
			spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${port}/${REPO_ID}`,
				memDest,
			]),
		)
		// Stop the GC observer BEFORE the memory sampler forces a GC for its retained-set
		// read, so the forced collection never pollutes the GC counts. Capture both
		// outcomes so one failed stop never prevents the other sampler from stopping.
		const processStop = outcomeOfSync(() => proc.stop())
		const memoryStop = await outcomeOf(() => memory.stop())
		outcomeValue(memoryClone)
		const processMetrics: ProcessMetrics = outcomeValue(processStop)
		const memoryReport: MemoryReport = outcomeValue(memoryStop)
		await writeFile(
			join(opts.outDir, "memory.json"),
			JSON.stringify({
				rssSeries: memoryReport.rssSeries,
				sampler: memoryReport.sampler,
			}),
		)
		await verifyClone(memDest, expectedOids)
		rmSync(memDest, { force: true, recursive: true })

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
		if (srcRepo) rmSync(srcRepo, { force: true, recursive: true })
	}
}

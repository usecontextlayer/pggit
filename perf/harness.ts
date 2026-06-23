import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGitApp } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import type { GitObjectType } from "@/object/object"
import type { PackInputObject } from "@/pack/write-pack"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { generateRepo } from "./fast-import"
import { startMemorySampler } from "./memory"
import { type PgHandle, startLatencyPg, startPlainPg } from "./pg-latency"
import { collectProcessMetrics } from "./process-metrics"
import { startProfile, stopProfile } from "./profile"
import { assembleReport, type Report } from "./report"
import type { Scenario } from "./scenarios"

const REPO_ID = "perf"

export type RunOptions = {
	scenario: Scenario
	seed: number
	repeat: number
	outDir: string
	/** When set, route Postgres through Toxiproxy and sweep clone wall at 0ms vs this. */
	rttMs: number | null
}

/** Load every object from a real repo (the m0 seeding path: real git, real store). */
async function loadAllObjects(dir: string): Promise<PackInputObject[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const objs: PackInputObject[] = []
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (!oid || !type) continue
		const raw = await spawnGit(["cat-file", type, oid], { cwd: dir })
		objs.push({ content: raw.stdoutBytes, type: type as GitObjectType })
	}
	return objs
}

async function seedStore(
	srcRepo: string,
	db: Awaited<ReturnType<typeof createIsolatedSchema>>,
) {
	const objects = createObjectStore(db.db)
	const refs = createRefStore(db.db)
	const allObjects = await loadAllObjects(srcRepo)
	await objects.putPack(REPO_ID, allObjects)
	const showRef = await spawnGit(["show-ref"], { cwd: srcRepo })
	for (const line of showRef.stdout.trim().split("\n")) {
		const [oid, name] = line.split(" ")
		if (oid && name) await refs.setRef(REPO_ID, name, oid)
	}
	const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: srcRepo })).stdout.trim()
	await refs.setSymref(REPO_ID, "HEAD", head)
	return { objectCount: allObjects.length, objects, refs }
}

/** One `git clone` over loopback; returns its wall time in ms. fsck-verifies when asked. */
async function cloneOnce(port: number, opts: { verify?: boolean } = {}): Promise<number> {
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
		if (opts.verify) await spawnGit(["fsck", "--full"], { cwd: dest })
		return wallMs
	} finally {
		rmSync(dest, { force: true, recursive: true })
	}
}

export async function runScenario(opts: RunOptions): Promise<Report> {
	const pg: PgHandle = opts.rttMs === null ? await startPlainPg() : await startLatencyPg()
	const db = await createIsolatedSchema(pg.baseUrl)
	let server: GitServer | undefined
	let srcRepo: string | undefined
	try {
		srcRepo = await generateRepo(opts.scenario, opts.seed)
		const { objects, refs, objectCount } = await seedStore(srcRepo, db)

		server = await serveOnPort(createGitApp({ objects, refs }, { instrument: true }), 0)
		const port = server.port

		// Best-of-N wall timing at zero latency (no profiler overhead skewing it).
		const wallMsRuns: number[] = []
		for (let i = 0; i < opts.repeat; i++) {
			wallMsRuns.push(await cloneOnce(port, { verify: i === 0 }))
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
		await spawnGit([
			"clone",
			"-c",
			"protocol.version=2",
			"--quiet",
			`http://127.0.0.1:${port}/${REPO_ID}`,
			profDest,
		])
		const profile = await stopProfile(opts.outDir)
		const cpu = process.cpuUsage(cpu0)
		const collectors = [...collectedRuns()]
		await spawnGit(["fsck", "--full"], { cwd: profDest })
		rmSync(profDest, { force: true, recursive: true })

		const memDest = mkdtempSync(join(tmpdir(), "pggit-perf-mem-"))
		const proc = collectProcessMetrics()
		const memory = startMemorySampler()
		await spawnGit([
			"clone",
			"-c",
			"protocol.version=2",
			"--quiet",
			`http://127.0.0.1:${port}/${REPO_ID}`,
			memDest,
		])
		// Stop the GC observer BEFORE the memory sampler forces a GC for its
		// retained-set read, so the forced collection never pollutes the GC counts.
		const processMetrics = proc.stop()
		const memoryReport = await memory.stop()
		await writeFile(
			join(opts.outDir, "memory.json"),
			JSON.stringify({
				rssSeries: memoryReport.rssSeries,
				sampler: memoryReport.sampler,
			}),
		)
		await spawnGit(["fsck", "--full"], { cwd: memDest })
		rmSync(memDest, { force: true, recursive: true })

		// RTT sweep: clone wall at 0ms vs the requested latency (same repo, via proxy).
		const rttSweep: { rttMs: number; wallMs: number }[] = []
		if (opts.rttMs !== null) {
			for (const rtt of [0, opts.rttMs]) {
				await pg.setLatencyMs(rtt)
				rttSweep.push({ rttMs: rtt, wallMs: await cloneOnce(port) })
			}
			await pg.setLatencyMs(0)
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
			rttMs: opts.rttMs,
			rttSweep,
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

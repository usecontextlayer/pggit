import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGitApp } from "@/index"
import { type Collector, collectedRuns, resetCollected } from "@/instrument"
import type { PackInputObject } from "@/pack/write-pack"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	gitReachableOids,
	loadGitObjects,
	requireGitOid,
	seedGitRefs,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { generateRepo } from "./fast-import"
import { type MemoryReport, startMemorySampler } from "./memory"
import { type PgHandle, startLatencyPg, startPlainPg } from "./pg-latency"
import { collectProcessMetrics, type ProcessMetrics } from "./process-metrics"
import { type ProfileResult, startProfile, stopProfile } from "./profile"
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
	const seededRefs = await seedGitRefs(REPO_ID, srcRepo, refs)
	const [stored] = await db.sql<
		{ objects: string; commits: string; tags: string; refs: string }[]
	>`select
		(select count(*) from git_object)::text as objects,
		(select count(*) from git_commit)::text as commits,
		(select count(*) from git_tag)::text as tags,
		(select count(*) from git_ref)::text as refs`
	if (stored === undefined) throw new Error("seed census returned no row")
	const expectedCommits = allObjects.filter((object) => object.type === "commit").length
	const expectedTags = allObjects.filter((object) => object.type === "tag").length
	const expected = {
		commits: expectedCommits,
		objects: allObjects.length,
		refs: seededRefs.directRefs + 1,
		tags: expectedTags,
	}
	const actual = {
		commits: Number(stored.commits),
		objects: Number(stored.objects),
		refs: Number(stored.refs),
		tags: Number(stored.tags),
	}
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`seed census mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		)
	}
	return { objectCount: allObjects.length, objects, refs }
}

async function verifyClone(dir: string, expectedOids: readonly string[]): Promise<void> {
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
			if (fields.length !== 2 || fields[1]?.length === 0) {
				throw new Error(
					`${source} emitted malformed ls-remote row ${JSON.stringify(line)}`,
				)
			}
			return `${requireGitOid(fields[0] as string, `${source} ls-remote row`)}\t${fields[1]}`
		})
		.sort()
}

/** One `git clone` over loopback; returns its wall time in ms. */
async function cloneOnce(port: number, expectedOids: readonly string[]): Promise<number> {
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
	const pg: PgHandle = opts.rttMs === null ? await startPlainPg() : await startLatencyPg()
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
		let profile!: ProfileResult
		startProfile()
		let profileStopError: { error: unknown } | undefined
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${port}/${REPO_ID}`,
				profDest,
			])
		} finally {
			try {
				profile = await stopProfile(opts.outDir)
			} catch (error) {
				profileStopError = { error }
			}
		}
		if (profileStopError) throw profileStopError.error
		const cpu = process.cpuUsage(cpu0)
		const collectors: readonly Collector[] = [...collectedRuns()]
		await verifyClone(profDest, expectedOids)
		rmSync(profDest, { force: true, recursive: true })

		const memDest = mkdtempSync(join(tmpdir(), "pggit-perf-mem-"))
		const proc = collectProcessMetrics()
		const memory = startMemorySampler()
		let processMetrics!: ProcessMetrics
		let memoryReport!: MemoryReport
		let stopError: { error: unknown } | undefined
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${port}/${REPO_ID}`,
				memDest,
			])
		} finally {
			// Stop the GC observer BEFORE the memory sampler forces a GC for its
			// retained-set read, so the forced collection never pollutes the GC counts.
			try {
				processMetrics = proc.stop()
			} catch (error) {
				stopError = { error }
			}
			try {
				memoryReport = await memory.stop()
			} catch (error) {
				stopError ??= { error }
			}
		}
		if (stopError) throw stopError.error
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
		const rttSweep: { rttMs: number; wallMs: number }[] = []
		if (opts.rttMs !== null) {
			for (const rtt of [0, opts.rttMs]) {
				await pg.setLatencyMs(rtt)
				rttSweep.push({ rttMs: rtt, wallMs: await cloneOnce(port, expectedOids) })
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

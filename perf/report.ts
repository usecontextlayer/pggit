import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Collector } from "@/instrument"
import type { MemoryReport } from "./memory"
import type { ProcessMetrics } from "./process-metrics"
import type { Hotspot } from "./profile"
import type { Scenario } from "./scenarios"

export type PhaseReport = {
	name: string
	wallMs: number
	queryCount: number
	dbMs: number
}

/** Memory summary carried in report.json — the full RSS timeseries goes to memory.json. */
export type MemorySummary = Omit<MemoryReport, "rssSeries">

/**
 * The report is split into two layers, the distinction that keeps it valid
 * across the code + schema restructure this harness exists to drive:
 *
 *   contract  — LAYER 1, implementation-AGNOSTIC. Every field is observed at a
 *               boundary (HTTP response / Postgres query log) or the process
 *               level, so it never names an internal function, table, or phase.
 *               This is the before/after yardstick; gains are claimed HERE.
 *
 *   diagnostics — LAYER 2, implementation-COUPLED. Pinpoints where cost lives in
 *               the CURRENT design (per-phase splits, whole-pack re-read counters,
 *               amplification ratios). EXPECTED to go stale or undefined after the
 *               restructure. Never the basis for a gain claim — it is scaffolding.
 */
export type Report = {
	scenario: Scenario
	objectsInRepo: number
	env: { node: string; git: string; repeat: number; rttMs: number | null }
	contract: {
		/** Clone wall time: best-of-N at 0ms, plus the 0-vs-rtt sweep. */
		wall: {
			ms0Min: number
			runs: number[]
			rttSweep: { rttMs: number; wallMs: number }[]
		}
		/** Postgres round-trips per clone — measured at the driver boundary, blind to
		 *  table shape. The single number that most directly tracks the RTT problem. */
		db: { queryCount: number; dbMs: number }
		/** Protocol output: framed bytes on the wire + objects in the served pack. */
		wire: { bytes: number; objectsServed: number }
		cpu: { userMs: number; systemMs: number }
		throughput: { objectsPerSec: number }
		memory: MemorySummary
		process: ProcessMetrics
	}
	diagnostics: {
		phases: PhaseReport[]
		counters: Record<string, number>
		derived: {
			packReadAmplification: number
			getObjectCallsPerObject: number
			gbInflated: number
		}
		hotspots: Hotspot[]
	}
	notes: string[]
	artifacts: {
		reportJson: string
		flamegraph: string
		pprof: string
		hotspotsMd: string
		memoryJson: string
	}
}

// Canonical phase order; phases not seen in a run are dropped.
const PHASE_ORDER = ["ref-advertise", "graph-walk", "read-objects", "write-pack"]

// Counters that are Layer-1 (semantically stable) and surface in the contract;
// everything else `count()` records is Layer-2 diagnostics.
const CONTRACT_COUNTERS = new Set(["wireBytes", "objectsServed"])

export type AssembleInput = {
	scenario: Scenario
	objectsInRepo: number
	gitVersion: string
	repeat: number
	rttMs: number | null
	wallMsRuns: number[]
	serverUserMs: number
	serverSystemMs: number
	collectors: readonly Collector[]
	process: ProcessMetrics
	memory: MemoryReport
	hotspots: Hotspot[]
	rttSweep: { rttMs: number; wallMs: number }[]
	outDir: string
}

export function assembleReport(input: AssembleInput): Report {
	const phaseAgg = new Map<string, PhaseReport>()
	const phase = (name: string): PhaseReport => {
		const existing = phaseAgg.get(name)
		if (existing) return existing
		const created = { dbMs: 0, name, queryCount: 0, wallMs: 0 }
		phaseAgg.set(name, created)
		return created
	}
	const counters: Record<string, number> = {}

	for (const collector of input.collectors) {
		for (const [name, ms] of collector.phaseMs) phase(name).wallMs += ms
		for (const query of collector.queries) {
			const p = phase(query.phase)
			p.queryCount += 1
			p.dbMs += query.durationMs
		}
		for (const [key, value] of collector.counters) {
			counters[key] = (counters[key] ?? 0) + value
		}
	}

	const phases = [...phaseAgg.values()].sort(
		(a, b) => indexOrLast(a.name) - indexOrLast(b.name),
	)

	const wallMsMin = input.wallMsRuns.length > 0 ? Math.min(...input.wallMsRuns) : 0
	const objectsServed = counters.objectsServed ?? 0
	const wireBytes = counters.wireBytes ?? 0
	const packBytes = counters.packBytes ?? 0
	const packBytesRead = counters.packBytesRead ?? 0
	const bytesInflated = counters.bytesInflated ?? 0
	const getObjectCalls = counters.getObjectCalls ?? 0

	// Contract DB metric: sum every recorded query, ignoring its phase tag (the
	// per-phase split is the Layer-2 view). This stays valid across a restructure.
	const queryCount = phases.reduce((n, p) => n + p.queryCount, 0)
	const dbMs = phases.reduce((n, p) => n + p.dbMs, 0)

	// Strip the Layer-1 counters out of the diagnostics counter dump.
	const diagCounters: Record<string, number> = {}
	for (const [key, value] of Object.entries(counters)) {
		if (!CONTRACT_COUNTERS.has(key)) diagCounters[key] = value
	}

	const { rssSeries: _series, ...memorySummary } = input.memory

	return {
		artifacts: {
			flamegraph: join(input.outDir, "flamegraph.html"),
			hotspotsMd: join(input.outDir, "hotspots.md"),
			memoryJson: join(input.outDir, "memory.json"),
			pprof: join(input.outDir, "cpu.pb"),
			reportJson: join(input.outDir, "report.json"),
		},
		contract: {
			cpu: { systemMs: input.serverSystemMs, userMs: input.serverUserMs },
			db: { dbMs, queryCount },
			memory: memorySummary,
			process: input.process,
			throughput: {
				objectsPerSec: wallMsMin > 0 ? objectsServed / (wallMsMin / 1000) : 0,
			},
			wall: { ms0Min: wallMsMin, rttSweep: input.rttSweep, runs: input.wallMsRuns },
			wire: { bytes: wireBytes, objectsServed },
		},
		diagnostics: {
			counters: diagCounters,
			derived: {
				gbInflated: bytesInflated / 1024 / 1024 / 1024,
				getObjectCallsPerObject: objectsServed > 0 ? getObjectCalls / objectsServed : 0,
				packReadAmplification: packBytes > 0 ? packBytesRead / packBytes : 0,
			},
			hotspots: input.hotspots,
			phases,
		},
		env: {
			git: input.gitVersion,
			node: process.version,
			repeat: input.repeat,
			rttMs: input.rttMs,
		},
		notes: [
			"contract = Layer-1, implementation-agnostic. Survives a code/schema restructure; claim gains HERE.",
			"diagnostics = Layer-2, coupled to the current design (whole-pack re-read, per-phase split). EXPECTED to go stale after the restructure — never the basis for a gain claim.",
			"contract.db.queryCount is measured at the Postgres driver boundary, so it is blind to table shape and is the cleanest single readout of the per-object round-trip cost the rtt sweep exposes.",
			"memory.peakRssBytes is sampled off-thread, so it captures peaks during the main-thread sync blocks (deflateSync + SHA-1) a main-thread timer would miss.",
			"memory.peakRssBytes is the WARM-process RSS ceiling: the harness serves several clones in one process and RSS is sticky (the allocator reuses/holds pages), so it is cumulative — representative of a warm long-running server, NOT one clone's footprint. For the per-clone working set read memory.peakByField.",
			"memory.peakByField (heapUsed/external/arrayBuffers) is the per-clone working set — live allocations freed between clones (retained arrayBuffers ~0 confirms it). Main-thread sampled, so it may understate a peak inside a sync block.",
			"memory.retainedAfterGcBytes.rss is sticky (the allocator does not return pages to the OS); read retained heapUsed/external/arrayBuffers for the live set, not retained rss.",
			"Async zlib inflate runs on the libuv threadpool, INVISIBLE to the main-thread CPU flamegraph; read the process + memory metrics to see it.",
		],
		objectsInRepo: input.objectsInRepo,
		scenario: input.scenario,
	}
}

function indexOrLast(name: string): number {
	const i = PHASE_ORDER.indexOf(name)
	return i < 0 ? PHASE_ORDER.length : i
}

export async function writeReport(report: Report): Promise<void> {
	await writeFile(report.artifacts.reportJson, JSON.stringify(report, null, 2))
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`
const ms = (n: number) => `${n.toFixed(1)}ms`

export function printSummary(report: Report): void {
	const { contract: c, diagnostics: d } = report
	const lines: string[] = []
	lines.push("")
	lines.push(`══ pggit perf — ${report.scenario.name} ══`)
	lines.push(
		`repo: ${report.objectsInRepo} objects | git ${report.env.git} | node ${report.env.node}`,
	)

	lines.push("")
	lines.push("── CONTRACT (Layer 1 — agnostic, restructure-proof yardstick) ──")
	lines.push(
		`  clone wall (min of ${report.env.repeat})   ${ms(c.wall.ms0Min)}   cpu user ${ms(c.cpu.userMs)} sys ${ms(c.cpu.systemMs)}`,
	)
	for (const s of c.wall.rttSweep) {
		lines.push(`    ${String(s.rttMs).padStart(4)}ms pg rtt → ${ms(s.wallMs)}`)
	}
	lines.push(
		`  postgres              ${c.db.queryCount} queries / clone   ${ms(c.db.dbMs)} db`,
	)
	lines.push(
		`  wire                  ${mb(c.wire.bytes)} on the wire   ${c.wire.objectsServed} objects   ${c.throughput.objectsPerSec.toFixed(0)} obj/s`,
	)

	lines.push("")
	lines.push("  memory (Layer 1):")
	lines.push(
		`    peak rss (warm ceiling) ${mb(c.memory.peakRssBytes)}  (p99 ${mb(c.memory.rssP99Bytes)}, off-thread)`,
	)
	lines.push(
		`    working set (per clone) heapUsed ${mb(c.memory.peakByField.heapUsed)}  external ${mb(c.memory.peakByField.external)}  arrayBuffers ${mb(c.memory.peakByField.arrayBuffers)}`,
	)
	lines.push(
		`    retained after gc       heapUsed ${mb(c.memory.retainedAfterGcBytes.heapUsed)}  external ${mb(c.memory.retainedAfterGcBytes.external)}  arrayBuffers ${mb(c.memory.retainedAfterGcBytes.arrayBuffers)}  (rss sticky: ${mb(c.memory.retainedAfterGcBytes.rss)})`,
	)
	const g = c.process.gc
	lines.push(
		`    gc                      minor ${g.minor.count}/${ms(g.minor.pauseMs)}  major ${g.major.count}/${ms(g.major.pauseMs)}  incr ${g.incremental.count}/${ms(g.incremental.pauseMs)}`,
	)
	lines.push(
		`    event-loop delay        p99 ${ms(c.process.eventLoopDelayP99Ms)}  max ${ms(c.process.eventLoopDelayMaxMs)}`,
	)
	lines.push(
		`    rss sampler             ${c.memory.sampler.samples} samples @ ${c.memory.sampler.meanIntervalMs.toFixed(2)}ms`,
	)

	lines.push("")
	lines.push("── DIAGNOSTICS (Layer 2 — current impl, disposable) ──")
	lines.push("  phases (wall / queries / db):")
	for (const p of d.phases) {
		lines.push(
			`    ${p.name.padEnd(14)} ${ms(p.wallMs).padStart(11)}  ${String(p.queryCount).padStart(6)} q  ${ms(p.dbMs).padStart(10)} db`,
		)
	}
	lines.push(
		`  packReadAmplification ${d.derived.packReadAmplification.toFixed(0)}x   getObjectCalls/obj ${d.derived.getObjectCallsPerObject.toFixed(1)}x   inflated ${d.derived.gbInflated.toFixed(2)}GB`,
	)
	lines.push("  top hotspots (main-thread self-time):")
	for (const h of d.hotspots.slice(0, 6)) {
		lines.push(`    ${h.selfPct.toFixed(1).padStart(5)}%  ${h.fn}  ${h.file}:${h.line}`)
	}

	lines.push("")
	lines.push(`artifacts: ${report.artifacts.reportJson}`)
	lines.push(`           ${report.artifacts.memoryJson}`)
	lines.push(`           ${report.artifacts.hotspotsMd}`)
	lines.push(`           ${report.artifacts.flamegraph}`)
	lines.push("")
	console.log(lines.join("\n"))
}

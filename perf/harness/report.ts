import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { requiredCollector, requiredPositiveCounter } from "@perf/collector-evidence"
import type { RttEvidence, RttMode } from "@perf/harness/pg-latency"
import type { ProcessMetrics } from "@perf/harness/process-metrics"
import type { Hotspot } from "@perf/harness/profile"
import type { Scenario } from "@perf/harness/scenarios"
import type { MemoryReport } from "@perf/memory"
import type { Collector } from "@/instrument"

type PhaseReport = {
	name: string
	wallMs: number
	queryCount: number
	dbMs: number
}

/** Memory summary carried in report.json — the full RSS timeseries goes to memory.json. */
type MemorySummary = Omit<MemoryReport, "rssSeries">

/**
 * The report is split into two layers so the top-line comparison stays valid
 * across implementation changes:
 *
 *   contract  — LAYER 1, implementation-AGNOSTIC. Every field is observed at a
 *               boundary (HTTP response / Postgres query log) or the process
 *               level, so it never names an internal function, table, or phase.
 *               This is the before/after yardstick; gains are claimed HERE.
 *
 *   diagnostics — LAYER 2, implementation-COUPLED. Pinpoints where cost lives in
 *               the CURRENT design (per-phase splits and counters). Never the basis
 *               for a gain claim — it explains the contract measurements.
 */
export type Report = {
	scenario: Scenario
	objectsInRepo: number
	env: { node: string; git: string; repeat: number; rtt: RttMode }
	contract: {
		/** Clone wall time: best-of-N at 0ms, plus optional 0-vs-rtt evidence. */
		wall: {
			ms0Min: number
			runs: number[]
			rtt: RttEvidence
		}
		/** Postgres query executions per clone — measured at the driver boundary and
		 *  blind to table shape. */
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

// Canonical order for the three required current phases; additional phases sort last.
const PHASE_ORDER = ["ref-advertise", "closure", "pack-encode"]

// Counters that are Layer-1 (semantically stable) and surface in the contract;
// everything else `count()` records is Layer-2 diagnostics.
const CONTRACT_COUNTERS = new Set(["wireBytes", "objectsServed"])

type AssembleInput = {
	scenario: Scenario
	objectsInRepo: number
	gitVersion: string
	repeat: number
	rtt: RttEvidence
	wallMsRuns: number[]
	serverUserMs: number
	serverSystemMs: number
	collectors: readonly Collector[]
	process: ProcessMetrics
	memory: MemoryReport
	hotspots: Hotspot[]
	outDir: string
}

export function assembleReport(input: AssembleInput): Report {
	if (!Number.isSafeInteger(input.objectsInRepo) || input.objectsInRepo < 1) {
		throw new Error("perf report requires a nonempty repository")
	}
	if (
		input.wallMsRuns.length !== input.repeat ||
		!Number.isSafeInteger(input.repeat) ||
		input.repeat < 1
	) {
		throw new Error(
			`perf report expected ${input.repeat} wall samples, got ${input.wallMsRuns.length}`,
		)
	}
	for (const [index, wallMs] of input.wallMsRuns.entries()) {
		if (!Number.isFinite(wallMs) || wallMs <= 0) {
			throw new Error(`perf report wall sample ${index} is invalid: ${wallMs}`)
		}
	}
	for (const [name, value] of Object.entries({
		serverSystemMs: input.serverSystemMs,
		serverUserMs: input.serverUserMs,
	})) {
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`perf report received invalid CPU metric ${name}=${value}`)
		}
	}
	const fetchCollector = requiredCollector(input.collectors, "fetch", "perf report")
	const objectsServed = requiredPositiveCounter(
		fetchCollector,
		"objectsServed",
		"perf report",
	)
	const wireBytes = requiredPositiveCounter(fetchCollector, "wireBytes", "perf report")
	requiredPositiveCounter(fetchCollector, "packBytes", "perf report")
	if (objectsServed !== input.objectsInRepo) {
		throw new Error(
			`fetch collector served ${objectsServed} objects for a ${input.objectsInRepo}-object canonical clone`,
		)
	}
	if (input.rtt.kind === "sweep") {
		if (
			!Number.isFinite(input.rtt.requestedMs) ||
			input.rtt.requestedMs <= 0 ||
			input.rtt.samples[0].rttMs !== 0 ||
			input.rtt.samples[1].rttMs !== input.rtt.requestedMs
		) {
			throw new Error(
				`perf report received invalid RTT evidence: ${JSON.stringify(input.rtt)}`,
			)
		}
		for (const [index, sample] of input.rtt.samples.entries()) {
			if (!Number.isFinite(sample.wallMs) || sample.wallMs <= 0) {
				throw new Error(
					`perf report RTT sample ${index} has invalid wallMs=${sample.wallMs}`,
				)
			}
		}
	}
	if (
		input.memory.peakRssBytes <= 0 ||
		input.memory.sampler.samples < 2 ||
		!Number.isFinite(input.memory.sampler.meanIntervalMs) ||
		input.memory.sampler.meanIntervalMs <= 0
	) {
		throw new Error("perf report received incomplete memory-sampler evidence")
	}
	for (const [name, value] of Object.entries({
		eventLoopDelayMaxMs: input.process.eventLoopDelayMaxMs,
		eventLoopDelayMeanMs: input.process.eventLoopDelayMeanMs,
		eventLoopDelayP99Ms: input.process.eventLoopDelayP99Ms,
	})) {
		if (!Number.isFinite(value)) {
			throw new Error(`perf report received invalid process metric ${name}=${value}`)
		}
	}
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
		for (const [name, ms] of collector.phaseMs) {
			if (!Number.isFinite(ms) || ms < 0) {
				throw new Error(`collector ${collector.label} has invalid ${name} phase=${ms}`)
			}
			phase(name).wallMs += ms
		}
		for (const query of collector.queries) {
			if (!Number.isFinite(query.durationMs) || query.durationMs < 0) {
				throw new Error(
					`collector ${collector.label} has invalid query duration=${query.durationMs}`,
				)
			}
			const p = phase(query.phase)
			p.queryCount += 1
			p.dbMs += query.durationMs
		}
		for (const [key, value] of collector.counters) {
			if (!Number.isFinite(value) || value < 0) {
				throw new Error(
					`collector ${collector.label} has invalid ${key} counter=${value}`,
				)
			}
			counters[key] = (counters[key] ?? 0) + value
		}
	}
	for (const name of PHASE_ORDER) {
		const value = phaseAgg.get(name)?.wallMs
		if (value === undefined || value <= 0) {
			throw new Error(`perf report is missing required positive ${name} phase evidence`)
		}
	}

	const phases = [...phaseAgg.values()].sort(
		(a, b) => indexOrLast(a.name) - indexOrLast(b.name),
	)

	const wallMsMin = Math.min(...input.wallMsRuns)

	// Contract DB metric: sum every recorded query, ignoring its phase tag (the
	// per-phase split is the Layer-2 view). This stays valid across a restructure.
	const queryCount = phases.reduce((n, p) => n + p.queryCount, 0)
	const dbMs = phases.reduce((n, p) => n + p.dbMs, 0)
	if (queryCount < 1) throw new Error("perf report recorded no Postgres queries")

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
				objectsPerSec: objectsServed / (wallMsMin / 1000),
			},
			wall: { ms0Min: wallMsMin, rtt: input.rtt, runs: input.wallMsRuns },
			wire: { bytes: wireBytes, objectsServed },
		},
		diagnostics: {
			counters: diagCounters,
			hotspots: input.hotspots,
			phases,
		},
		env: {
			git: input.gitVersion,
			node: process.version,
			repeat: input.repeat,
			rtt:
				input.rtt.kind === "loopback"
					? { kind: "loopback" }
					: { kind: "sweep", requestedMs: input.rtt.requestedMs },
		},
		notes: [
			"contract = Layer-1, implementation-agnostic. Survives a code/schema restructure; claim gains HERE.",
			"diagnostics = Layer-2, coupled to the current design (phase split and implementation counters). Use them to explain a contract result, never as the result itself.",
			"contract.db.queryCount is measured at the Postgres driver boundary, so it is blind to table shape and counts the query work whose serialized latency the rtt sweep exposes; it does not claim one network round-trip per execution.",
			"memory.peakRssBytes is sampled off-thread, so it captures peaks during synchronous main-thread pack work that a main-thread timer would miss.",
			"memory.peakRssBytes is the WARM-process RSS ceiling: the harness serves several clones in one process and RSS is sticky (the allocator reuses/holds pages), so it is cumulative — representative of a warm long-running server, NOT one clone's footprint.",
			"memory.peakByField is the absolute warm-process peak of heapUsed/external/arrayBuffers during the measured clone. It is main-thread sampled and may understate a peak inside a synchronous block; it is composition evidence, not a per-clone delta.",
			"memory.retainedAfterGcBytes is the absolute process live set after the measured clone and two forced collections. RSS remains sticky; heapUsed/external/arrayBuffers are the useful retained-allocation fields.",
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
	if (c.wall.rtt.kind === "sweep") {
		for (const sample of c.wall.rtt.samples) {
			lines.push(
				`    ${String(sample.rttMs).padStart(4)}ms pg rtt → ${ms(sample.wallMs)}`,
			)
		}
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
		`    field peaks (warm process) heapUsed ${mb(c.memory.peakByField.heapUsed)}  external ${mb(c.memory.peakByField.external)}  arrayBuffers ${mb(c.memory.peakByField.arrayBuffers)}`,
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
	lines.push(`  counters              ${JSON.stringify(d.counters)}`)
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

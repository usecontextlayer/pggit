import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Collector } from "@/instrument"
import type { ProcessMetrics } from "./process-metrics"
import type { Hotspot } from "./profile"
import type { Scenario } from "./scenarios"

export type PhaseReport = {
	name: string
	wallMs: number
	queryCount: number
	dbMs: number
}

export type Report = {
	scenario: Scenario
	objectsInRepo: number
	env: { node: string; git: string; repeat: number; rttMs: number | null }
	clone: {
		wallMsMin: number
		wallMsRuns: number[]
		serverUserMs: number
		serverSystemMs: number
	}
	phases: PhaseReport[]
	counters: Record<string, number>
	derived: {
		objectsPerSec: number
		getObjectCallsPerObject: number
		packReadAmplification: number
		gbInflated: number
	}
	process: ProcessMetrics
	hotspots: Hotspot[]
	rttSweep: { rttMs: number; wallMs: number }[]
	notes: string[]
	artifacts: { reportJson: string; flamegraph: string; pprof: string; hotspotsMd: string }
}

// Canonical phase order; phases not seen in a run are dropped.
const PHASE_ORDER = ["ref-advertise", "graph-walk", "read-objects", "write-pack"]

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
	const packBytes = counters.packBytes ?? 0
	const packBytesRead = counters.packBytesRead ?? 0
	const bytesInflated = counters.bytesInflated ?? 0
	const getObjectCalls = counters.getObjectCalls ?? 0

	const derived = {
		gbInflated: bytesInflated / 1024 / 1024 / 1024,
		getObjectCallsPerObject: objectsServed > 0 ? getObjectCalls / objectsServed : 0,
		objectsPerSec: wallMsMin > 0 ? objectsServed / (wallMsMin / 1000) : 0,
		packReadAmplification: packBytes > 0 ? packBytesRead / packBytes : 0,
	}

	return {
		artifacts: {
			flamegraph: join(input.outDir, "flamegraph.html"),
			hotspotsMd: join(input.outDir, "hotspots.md"),
			pprof: join(input.outDir, "cpu.pb"),
			reportJson: join(input.outDir, "report.json"),
		},
		clone: {
			serverSystemMs: input.serverSystemMs,
			serverUserMs: input.serverUserMs,
			wallMsMin,
			wallMsRuns: input.wallMsRuns,
		},
		counters,
		derived,
		env: {
			git: input.gitVersion,
			node: process.version,
			repeat: input.repeat,
			rttMs: input.rttMs,
		},
		hotspots: input.hotspots,
		notes: [
			"Async zlib inflate runs on the libuv threadpool, NOT the main thread, so it is INVISIBLE to the main-thread CPU flamegraph. Read the read-objects phase wall-time + bytesInflated/packReadAmplification counters to see it.",
			"packReadAmplification = total compressed pack bytes read from PG / size of the served pack. ~1 is ideal; >>1 means getObject re-reads whole packs (O(N^2)).",
			"getObjectCallsPerObject ~2 means every object is read twice (graph-walk enumerate + read-objects).",
		],
		objectsInRepo: input.objectsInRepo,
		phases,
		process: input.process,
		rttSweep: input.rttSweep,
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

export function printSummary(report: Report): void {
	const ms = (n: number) => `${n.toFixed(1)}ms`
	const lines: string[] = []
	lines.push("")
	lines.push(`══ pggit perf — ${report.scenario.name} ══`)
	lines.push(
		`repo: ${report.objectsInRepo} objects | clone wall (min of ${report.env.repeat}): ${ms(report.clone.wallMsMin)} | server cpu: user ${ms(report.clone.serverUserMs)} sys ${ms(report.clone.serverSystemMs)}`,
	)
	lines.push("")
	lines.push("phases (wall / queries / db):")
	for (const p of report.phases) {
		lines.push(
			`  ${p.name.padEnd(14)} ${ms(p.wallMs).padStart(11)}  ${String(p.queryCount).padStart(6)} q  ${ms(p.dbMs).padStart(10)} db`,
		)
	}
	lines.push("")
	lines.push("key counters:")
	lines.push(`  objectsServed         ${report.counters.objectsServed ?? 0}`)
	lines.push(
		`  getObjectCalls        ${report.counters.getObjectCalls ?? 0}  (${report.derived.getObjectCallsPerObject.toFixed(1)}x per served object)`,
	)
	lines.push(
		`  packReadAmplification ${report.derived.packReadAmplification.toFixed(0)}x  (compressed pack bytes re-read vs one served pack)`,
	)
	lines.push(`  bytesInflated         ${report.derived.gbInflated.toFixed(2)} GB`)
	lines.push(
		`  packBytes (served)    ${((report.counters.packBytes ?? 0) / 1024 / 1024).toFixed(2)} MB`,
	)
	lines.push(`  objectsPerSec         ${report.derived.objectsPerSec.toFixed(0)}`)
	lines.push("")
	lines.push("process:")
	lines.push(
		`  event-loop delay p99  ${ms(report.process.eventLoopDelayP99Ms)} (max ${ms(report.process.eventLoopDelayMaxMs)})`,
	)
	lines.push(
		`  gc                    ${report.process.gcCount} pauses, ${ms(report.process.gcPauseMs)} total`,
	)
	lines.push(`  peak rss              ${report.process.peakRssMb.toFixed(0)} MB`)
	lines.push("")
	lines.push("top hotspots (main-thread self-time):")
	for (const h of report.hotspots.slice(0, 8)) {
		lines.push(`  ${h.selfPct.toFixed(1).padStart(5)}%  ${h.fn}  ${h.file}:${h.line}`)
	}
	if (report.rttSweep.length > 0) {
		lines.push("")
		lines.push("rtt sweep (clone wall vs injected pg latency):")
		for (const s of report.rttSweep)
			lines.push(`  ${String(s.rttMs).padStart(5)}ms rtt → ${ms(s.wallMs)}`)
	}
	lines.push("")
	lines.push(`artifacts: ${report.artifacts.reportJson}`)
	lines.push(`           ${report.artifacts.hotspotsMd}`)
	lines.push(`           ${report.artifacts.flamegraph}`)
	lines.push("")
	console.log(lines.join("\n"))
}

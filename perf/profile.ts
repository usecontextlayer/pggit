import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import pprof from "@datadog/pprof"
// @platformatic/flame ships no type declarations; perf/ is run via tsx (not tsc).
import * as flame from "@platformatic/flame"

export type Hotspot = {
	fn: string
	file: string
	line: number
	selfMs: number
	selfPct: number
}

export type ProfileResult = {
	pbPath: string
	mdPath: string
	htmlPath: string
	hotspots: Hotspot[]
}

/**
 * Begin in-process wall-time sampling of THIS (server) process. The git client
 * is a separate child we never profile, so the samples are pure server work.
 * 1ms interval = fine-grained without flooding a short clone.
 */
export function startProfile(): void {
	pprof.time.start({ intervalMicros: 1000 })
}

/**
 * Stop sampling, write the pprof `.pb`, render flame's LLM markdown + HTML
 * flamegraph from it, and reduce the profile to a top-N self-time ranking for
 * `report.json`.
 */
export async function stopProfile(outDir: string, topN = 20): Promise<ProfileResult> {
	const profile = pprof.time.stop()
	const pb = Buffer.from(await pprof.encode(profile))
	const pbPath = join(outDir, "cpu.pb")
	const mdPath = join(outDir, "hotspots.md")
	const htmlPath = join(outDir, "flamegraph.html")
	await writeFile(pbPath, pb)
	await flame.generateMarkdown(pbPath, mdPath, { format: "detailed" })
	await flame.generateFlamegraph(pbPath, htmlPath)
	const hotspots = await topHotspots(pbPath, topN)
	return { hotspots, htmlPath, mdPath, pbPath }
}

// Minimal view of the pprof-format Profile (flame.parseProfile returns it).
type PprofLine = { functionId: number; line: number }
type PprofProfile = {
	sampleType: { type: number; unit: number }[]
	sample: { locationId: number[]; value: number[] }[]
	location: { id: number; line: PprofLine[] }[]
	function: { id: number; name: number; filename: number }[]
	stringTable: { strings: string[] }
}

/** Aggregate self-time (leaf-attributed wall nanos) per function, top-N. */
async function topHotspots(pbPath: string, topN: number): Promise<Hotspot[]> {
	const p = (await flame.parseProfile(pbPath)) as unknown as PprofProfile
	const strings = p.stringTable.strings
	// Prefer the "nanoseconds" wall value over raw sample count.
	const nanoIdx = p.sampleType.findIndex((t) => strings[Number(t.unit)] === "nanoseconds")
	const valueIdx = nanoIdx >= 0 ? nanoIdx : p.sampleType.length - 1
	const funcById = new Map(p.function.map((f) => [Number(f.id), f]))
	const locById = new Map(p.location.map((l) => [Number(l.id), l]))

	const byFn = new Map<
		string,
		{ fn: string; file: string; line: number; nanos: number }
	>()
	let total = 0
	for (const smp of p.sample) {
		const v = Number(smp.value[valueIdx] ?? 0)
		total += v
		const leaf = locById.get(Number(smp.locationId[0]))
		const ln = leaf?.line[0]
		if (!ln) continue
		const fn = funcById.get(Number(ln.functionId))
		if (!fn) continue
		const fnName = strings[Number(fn.name)] || "(anonymous)"
		const file = strings[Number(fn.filename)] || "<native>"
		const key = `${fnName}|${file}:${ln.line}`
		const entry = byFn.get(key) ?? { file, fn: fnName, line: Number(ln.line), nanos: 0 }
		entry.nanos += v
		byFn.set(key, entry)
	}

	return [...byFn.values()]
		.sort((a, b) => b.nanos - a.nanos)
		.slice(0, topN)
		.map((e) => ({
			file: e.file,
			fn: e.fn,
			line: e.line,
			selfMs: e.nanos / 1e6,
			selfPct: total > 0 ? (e.nanos / total) * 100 : 0,
		}))
}

import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import pprof from "@datadog/pprof"
import * as flame from "@platformatic/flame"
import { z } from "zod"

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

const profileIndex = z.coerce.number().int().safe().nonnegative()
const pprofProfileSchema = z.object({
	function: z.array(
		z.object({ filename: profileIndex, id: profileIndex, name: profileIndex }),
	),
	location: z.array(
		z.object({
			id: profileIndex,
			line: z.array(z.object({ functionId: profileIndex, line: profileIndex })),
		}),
	),
	sample: z.array(
		z.object({
			locationId: z.array(profileIndex),
			value: z.array(z.coerce.number().finite().nonnegative()),
		}),
	),
	sampleType: z.array(z.object({ type: profileIndex, unit: profileIndex })),
	stringTable: z.object({ strings: z.array(z.string()) }),
})

/** Aggregate self-time (leaf-attributed wall nanos) per function, top-N. */
async function topHotspots(pbPath: string, topN: number): Promise<Hotspot[]> {
	if (!Number.isSafeInteger(topN) || topN < 1) {
		throw new Error(`topN must be a positive safe integer, got ${topN}`)
	}
	const p = pprofProfileSchema.parse(await flame.parseProfile(pbPath))
	const strings = p.stringTable.strings
	if (p.sampleType.length === 0) throw new Error("profile contains no sample types")
	// The report promises wall self-time, so a count-only profile is not scoreable.
	const nanoIdx = p.sampleType.findIndex((t) => strings[Number(t.unit)] === "nanoseconds")
	if (nanoIdx < 0) throw new Error("profile contains no nanoseconds sample type")
	const funcById = new Map(p.function.map((f) => [Number(f.id), f]))
	const locById = new Map(p.location.map((l) => [Number(l.id), l]))

	const byFn = new Map<
		string,
		{ fn: string; file: string; line: number; nanos: number }
	>()
	let total = 0
	for (const smp of p.sample) {
		const rawValue = smp.value[nanoIdx]
		if (rawValue === undefined) {
			throw new Error(`profile sample omitted nanoseconds value index ${nanoIdx}`)
		}
		const v = Number(rawValue)
		if (!Number.isFinite(v) || v < 0) {
			throw new Error(`profile sample has invalid value ${String(rawValue)}`)
		}
		total += v
		const rawLocationId = smp.locationId[0]
		const leaf =
			rawLocationId === undefined ? undefined : locById.get(Number(rawLocationId))
		const ln = leaf?.line[0]
		const fn = ln === undefined ? undefined : funcById.get(Number(ln.functionId))
		let fnName = "(native/unattributed)"
		let file = "<native>"
		let line = 0
		if (rawLocationId !== undefined && leaf === undefined) {
			fnName = "(unresolved location)"
		} else if (ln !== undefined && fn === undefined) {
			fnName = "(unresolved function)"
		} else if (ln !== undefined && fn !== undefined) {
			const rawName = strings[Number(fn.name)]
			const rawFile = strings[Number(fn.filename)]
			if (rawName === undefined || rawFile === undefined) {
				throw new Error(`profile function ${fn.id} references a missing string`)
			}
			line = Number(ln.line)
			if (!Number.isSafeInteger(line) || line < 0) {
				throw new Error(`profile function ${fn.id} has invalid line ${String(ln.line)}`)
			}
			fnName = rawName || "(anonymous)"
			file = rawFile || "<native>"
		}
		const key = `${fnName}|${file}:${line}`
		const entry = byFn.get(key) ?? { file, fn: fnName, line, nanos: 0 }
		entry.nanos += v
		byFn.set(key, entry)
	}
	if (total <= 0) throw new Error("profile contains no positive samples")

	return [...byFn.values()]
		.sort((a, b) => b.nanos - a.nanos)
		.slice(0, topN)
		.map((e) => ({
			file: e.file,
			fn: e.fn,
			line: e.line,
			selfMs: e.nanos / 1e6,
			selfPct: (e.nanos / total) * 100,
		}))
}

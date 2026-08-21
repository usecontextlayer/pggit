import { Worker } from "node:worker_threads"
import { z } from "zod"

/**
 * Layer-1 (implementation-agnostic) memory instrumentation. Everything here is a
 * process-level observation of the server serving a real clone — peak RSS, the
 * `memoryUsage()` field breakdown, and the post-GC retained set. None of it
 * names an internal function, table, or phase, so it stays a valid before/after
 * yardstick straight across a code or schema restructure.
 *
 * The headline (peak RSS) is sampled from a WORKER thread on purpose: the serve
 * path can block the main thread during synchronous pack assembly,
 * during which a main-thread timer is starved and would miss the very peak we
 * care about. RSS is an OS-level, process-wide number, so a worker reads the
 * true main-thread peak even while main is blocked. The per-field breakdown
 * (`external`/`arrayBuffers` etc.) is per-isolate and so can only come from the
 * main thread — it captures composition, and may understate a peak that lands
 * inside a sync block; peak RSS is the authority for total residency.
 */

/** One `process.memoryUsage()` reading. Bytes. */
export type MemoryBreakdown = {
	arrayBuffers: number
	external: number
	heapTotal: number
	heapUsed: number
	rss: number
}

type NonEmptySamples<T> = readonly [T, ...T[]]
type RssSample = [number, number]
type RssSeries = [RssSample, RssSample, ...RssSample[]]

/** Establish a measurement boundary before reducers score a series. */
export function requireSamples<T>(samples: readonly T[]): NonEmptySamples<T> {
	const [first, ...rest] = samples
	if (first === undefined) throw new Error("measurement requires at least one sample")
	return [first, ...rest]
}

/** Project a validated RSS series without losing its nonempty evidence type. */
export function rssBytes(series: RssSeries): [number, number, ...number[]] {
	const [first, second, ...rest] = series
	return [first[1], second[1], ...rest.map(([, bytes]) => bytes)]
}

export type MemoryReport = {
	/** True peak RSS (bytes), off-thread sampled — survives main-thread sync blocks. */
	peakRssBytes: number
	/** Peak RSS percentiles over the run, for curve shape (p50/p99). */
	rssP50Bytes: number
	rssP99Bytes: number
	/** Peak of each `memoryUsage()` field (bytes), main-thread sampled (composition). */
	peakByField: MemoryBreakdown
	/** Live set after a forced full GC once the request settled — resting / leak signal. */
	retainedAfterGcBytes: MemoryBreakdown
	/** Off-thread RSS timeseries: `[msSinceStart, rssBytes]` — written to the artifact. */
	rssSeries: RssSeries
	/** Honesty: how densely the off-thread sampler actually fired. */
	sampler: { samples: number; meanIntervalMs: number }
}

/** Max of a measured series. Folds (never spreads) because series can be huge. */
export function peakOf(values: NonEmptySamples<number>): number {
	const [first, ...rest] = values
	let max = first
	for (const value of rest) if (value > max) max = value
	return max
}

/** Median of a measured series, averaging the middle pair for an even sample count. */
export function median(values: NonEmptySamples<number>): number {
	const sorted = [...values].sort((a, b) => a - b)
	const midpoint = Math.floor(sorted.length / 2)
	const upper = sorted.at(midpoint)
	if (upper === undefined) throw new Error("median requires a non-empty sample")
	if (sorted.length % 2 === 1) return upper
	const lower = sorted.at(midpoint - 1)
	if (lower === undefined) throw new Error("median requires a lower middle sample")
	return (lower + upper) / 2
}

/** Nearest-rank percentile of a measured series (p in [0,100]). */
export function percentile(values: NonEmptySamples<number>, p: number): number {
	if (!Number.isFinite(p) || p < 0 || p > 100) {
		throw new Error(`percentile must be between 0 and 100, got ${p}`)
	}
	const sorted: [number, ...number[]] = [...values]
	sorted.sort((a, b) => a - b)
	const [minimum, ...remaining] = sorted
	if (p === 0) return minimum
	const rank = Math.ceil((p / 100) * values.length)
	let value = minimum
	let position = 1
	for (const candidate of remaining) {
		if (position >= rank) break
		value = candidate
		position += 1
	}
	return value
}

/** Element-wise max across breakdown samples. */
export function peakPerField(samples: NonEmptySamples<MemoryBreakdown>): MemoryBreakdown {
	const [first, ...rest] = samples
	const peak = { ...first }
	for (const sample of rest) {
		peak.arrayBuffers = Math.max(peak.arrayBuffers, sample.arrayBuffers)
		peak.external = Math.max(peak.external, sample.external)
		peak.heapTotal = Math.max(peak.heapTotal, sample.heapTotal)
		peak.heapUsed = Math.max(peak.heapUsed, sample.heapUsed)
		peak.rss = Math.max(peak.rss, sample.rss)
	}
	return peak
}

function breakdownOf(u: NodeJS.MemoryUsage): MemoryBreakdown {
	return {
		arrayBuffers: u.arrayBuffers,
		external: u.external,
		heapTotal: u.heapTotal,
		heapUsed: u.heapUsed,
		rss: u.rss,
	}
}

/**
 * Force a full GC and read the live set. Twice: the first collection runs
 * finalizers that release native (ArrayBuffer) backing stores, the second
 * reclaims what they freed. Fails loud if `--expose-gc` is absent — a silent
 * skip would hide that the retained number is missing.
 */
function retainedAfterGc(): MemoryBreakdown {
	const gc = Reflect.get(globalThis, "gc")
	if (typeof gc !== "function") {
		throw new Error(
			"perf/memory: retained-set measurement needs --expose-gc (the `perf` script sets NODE_OPTIONS=--expose-gc)",
		)
	}
	gc()
	gc()
	return breakdownOf(process.memoryUsage())
}

// An inline worker (eval source, not a separate TS file) so we depend on no
// TS-in-worker loader. It samples process-wide RSS every ~1ms into a series and
// posts it back on `stop`. `performance`/`process` are Node globals in a worker.
const RSS_WORKER_SRC = `
const { parentPort } = require("node:worker_threads")
const start = performance.now()
const series = [[0, process.memoryUsage().rss]]
const timer = setInterval(() => {
	series.push([performance.now() - start, process.memoryUsage().rss])
}, 1)
parentPort.on("message", () => {
	clearInterval(timer)
	parentPort.postMessage(series)
})
`

const rssSampleSchema = z.tuple([
	z.number().finite().nonnegative(),
	z.number().int().safe().nonnegative(),
])
const rssSeriesSchema = z.tuple([rssSampleSchema, rssSampleSchema], rssSampleSchema)

export function startRssSampler(): { stop: () => Promise<RssSeries> } {
	const worker = new Worker(RSS_WORKER_SRC, { eval: true })
	return {
		stop: async () => {
			try {
				const series = await new Promise<RssSeries>((resolve, reject) => {
					worker.once("message", (message: unknown) => {
						resolve(rssSeriesSchema.parse(message))
					})
					worker.once("error", reject)
					worker.once("exit", (code) => {
						reject(new Error(`RSS sampler exited ${code} before returning its series`))
					})
					worker.postMessage("stop")
				})
				const [first, second, ...rest] = series
				const firstAt = first[0]
				const lastAt = (rest.at(-1) ?? second)[0]
				if (lastAt <= firstAt) {
					throw new Error(
						`RSS sampler returned no positive sampling span: ${firstAt}..${lastAt}`,
					)
				}
				return series
			} finally {
				await worker.terminate()
			}
		},
	}
}

function startBreakdownSampler(): { stop: () => MemoryBreakdown } {
	const samples: [MemoryBreakdown, ...MemoryBreakdown[]] = [
		breakdownOf(process.memoryUsage()),
	]
	const timer = setInterval(() => samples.push(breakdownOf(process.memoryUsage())), 5)
	return {
		stop: () => {
			clearInterval(timer)
			samples.push(breakdownOf(process.memoryUsage()))
			return peakPerField(samples)
		},
	}
}

/**
 * Begin sampling memory for one clone. `stop()` ends both samplers, forces a GC
 * to read the retained set, and reduces everything to a {@link MemoryReport}.
 */
export function startMemorySampler(): { stop: () => Promise<MemoryReport> } {
	const rss = startRssSampler()
	const breakdown = startBreakdownSampler()
	return {
		stop: async () => {
			const peakByField = breakdown.stop()
			const series = await rss.stop()
			const [first, second, ...rest] = series
			const last = rest.at(-1) ?? second
			const [firstAt] = first
			const [lastAt] = last
			const retainedAfterGcBytes = retainedAfterGc()
			const rssValues = rssBytes(series)
			const meanIntervalMs = (lastAt - firstAt) / (series.length - 1)
			return {
				peakByField,
				peakRssBytes: peakOf(rssValues),
				retainedAfterGcBytes,
				rssP50Bytes: percentile(rssValues, 50),
				rssP99Bytes: percentile(rssValues, 99),
				rssSeries: series,
				sampler: { meanIntervalMs, samples: series.length },
			}
		},
	}
}

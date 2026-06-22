import { Worker } from "node:worker_threads"

/**
 * Layer-1 (implementation-agnostic) memory instrumentation. Everything here is a
 * process-level observation of the server serving a real clone — peak RSS, the
 * `memoryUsage()` field breakdown, and the post-GC retained set. None of it
 * names an internal function, table, or phase, so it stays a valid before/after
 * yardstick straight across a code or schema restructure.
 *
 * The headline (peak RSS) is sampled from a WORKER thread on purpose: the serve
 * path blocks the main thread (synchronous `deflateSync` + SHA-1 over the pack),
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
	rssSeries: [number, number][]
	/** Honesty: how densely the off-thread sampler actually fired. */
	sampler: { samples: number; meanIntervalMs: number }
}

/** Max of `values`; 0 for an empty series. Folds (never spreads) — series can be huge. */
export function peakOf(values: number[]): number {
	let max = 0
	for (const v of values) if (v > max) max = v
	return max
}

/** Nearest-rank percentile of `values` (p in [0,100]); 0 for an empty series. */
export function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	if (p <= 0) return sorted[0] as number
	const rank = Math.ceil((p / 100) * sorted.length)
	const idx = Math.min(rank, sorted.length) - 1
	return sorted[idx] as number
}

/** Element-wise max across breakdown samples; all-zero for no samples. */
export function peakPerField(samples: MemoryBreakdown[]): MemoryBreakdown {
	return {
		arrayBuffers: peakOf(samples.map((s) => s.arrayBuffers)),
		external: peakOf(samples.map((s) => s.external)),
		heapTotal: peakOf(samples.map((s) => s.heapTotal)),
		heapUsed: peakOf(samples.map((s) => s.heapUsed)),
		rss: peakOf(samples.map((s) => s.rss)),
	}
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
	const gc = (globalThis as { gc?: () => void }).gc
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
const series = []
const start = performance.now()
const timer = setInterval(() => {
	series.push([performance.now() - start, process.memoryUsage().rss])
}, 1)
parentPort.on("message", () => {
	clearInterval(timer)
	parentPort.postMessage(series)
})
`

function startRssSampler(): { stop: () => Promise<[number, number][]> } {
	const worker = new Worker(RSS_WORKER_SRC, { eval: true })
	return {
		stop: async () => {
			const series = await new Promise<[number, number][]>((resolve, reject) => {
				worker.once("message", (m: [number, number][]) => resolve(m))
				worker.once("error", reject)
				worker.postMessage("stop")
			})
			await worker.terminate()
			return series
		},
	}
}

function startBreakdownSampler(): { stop: () => MemoryBreakdown } {
	const samples: MemoryBreakdown[] = [breakdownOf(process.memoryUsage())]
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
			const retainedAfterGcBytes = retainedAfterGc()
			const rssValues = series.map(([, bytes]) => bytes)
			const meanIntervalMs =
				series.length > 1
					? ((series.at(-1) as [number, number])[0] -
							(series[0] as [number, number])[0]) /
						(series.length - 1)
					: 0
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

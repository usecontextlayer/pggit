import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks"

/**
 * Whole-process metrics for one scenario run. The event-loop delay histogram is
 * the proof that synchronous `deflateSync` blocks the loop; the GC totals and
 * peak RSS round out the picture the CPU flamegraph can't show.
 */
export type ProcessMetrics = {
	eventLoopDelayMeanMs: number
	eventLoopDelayMaxMs: number
	eventLoopDelayP99Ms: number
	gcCount: number
	gcPauseMs: number
	peakRssMb: number
}

export function collectProcessMetrics(): { stop: () => ProcessMetrics } {
	const eld = monitorEventLoopDelay({ resolution: 10 })
	eld.enable()

	let gcCount = 0
	let gcPauseMs = 0
	const gcObserver = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			gcCount += 1
			gcPauseMs += entry.duration // PerformanceEntry.duration is milliseconds
		}
	})
	gcObserver.observe({ entryTypes: ["gc"] })

	let peakRss = process.memoryUsage().rss
	const sample = () => {
		const rss = process.memoryUsage().rss
		if (rss > peakRss) peakRss = rss
	}
	const interval = setInterval(sample, 20)

	return {
		stop() {
			clearInterval(interval)
			sample()
			eld.disable()
			gcObserver.disconnect()
			return {
				eventLoopDelayMaxMs: eld.max / 1e6,
				eventLoopDelayMeanMs: eld.mean / 1e6,
				eventLoopDelayP99Ms: eld.percentile(99) / 1e6,
				gcCount,
				gcPauseMs,
				peakRssMb: peakRss / 1024 / 1024,
			}
		},
	}
}

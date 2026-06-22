import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks"

/**
 * Layer-1 (implementation-agnostic) process-health signals for one clone. The
 * event-loop delay histogram is the proof that synchronous `deflateSync` blocks
 * the loop; the GC breakdown is the allocation-pressure readout. Both are
 * process-level — they survive any code or schema restructure unchanged.
 *
 * Memory residency (peak RSS, field breakdown, retained set) lives in
 * `perf/memory.ts`; RSS is sampled off-thread there so it survives the very
 * sync blocks this module's event-loop delay measures.
 */

export type GcBucket = { count: number; pauseMs: number }

export type ProcessMetrics = {
	eventLoopDelayMeanMs: number
	eventLoopDelayMaxMs: number
	eventLoopDelayP99Ms: number
	/** GC split by kind: minor = scavenge (young gen), major = mark-compact (the
	 *  expensive one), plus incremental marking and weak-callback passes. */
	gc: {
		minor: GcBucket
		major: GcBucket
		incremental: GcBucket
		weakCb: GcBucket
		totalCount: number
		totalPauseMs: number
	}
}

// V8 GC kinds as exposed on `gc` PerformanceEntry `detail.kind` (probed, not
// guessed: MINOR=1, MAJOR=4, INCREMENTAL=8, WEAKCB=16 on this Node).
const GC_KIND = {
	[constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
	[constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
	[constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
	[constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakCb",
} as const

export function collectProcessMetrics(): { stop: () => ProcessMetrics } {
	const eld = monitorEventLoopDelay({ resolution: 10 })
	eld.enable()

	const gc = {
		incremental: { count: 0, pauseMs: 0 },
		major: { count: 0, pauseMs: 0 },
		minor: { count: 0, pauseMs: 0 },
		weakCb: { count: 0, pauseMs: 0 },
	}
	const gcObserver = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			const kind = (entry.detail as { kind: number } | undefined)?.kind
			const bucket = kind === undefined ? undefined : GC_KIND[kind]
			if (!bucket) continue
			gc[bucket].count += 1
			gc[bucket].pauseMs += entry.duration // PerformanceEntry.duration is milliseconds
		}
	})
	gcObserver.observe({ entryTypes: ["gc"] })

	return {
		stop() {
			eld.disable()
			gcObserver.disconnect()
			return {
				eventLoopDelayMaxMs: eld.max / 1e6,
				eventLoopDelayMeanMs: eld.mean / 1e6,
				eventLoopDelayP99Ms: eld.percentile(99) / 1e6,
				gc: {
					...gc,
					totalCount:
						gc.minor.count + gc.major.count + gc.incremental.count + gc.weakCb.count,
					totalPauseMs:
						gc.minor.pauseMs +
						gc.major.pauseMs +
						gc.incremental.pauseMs +
						gc.weakCb.pauseMs,
				},
			}
		},
	}
}

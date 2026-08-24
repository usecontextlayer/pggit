import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks"
import { z } from "zod"

/**
 * Layer-1 (implementation-agnostic) process-health signals for one clone. The
 * event-loop delay histogram measures synchronous main-thread stalls; the GC
 * breakdown is the allocation-pressure readout. Both are
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
	gc: {
		minor: GcBucket
		major: GcBucket
		incremental: GcBucket
		weakCb: GcBucket
		totalCount: number
		totalPauseMs: number
	}
}

type GcBucketName = "minor" | "major" | "incremental" | "weakCb"
const GC_KIND = new Map<number, GcBucketName>([
	[constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
	[constants.NODE_PERFORMANCE_GC_MAJOR, "major"],
	[constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
	[constants.NODE_PERFORMANCE_GC_WEAKCB, "weakCb"],
])
const gcDetailSchema = z.object({ kind: z.number().int().safe() })

export function collectProcessMetrics(): { stop: () => ProcessMetrics } {
	const eld = monitorEventLoopDelay({ resolution: 10 })
	eld.enable()

	const gc = {
		incremental: { count: 0, pauseMs: 0 },
		major: { count: 0, pauseMs: 0 },
		minor: { count: 0, pauseMs: 0 },
		weakCb: { count: 0, pauseMs: 0 },
	}
	let gcBoundary: { status: "valid" } | { status: "invalid"; detail: unknown } = {
		status: "valid",
	}
	const gcObserver = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			const parsed = gcDetailSchema.safeParse(Reflect.get(entry, "detail"))
			if (!parsed.success) {
				gcBoundary = { detail: parsed.error, status: "invalid" }
				continue
			}
			const bucket = GC_KIND.get(parsed.data.kind)
			if (bucket === undefined) {
				gcBoundary = { detail: parsed.data, status: "invalid" }
				continue
			}
			gc[bucket].count += 1
			gc[bucket].pauseMs += entry.duration // PerformanceEntry.duration is milliseconds
		}
	})
	gcObserver.observe({ entryTypes: ["gc"] })

	return {
		stop() {
			eld.disable()
			gcObserver.disconnect()
			if (gcBoundary.status === "invalid") {
				throw new Error(`invalid Node performance GC detail ${String(gcBoundary.detail)}`)
			}
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

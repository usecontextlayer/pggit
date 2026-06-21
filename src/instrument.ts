import { AsyncLocalStorage } from "node:async_hooks"
import { performance } from "node:perf_hooks"

/**
 * Request-scoped performance instrumentation. The perf harness activates a
 * per-request {@link Collector} via {@link runRequest}; everything else
 * (`withPhase`/`count`/`label`/`recordQuery`) reads the active collector from an
 * AsyncLocalStorage and is a **no-op when none is active**. Production and the
 * oracle tests never call `runRequest`, so they pay nothing but a `Map.get`.
 *
 * Concurrency note: phase attribution uses a single mutable `current` per
 * collector. That is correct because a single git request runs its phases
 * (graph-walk → read-objects → write-pack) sequentially, never overlapping.
 */

export type QueryRecord = { sql: string; durationMs: number; phase: string }

export type Collector = {
	/** What the request turned out to be (`fetch` / `ls-refs`), set by the handler. */
	label: string
	method: string
	path: string
	/** The phase a query/counter is currently attributed to. */
	current: string
	/** Phase name → total wall ms spent in that phase. */
	phaseMs: Map<string, number>
	/** Counter name → accumulated value. */
	counters: Map<string, number>
	queries: QueryRecord[]
}

const als = new AsyncLocalStorage<Collector>()
const collected: Collector[] = []

/** Every collector recorded since the last {@link resetCollected}. */
export function collectedRuns(): readonly Collector[] {
	return collected
}

export function resetCollected(): void {
	collected.length = 0
}

function newCollector(method: string, path: string): Collector {
	return {
		counters: new Map(),
		current: "request",
		label: "",
		method,
		path,
		phaseMs: new Map(),
		queries: [],
	}
}

/** Run `fn` inside a fresh per-request collector; record the collector when done. */
export async function runRequest<T>(
	meta: { method: string; path: string },
	fn: () => Promise<T>,
): Promise<T> {
	const collector = newCollector(meta.method, meta.path)
	return als.run(collector, async () => {
		try {
			return await fn()
		} finally {
			collected.push(collector)
		}
	})
}

/** Measure `fn`'s wall time into the active collector under `name`; no-op when inactive. */
export async function withPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const collector = als.getStore()
	if (!collector) return fn()
	const previous = collector.current
	collector.current = name
	const start = performance.now()
	try {
		return await fn()
	} finally {
		const elapsed = performance.now() - start
		collector.phaseMs.set(name, (collector.phaseMs.get(name) ?? 0) + elapsed)
		collector.current = previous
	}
}

export function count(metric: string, n = 1): void {
	const collector = als.getStore()
	if (!collector) return
	collector.counters.set(metric, (collector.counters.get(metric) ?? 0) + n)
}

export function label(name: string): void {
	const collector = als.getStore()
	if (collector) collector.label = name
}

export function recordQuery(sql: string, durationMs: number): void {
	const collector = als.getStore()
	if (!collector) return
	collector.queries.push({ durationMs, phase: collector.current, sql })
}

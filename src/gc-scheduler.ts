import type { Sql } from "postgres"
import { createGc } from "@/store/gc"

/**
 * Self-scheduling GC — the background drain that decides WHEN the per-repo
 * reachability GC (`store/gc.ts`) runs, off the push/fetch hot path. See
 * `docs/2026-06-24-gc-scheduler-design.md`; the observable contract is §6 of that
 * doc (SCH-1 … SCH-11 / PBT-S1).
 *
 * Mechanism (data-structures-first): every storage-mutating push stamps
 * `repos.last_pushed_at` in its own transaction (the store), so the scheduler is a
 * pure poll loop over Postgres with NO coupling to the request path. One pass
 * (`drainOnce`) selects the eligible repos — `last_pushed_at > last_gc_at`
 * (or `last_gc_at is null`) — and runs `gc()` on each (per-repo serialized,
 * bounded concurrency), then advances `last_gc_at` to the pass's start time so a
 * push landing mid-pass re-qualifies the repo next loop (no lost garbage). `start`
 * is just `drainOnce` on a `setInterval`; all correctness lives in `drainOnce`,
 * which the tests drive directly (the timer is never in a test's critical path).
 */

/** One repo's outcome in a drain pass: the repo and what its GC reclaimed.
 * Emitted for EVERY repo the pass judged eligible (including zero-reclaim), so the
 * eligible set itself is observable (SCH-3). */
export type DrainEntry = { repo: string; deletedObjects: number; deletedEdges: number }

/** What one `drainOnce()` reclaimed, one entry per eligible repo. */
export type DrainSummary = DrainEntry[]

/** Scheduler tunables (resolved from `env` / `startServer` opts). `graceSeconds`
 * is passed straight to `gc()`; `intervalMs` is the drain cadence (the debounce
 * window); `concurrency` caps repos GC'd at once per pass so one large-orphan repo
 * cannot head-of-line-block the rest. */
export type GcSchedulerOptions = {
	graceSeconds: number
	intervalMs: number
	concurrency: number
}

export type GcScheduler = ReturnType<typeof createGcScheduler>

/** A candidate repo for one drain pass: its id + wire name. The pass-start
 * watermark is captured per-repo (in `drainRepo`, before that repo's GC snapshot)
 * and written back as `last_gc_at`. */
type Candidate = { id: string; name: string }

/**
 * Build the GC scheduler over a porsager client (the same wire→DB boundary the
 * stores take). `drainOnce()` runs one poll+sweep pass; `start()`/`stop()` drive
 * it on `intervalMs`. Reachable objects are never touched — it only invokes the
 * per-repo GC primitive, which is reachability-safe.
 */
export function createGcScheduler(pg: Sql, opts: GcSchedulerOptions) {
	const gc = createGc(pg)
	let timer: ReturnType<typeof setInterval> | undefined
	// The in-flight pass (if any). Doubles as the overlap guard (a tick skips while a
	// pass runs, so two passes never touch the same repo at once) and the shutdown
	// barrier (`stop()` awaits it).
	let inFlight: Promise<unknown> | undefined

	/** The eligible repos for this pass — the §2 predicate. */
	async function selectCandidates(): Promise<Candidate[]> {
		return pg<Candidate[]>`
			select r.id::text as id, r.name
			from repos r
			where r.last_pushed_at is not null
				and (r.last_gc_at is null or r.last_pushed_at > r.last_gc_at)
		`
	}

	/**
	 * GC one candidate. `t0 = clock_timestamp()` is captured BEFORE `gc()` opens its
	 * snapshot, then written as `last_gc_at` after the sweep: any push committing
	 * after t0 re-stamps `last_pushed_at > t0` (the store stamps after commit) and
	 * re-qualifies the repo next pass (no lost garbage). A per-repo failure is
	 * ISOLATED — logged and skipped (the repo keeps its old `last_gc_at`, so it
	 * re-qualifies and is retried next pass) — so one poison repo never aborts the
	 * rest of the pass. `maintain: false`: the drain leans on autovacuum, never a
	 * per-pass full-table VACUUM (gc.ts).
	 */
	async function drainRepo(c: Candidate): Promise<DrainEntry | null> {
		try {
			const [t] = await pg<{ t0: string }[]>`select clock_timestamp()::text as t0`
			if (!t) throw new Error("pggit gc-scheduler: clock_timestamp() returned no row")
			const { deletedObjects, deletedEdges } = await gc.gc(c.name, {
				graceSeconds: opts.graceSeconds,
				maintain: false,
			})
			await pg`update repos set last_gc_at = ${t.t0}::timestamptz where id = ${c.id}::bigint`
			return { deletedEdges, deletedObjects, repo: c.name }
		} catch (err) {
			console.error(
				`pggit gc-scheduler: GC of repo ${JSON.stringify(c.name)} failed (retried next pass):`,
				err,
			)
			return null
		}
	}

	/** One drain pass: GC every eligible repo (bounded concurrency, distinct repos so
	 * a pass never double-GCs one). Returns an entry per repo GC'd this pass — a repo
	 * whose GC threw is skipped (not in the summary) and retried next pass. */
	async function drainOnce(): Promise<DrainSummary> {
		const candidates = await selectCandidates()
		const results = await mapPool(candidates, Math.max(1, opts.concurrency), drainRepo)
		return results.filter((e): e is DrainEntry => e !== null)
	}

	/** Run the drain on `intervalMs`. The `inFlight` guard ensures passes never
	 * overlap — so two passes can never touch the same repo at once — and a slow pass
	 * simply skips the next tick. A pass failure is logged, never thrown into the
	 * timer. The timer is `unref`'d so it alone does not keep the process alive (the
	 * server's socket does). */
	function start(): void {
		if (timer) return
		timer = setInterval(() => {
			if (inFlight) return
			inFlight = drainOnce()
				.catch((err) => {
					console.error("pggit gc-scheduler: drain pass failed:", err)
				})
				.finally(() => {
					inFlight = undefined
				})
		}, opts.intervalMs)
		timer.unref?.()
	}

	/** Halt the background drain and AWAIT any pass already in flight, so a caller may
	 * safely tear the connection pool down afterwards (no query runs into a closed
	 * pool). Idempotent. */
	async function stop(): Promise<void> {
		if (timer) {
			clearInterval(timer)
			timer = undefined
		}
		await inFlight
	}

	return { drainOnce, start, stop }
}

/** Run `fn` over `items` with at most `limit` concurrent, preserving result order.
 * A bounded worker pool — `limit` workers pull from a shared cursor — so one
 * large-orphan repo cannot head-of-line-block the rest of a pass. */
async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let cursor = 0
	async function worker(): Promise<void> {
		for (;;) {
			const i = cursor++
			if (i >= items.length) return
			results[i] = await fn(items[i] as T)
		}
	}
	const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
	await Promise.all(workers)
	return results
}

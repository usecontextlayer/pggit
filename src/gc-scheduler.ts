import type { Sql } from "postgres"
import { z } from "zod"
import { createGc, GcGraceSecondsSchema, type GcResult } from "@/store/gc"

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
 * bounded concurrency). A pass advances `last_gc_at` to its start time only after
 * the repo's grace horizon; a younger repo remains eligible, and a push landing
 * mid-pass also re-qualifies it (no lost garbage). `start` is just `drainOnce` on
 * a `setInterval`; all correctness lives in `drainOnce`, which tests drive
 * directly.
 */

/** One repo's outcome in a drain pass: the repo and what its GC reclaimed.
 * Emitted for EVERY repo the pass judged eligible (including zero-reclaim), so the
 * eligible set itself is observable (SCH-3). */
export type DrainEntry = GcResult & {
	repo: string
	/** False while garbage YOUNGER than grace may still exist (the pass ran
	 * inside the grace window): the repo deliberately stays eligible and is
	 * re-drained next tick, so post-grace residue is never orphaned forever. */
	settled: boolean
}

/** What one `drainOnce()` reclaimed, one entry per eligible repo. */
export type DrainSummary = DrainEntry[]

/** A candidate repo for one drain pass: its id + wire name. The pass-start
 * watermark is captured per-repo (in `drainRepo`, before that repo's GC snapshot)
 * and written back as `last_gc_at`. */
type Candidate = { id: string; name: string }

const MAX_TIMER_MS = 2_147_483_647

const GcSchedulerOptionsSchema = z
	.object({
		concurrency: z.number().int().positive(),
		graceSeconds: GcGraceSecondsSchema,
		intervalMs: z.number().int().positive().max(MAX_TIMER_MS),
	})
	.strict()

/** Scheduler tunables (resolved from `env` / `startServer` opts). `graceSeconds`
 * is passed straight to `gc()`; `intervalMs` is the drain cadence (the debounce
 * window); `concurrency` caps repos GC'd at once per pass so one large-orphan repo
 * cannot head-of-line-block the rest. */
export type GcSchedulerOptions = z.infer<typeof GcSchedulerOptionsSchema>

export type GcScheduler = ReturnType<typeof createGcScheduler>

/** Resolve the scheduler's configuration before any resource is opened from it. */
export function resolveGcSchedulerOptions(opts: GcSchedulerOptions): GcSchedulerOptions {
	return GcSchedulerOptionsSchema.parse(opts)
}

/**
 * Build the GC scheduler over a porsager client (the same wire→DB boundary the
 * stores take). `drainOnce()` runs one poll+sweep pass; `start()`/`stop()` drive
 * it on `intervalMs`. Reachable objects are never touched — it only invokes the
 * per-repo GC primitive, which is reachability-safe.
 */
export function createGcScheduler(pg: Sql, opts: GcSchedulerOptions) {
	return createGcSchedulerFromResolvedOptions(pg, resolveGcSchedulerOptions(opts))
}

/** Internal composition seam for `startServer`, which resolves before sizing its pool. */
export function createGcSchedulerFromResolvedOptions(pg: Sql, opts: GcSchedulerOptions) {
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
	type DrainAttempt = { outcome: "drained"; entry: DrainEntry } | { outcome: "failed" }

	async function drainRepo(c: Candidate): Promise<DrainAttempt> {
		try {
			const [{ t0 }] = await pg<[{ t0: string }]>`select clock_timestamp()::text as t0`
			const { deletedObjects, epoch } = await gc.gc(c.name, {
				graceSeconds: opts.graceSeconds,
				maintain: false,
			})
			// Settle ONLY when this pass ran past the grace horizon of the repo's
			// last push: a pass inside the window sees young garbage the grace
			// cutoff protects, and stamping it caught-up would orphan that
			// garbage FOREVER once it ages (nothing re-qualifies the repo). Not
			// stamping keeps it eligible — a bounded number of cheap re-passes
			// (unchanged tips skip the walk) until one runs post-grace. The WHERE
			// also fails when a push landed mid-pass (last_pushed_at > t0), the
			// standing no-lost-garbage rule.
			const settledRows = await pg<{ id: string }[]>`
				update repos set last_gc_at = ${t0}::timestamptz
				where id = ${c.id}::bigint
					and last_pushed_at + make_interval(secs => ${opts.graceSeconds}::float8)
						<= ${t0}::timestamptz
				returning id::text as id`
			return {
				entry: { deletedObjects, epoch, repo: c.name, settled: settledRows.length > 0 },
				outcome: "drained",
			}
		} catch (err) {
			console.error(
				`pggit gc-scheduler: GC of repo ${JSON.stringify(c.name)} failed (retried next pass):`,
				err,
			)
			return { outcome: "failed" }
		}
	}

	/** One drain pass: GC every eligible repo (bounded concurrency, distinct repos so
	 * a pass never double-GCs one). Returns an entry per repo GC'd this pass — a repo
	 * whose GC threw is skipped (not in the summary) and retried next pass. */
	async function drainOnce(): Promise<DrainSummary> {
		const candidates = await selectCandidates()
		const results = await mapPool(candidates, opts.concurrency, drainRepo)
		const summary: DrainSummary = []
		for (const result of results) {
			if (result.outcome === "drained") summary.push(result.entry)
		}
		return summary
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
		timer.unref()
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

import type { Sql } from "postgres"
import { z } from "zod"
import { createGc, GcGraceSecondsSchema, type GcResult } from "@/store/gc"
import { createRepack, type RepackResult } from "@/store/repack"

/**
 * Self-scheduling maintenance — the background drain that decides WHEN the
 * per-repo reachability GC (`store/gc.ts`) and the repack pass (`store/repack.ts`)
 * run, off the push/fetch hot path. "GC drain" is git's own umbrella vocabulary —
 * `git gc` runs `git repack` — which is why the module, its exports, and the
 * `PGGIT_GC_*` env family keep their names with repack aboard. See
 * `docs/2026-06-24-gc-scheduler-design.md` (observable contract §6, SCH-1 …
 * SCH-11 / PBT-S1) and `docs/2026-08-25-drain-repack-wiring.md` (the repack
 * phase: SCH-R1 … SCH-R8).
 *
 * Mechanism (data-structures-first): every storage-mutating push stamps
 * `repos.last_pushed_at` in its own transaction (the store), so the scheduler is a
 * pure poll loop over Postgres with NO coupling to the request path. One pass
 * (`drainOnce`) selects the repos where either phase owes work — GC when
 * `last_pushed_at > last_gc_at`, repack when `last_pushed_at > last_repack_at`
 * OR when GC is due (each NULL-qualifying; the coupling is R-EL′/SCH-R8 — a
 * sweep can hole the encoding tier, so a sweeping pass re-covers it) — and runs
 * the due phases on each, GC first (repack encodes SURVIVORS, never garbage),
 * per-repo serialized, bounded concurrency. A
 * pass advances `last_gc_at` to its start time only after the repo's grace
 * horizon; a younger repo remains eligible, and a push landing mid-pass also
 * re-qualifies it (no lost garbage). `last_repack_at` is stamped by `repack()`
 * itself on success, never by the drain. `start` is just `drainOnce` on a
 * `setInterval`; all correctness lives in `drainOnce`, which tests drive
 * directly.
 */

/** One repo's outcome in a drain pass, one nullable slot per phase. `null` means
 * exactly "no result from this phase this pass" — ineligible, disabled, skipped
 * because this pass's GC failed, or the phase itself threw; the REASON lives in
 * the log line, never here (the summary reports completed work, the log reports
 * failures — the standing contract). An emitted entry has at least one non-null
 * phase; a repo where every phase that ran threw is dropped and retried next
 * pass. Emitted for EVERY repo the pass completed any work on (including
 * zero-reclaim / zero-encode), so the eligible set itself is observable (SCH-3,
 * SCH-R4). */
export type DrainEntry = {
	repo: string
	/** GC's outcome. `settled` is a GC concept: false while garbage YOUNGER than
	 * grace may still exist (the pass ran inside the grace window) — the repo
	 * deliberately stays eligible and is re-drained next tick, so post-grace
	 * residue is never orphaned forever. */
	gc: (GcResult & { settled: boolean }) | null
	/** What repack encoded this pass. `{ wholes: 0, deltas: 0 }` is a real result
	 * — the phase ran and the tier was already covered — distinct from `null`
	 * (the phase did not run). */
	repack: RepackResult | null
}

/** Completed work from one `drainOnce()`, one entry per repo where at least one phase produced a result. */
export type DrainSummary = DrainEntry[]

/** A candidate repo for one drain pass: its id + wire name, plus which phases the selection judged due. Both flags are computed in the selecting query; `repack_due` includes its own watermark and the coupled GC arm. The GC pass-start watermark is captured per-repo (in `drainRepo`, before that repo's GC snapshot) and written back as `last_gc_at`; repack's watermark is `repack()`'s own business (it stamps `last_repack_at` itself on success — the stamp must mean "a completed pass" for every invoker, so the drain never writes it). */
type Candidate = { id: string; name: string } & (
	| { gc_due: true; repack_due: boolean }
	| { gc_due: false; repack_due: true }
)

const MAX_TIMER_MS = 2_147_483_647

const GcSchedulerOptionsSchema = z
	.object({
		concurrency: z.number().int().positive(),
		graceSeconds: GcGraceSecondsSchema,
		intervalMs: z.number().int().positive().max(MAX_TIMER_MS),
		repackEnabled: z.boolean(),
	})
	.strict()

/** Scheduler tunables (resolved from `env` / `startServer` opts). `graceSeconds`
 * is passed straight to `gc()`; `intervalMs` is the drain cadence (the debounce
 * window); `concurrency` caps repos drained at once per pass so one large repo
 * cannot head-of-line-block the rest — with repack enabled it is also the memory
 * dial, since each in-flight repack holds roughly its repo's tree bytes in its
 * pass cache (repack.ts). `repackEnabled` gates the drain's repack phase. */
export type GcSchedulerOptions = z.infer<typeof GcSchedulerOptionsSchema>

export type GcScheduler = ReturnType<typeof createGcScheduler>

/** Resolve the scheduler's configuration before any resource is opened from it. */
export function resolveGcSchedulerOptions(opts: GcSchedulerOptions): GcSchedulerOptions {
	return GcSchedulerOptionsSchema.parse(opts)
}

/**
 * Build the GC scheduler over a porsager client (the same wire→DB boundary the
 * stores take). `drainOnce()` runs one poll+sweep pass — per repo, GC then (when
 * enabled and due) repack; `start()`/`stop()` drive it on `intervalMs`. Reachable
 * objects are never touched: GC is reachability-safe and repack only ever ADDS
 * derived encoding rows.
 */
export function createGcScheduler(pg: Sql, opts: GcSchedulerOptions) {
	return createGcSchedulerFromResolvedOptions(pg, resolveGcSchedulerOptions(opts))
}

/** Internal composition seam for `startServer`, which resolves before sizing its pool. */
export function createGcSchedulerFromResolvedOptions(pg: Sql, opts: GcSchedulerOptions) {
	// Both phases ride the SAME client the scheduler was built over — in
	// `startServer` that is the dedicated drain pool, so repack's reads and COPY
	// flushes never contend with the request path. Constructed unconditionally:
	// the switch's one enforcement point is the candidate query's `repack_due`
	// arm, not scattered construction guards.
	const gc = createGc(pg)
	const repack = createRepack(pg)
	let timer: ReturnType<typeof setInterval> | undefined
	// The in-flight pass (if any). Doubles as the overlap guard (a tick skips while a
	// pass runs, so two passes never touch the same repo at once) and the shutdown
	// barrier (`stop()` awaits it).
	let inFlight: Promise<unknown> | undefined

	/** The eligible repos for this pass — the union of the two phase predicates
	 * (the GC design's §2 predicate, plus repack's `last_pushed_at >
	 * last_repack_at` when the phase is enabled). The arms are COUPLED (R-EL′):
	 * a gc-due repo is also repack-due, because a GC sweep can hole the encoding
	 * tier through the 0008 cascades and the repack watermark alone would strand
	 * that hole until the next push (SCH-R8) — a covered repo's extra repack is
	 * one empty pending query plus a stamp. The resolved switch is bound into the
	 * query here and ONLY here — with it off, `repack_due` is false for every
	 * candidate by construction, and no other code path gates the phase. */
	async function selectCandidates(): Promise<Candidate[]> {
		return pg<Candidate[]>`
			select r.id::text as id, r.name,
				(r.last_gc_at is null or r.last_pushed_at > r.last_gc_at) as gc_due,
				(${opts.repackEnabled} and (r.last_repack_at is null or r.last_pushed_at > r.last_repack_at
					or r.last_gc_at is null or r.last_pushed_at > r.last_gc_at)) as repack_due
			from repos r
			where r.last_pushed_at is not null
				and ((r.last_gc_at is null or r.last_pushed_at > r.last_gc_at)
					or (${opts.repackEnabled} and (r.last_repack_at is null or r.last_pushed_at > r.last_repack_at)))
		`
	}

	/**
	 * Drain one candidate: the phases its flags license, GC first. `t0 =
	 * clock_timestamp()` is captured BEFORE `gc()` opens its snapshot, then written
	 * as `last_gc_at` after the sweep: any push committing after t0 re-stamps
	 * `last_pushed_at > t0` (the store stamps after commit) and re-qualifies the
	 * repo next pass (no lost garbage). A per-repo failure is ISOLATED — logged,
	 * the failed phase's watermark left behind, retried next pass — so one poison
	 * repo never aborts the rest of the pass; a GC failure also SKIPS this repo's
	 * repack (repack encodes survivors, never what the completed sweep would have
	 * deleted). Repack is invoked by NAME and stamps `last_repack_at` itself on
	 * success — a completed-pass marker every invoker shares, which its repair
	 * mode depends on. `maintain: false`: the drain leans on autovacuum, never a
	 * per-pass full-table VACUUM (gc.ts).
	 */
	type DrainAttempt = { outcome: "drained"; entry: DrainEntry } | { outcome: "failed" }

	async function drainRepo(c: Candidate): Promise<DrainAttempt> {
		let gcOutcome: DrainEntry["gc"] = null
		if (c.gc_due) {
			try {
				const [{ t0 }] = await pg<[{ t0: string }]>`select clock_timestamp()::text as t0`
				const gcResult = await gc.gc(c.name, {
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
				gcOutcome = { ...gcResult, settled: settledRows.length > 0 }
			} catch (err) {
				console.error(
					`pggit gc-scheduler: GC of repo ${JSON.stringify(c.name)} failed (retried next pass):`,
					err,
				)
				return { outcome: "failed" }
			}
		}

		let repackOutcome: RepackResult | null = null
		if (c.repack_due) {
			try {
				repackOutcome = await repack.repack(c.name)
			} catch (err) {
				console.error(
					`pggit gc-scheduler: repack of repo ${JSON.stringify(c.name)} failed (retried next pass):`,
					err,
				)
			}
		}

		// An entry is emitted iff at least one phase produced a result. A repo where
		// every phase that ran threw was already logged above; dropping it keeps the
		// summary a report of completed work, and its stale watermark(s) re-select
		// it next pass.
		if (gcOutcome === null && repackOutcome === null) return { outcome: "failed" }
		return {
			entry: { gc: gcOutcome, repack: repackOutcome, repo: c.name },
			outcome: "drained",
		}
	}

	/** One drain pass: run the due phases on every eligible repo (bounded
	 * concurrency, distinct repos so a pass never touches one twice). Returns an
	 * entry per repo that completed any work — a repo whose only-ran phase threw is
	 * absent (logged) and retried next pass. */
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

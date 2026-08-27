import postgres from "postgres"
import {
	createGcScheduler,
	type GcSchedulerOptionsInput,
	resolveGcSchedulerOptions,
} from "@/store/gc-scheduler"

/**
 * The drain as a self-contained unit for a mounted host: DSN in, and the block
 * owns what belongs together — the resolved options and the DEDICATED pool the
 * drain runs on. Dedicated because each concurrent `gc()` reserves a connection
 * for its whole pass, so sharing a host's request pool could starve
 * clone/fetch/push under load; sized to `concurrency` (one reservation per
 * concurrent repo) + 1 for the per-repo bookkeeping queries, and the repack
 * phase rides the same headroom (a repo's repack runs its queries serially, at
 * most one connection at a time). `createGcScheduler` remains the
 * bring-your-own-pool composition for callers (and the test suites) that
 * already hold an `Sql` and carry that sizing responsibility themselves.
 *
 * Liveness is the host's: the scheduler's timer is `unref`'d, so the drain runs
 * only while something else (the host's server socket) keeps the process alive
 * — this is a co-tenant of a server, not a daemon. `stop()` awaits any
 * in-flight pass, then ends the drain's own pool; a host with no shutdown path
 * may simply never call it (both phases are watermark-crash-safe, and a killed
 * pass leaves the repo a candidate for the next boot).
 */
export function createGcDrain(
	databaseUrl: string,
	overrides: GcSchedulerOptionsInput = {},
) {
	const opts = resolveGcSchedulerOptions(overrides)
	const pg = postgres(databaseUrl, { max: opts.concurrency + 1 })
	const scheduler = createGcScheduler(pg, opts)
	return {
		drainOnce: scheduler.drainOnce,
		start: scheduler.start,
		stop: async (): Promise<void> => {
			await scheduler.stop()
			await pg.end()
		},
	}
}

import postgres from "postgres"
import type { z } from "zod"
import { createGcScheduler, GcSchedulerOptionsSchema } from "@/store/gc-scheduler"

// The ONE default site for the drain's tunables. Per-field `.default()` makes
// resolution undefined-tolerant: an override key that is absent OR explicitly
// `undefined` resolves to the default, so a host building overrides from
// optional env values can never clobber a default by passing `undefined`
// through (a spread merge over a defaults object would). The required
// `GcSchedulerOptionsSchema` preserves `createGcScheduler`'s resolved-options contract.
const GcSchedulerOptionsInputSchema = GcSchedulerOptionsSchema.extend({
	concurrency: GcSchedulerOptionsSchema.shape.concurrency.default(4),
	graceSeconds: GcSchedulerOptionsSchema.shape.graceSeconds.default(60),
	intervalMs: GcSchedulerOptionsSchema.shape.intervalMs.default(30_000),
	repackEnabled: GcSchedulerOptionsSchema.shape.repackEnabled.default(true),
})

/** The override shape hosts pass: every field optional, defaults from the
 * schema above. */
export type GcSchedulerOptionsInput = z.input<typeof GcSchedulerOptionsInputSchema>

/**
 * The drain as a self-contained unit for a mounted host: DSN in, and the block
 * owns what belongs together — the resolved options and the DEDICATED pool the
 * drain runs on. Dedicated because each concurrent `gc()` reserves a connection
 * for its whole pass, so sharing a host's request pool could starve
 * clone/fetch/push under load; sized to `concurrency` (one reservation per
 * concurrent repo) + 1 for the per-repo bookkeeping queries, and the repack
 * phase rides the same headroom (a repo's repack runs its queries serially, at
 * most one connection at a time). `createGcScheduler` remains the
 * bring-your-own-pool composition for callers that already hold an `Sql` and
 * carry that sizing responsibility themselves.
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
	const opts = GcSchedulerOptionsInputSchema.parse(overrides)
	// `onnotice` is silenced because the drain MANUFACTURES its own notices: every
	// gc pass opens with `drop table if exists gc_live` on a fresh reserved
	// connection, and Postgres NOTICEs each absent-table drop. porsager's default
	// handler is `console.log`, so an unsilenced pool prints a multi-line notice
	// object per pass — which on a host whose only drain-failure surface is its
	// log (the watermark columns are the success surface; failures go to stderr)
	// drowns the signal it exists to carry. Notices are never errors, and this
	// pool is exclusively the drain's, so nothing else is muted.
	const pg = postgres(databaseUrl, {
		max: opts.concurrency + 1,
		onnotice: () => {},
	})
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

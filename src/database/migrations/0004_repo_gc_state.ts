import { type Kysely, sql } from "kysely"

// pggit GC scheduling state — the per-repo activity/GC timestamps the
// self-scheduling background drain polls on
// (docs/2026-06-24-gc-scheduler-design.md §2).
//
// `last_pushed_at` is stamped by the store in every storage-mutating push
// transaction; `last_gc_at` is stamped by the scheduler at the start of each GC
// pass. The drain's eligibility predicate is the pure column compare
// `last_pushed_at > last_gc_at` (or `last_gc_at is null`) — NOT sargable, so the
// loop seq-scans the tiny `repos` table and these columns stay UNINDEXED, which
// keeps every `last_pushed_at` write HOT (no secondary index to maintain).
//
// `repos` now takes a write per push, so it is retuned from the insert-once
// default to the same churn profile as `git_ref` (the other per-push-updated
// table, 0001_init.ts): fillfactor 70 leaves same-page room for HOT updates and a
// near-instant autovacuum keeps dead tuples from accumulating.

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		alter table repos
			add column last_pushed_at timestamptz,
			add column last_gc_at     timestamptz
	`.execute(db)

	await sql`
		alter table repos set (
			fillfactor = 70,
			autovacuum_vacuum_scale_factor = 0.0,
			autovacuum_vacuum_threshold = 20,
			autovacuum_vacuum_cost_delay = 0
		)
	`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		alter table repos reset (
			fillfactor,
			autovacuum_vacuum_scale_factor,
			autovacuum_vacuum_threshold,
			autovacuum_vacuum_cost_delay
		)
	`.execute(db)
	await sql`
		alter table repos
			drop column if exists last_pushed_at,
			drop column if exists last_gc_at
	`.execute(db)
}

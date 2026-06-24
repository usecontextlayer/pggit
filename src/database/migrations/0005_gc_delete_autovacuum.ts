import { type Kysely, sql } from "kysely"

// Retune the git_object / git_edge leaf partitions' autovacuum for the GC DELETE
// workload (docs/2026-06-24-gc-scheduler-design.md §4). The self-scheduling drain
// passes maintain:false and leans on autovacuum to reclaim GC's dead tuples + index
// dead-entries — but the 0001/0003 leaf reloptions were tuned for an INSERT-only
// spine (insert-triggered vacuum). GC now DELETEs whole orphaned snapshots, so the
// leaves need delete-aware dead-tuple autovacuum: a lower scale factor so it fires
// well before a partition bloats, a modest absolute floor, and cost_delay 0 so the
// reclaim is never throttled (matching git_ref / repos, the other churned tables).
// git_object's content TOAST relation gets the same. These are starting points —
// tune against measured churn (§9). Storage parameters only: no schema change, no
// model regeneration.

const OBJECT_PARTITIONS = 16
const EDGE_PARTITIONS = 16

const DELETE_AUTOVACUUM = [
	"autovacuum_vacuum_scale_factor = 0.02",
	"autovacuum_vacuum_threshold = 1000",
	"autovacuum_vacuum_cost_delay = 0",
].join(", ")

// git_object's content lives in TOAST; GC's deletes churn it too, so mirror the
// delete-aware policy onto the TOAST relation.
const OBJECT_DELETE_AUTOVACUUM = [
	DELETE_AUTOVACUUM,
	"toast.autovacuum_vacuum_scale_factor = 0.02",
	"toast.autovacuum_vacuum_threshold = 1000",
	"toast.autovacuum_vacuum_cost_delay = 0",
].join(", ")

export async function up(db: Kysely<unknown>): Promise<void> {
	for (let r = 0; r < OBJECT_PARTITIONS; r++) {
		await sql`alter table ${sql.raw(`git_object_p${r}`)} set (${sql.raw(OBJECT_DELETE_AUTOVACUUM)})`.execute(
			db,
		)
	}
	for (let r = 0; r < EDGE_PARTITIONS; r++) {
		await sql`alter table ${sql.raw(`git_edge_p${r}`)} set (${sql.raw(DELETE_AUTOVACUUM)})`.execute(
			db,
		)
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Restore the 0001/0003 insert-tuned scale factor and drop the delete-specific keys.
	for (let r = 0; r < OBJECT_PARTITIONS; r++) {
		await sql`alter table ${sql.raw(`git_object_p${r}`)} set (autovacuum_vacuum_scale_factor = 0.05)`.execute(
			db,
		)
		await sql`alter table ${sql.raw(`git_object_p${r}`)} reset (autovacuum_vacuum_threshold, autovacuum_vacuum_cost_delay, toast.autovacuum_vacuum_scale_factor, toast.autovacuum_vacuum_threshold, toast.autovacuum_vacuum_cost_delay)`.execute(
			db,
		)
	}
	for (let r = 0; r < EDGE_PARTITIONS; r++) {
		await sql`alter table ${sql.raw(`git_edge_p${r}`)} set (autovacuum_vacuum_scale_factor = 0.05)`.execute(
			db,
		)
		await sql`alter table ${sql.raw(`git_edge_p${r}`)} reset (autovacuum_vacuum_threshold, autovacuum_vacuum_cost_delay)`.execute(
			db,
		)
	}
}

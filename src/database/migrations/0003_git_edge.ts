import { type Kysely, sql } from "kysely"

// Chunk 2 of the Postgres-native redesign
// (internal/in-progress/2026-06-22-pggit-postgres-native-storage-redesign.md):
// the DAG made queryable. `git_edge` stores the commit/tree/tag topology — kinds
// 1 (commit→tree), 2 (commit→parent), 3 (tree→subtree), 5 (tag→target). It does
// NOT store tree→blob (§4.3): blobs are enumerated from tree content, never as
// edges, so the table stays bounded by directory structure, not file count.
//
// Additive over Chunk 1's git_object; nothing reads edges yet (the recursive-CTE
// traversal lands in a later chunk). An object's outgoing references are a pure
// function of its immutable content, so edges are insert-only and inherit the
// spine's tuning. Same raw-SQL DDL shape as git_object (reloptions on the leaf
// partitions, not the partitioned parent).

const EDGE_PARTITIONS = 16

const EDGE_LEAF_RELOPTS = [
	"fillfactor = 100",
	"autovacuum_vacuum_insert_scale_factor = 0.0",
	"autovacuum_vacuum_insert_threshold = 10000",
	"autovacuum_vacuum_scale_factor = 0.05",
	"autovacuum_freeze_min_age = 0",
].join(", ")

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		create table git_edge (
			repo_id bigint   not null references repos (id),
			parent  bytea    not null,
			child   bytea    not null,
			kind    smallint not null,
			primary key (repo_id, parent, child),
			constraint git_edge_oid_len check (length(parent) = 20 and length(child) = 20)
		) partition by hash (repo_id)
	`.execute(db)

	for (let remainder = 0; remainder < EDGE_PARTITIONS; remainder++) {
		await sql`
			create table ${sql.raw(`git_edge_p${remainder}`)}
				partition of git_edge
				for values with (modulus ${sql.raw(String(EDGE_PARTITIONS))}, remainder ${sql.raw(String(remainder))})
				with (${sql.raw(EDGE_LEAF_RELOPTS)})
		`.execute(db)
	}

	// Covering index: a closure-CTE recursion step (later chunk) walks a parent's
	// children index-only — child + kind read straight from the index, never the
	// heap. Created on the partitioned parent so it propagates to every partition.
	await sql`
		create index git_edge_walk on git_edge (repo_id, parent) include (child, kind)
	`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table if exists git_edge`.execute(db)
}

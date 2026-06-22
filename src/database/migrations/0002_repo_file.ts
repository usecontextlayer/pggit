import { type Kysely, sql } from "kysely"

// Chunk 5 of the Postgres-native redesign
// (internal/in-progress/2026-06-22-pggit-postgres-native-storage-redesign.md):
// the collapsed repo_view. The old repo_view kept a SECOND copy of every tip blob
// (repo_view_blobs) reaped on each push (reapOrphanBlobs). With objects now rows in
// git_object, that copy is 100% redundant — this is the slim path→blob index
// alone; content is read by joining git_object on (repo_id, blob_oid).
//
// Keyed on the bigint repo_id (like the spine), HASH-partitioned. The per-push
// refresh is delete-branch-then-insert (DELETEs + INSERTs, not a HOT-eligible
// in-place UPDATE), so the leaves get aggressive dead-tuple vacuum and no
// fillfactor reserve (§4.5).

const FILE_PARTITIONS = 16

const FILE_LEAF_RELOPTS = [
	"autovacuum_vacuum_scale_factor = 0.0",
	"autovacuum_vacuum_threshold = 50",
	"autovacuum_vacuum_cost_delay = 0",
].join(", ")

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		create table repo_file (
			repo_id  bigint not null references repos (id),
			ref_name text   not null,
			path     text   not null,
			mode     text   not null,
			blob_oid bytea  not null,
			primary key (repo_id, ref_name, path),
			constraint repo_file_blob_len check (length(blob_oid) = 20)
		) partition by hash (repo_id)
	`.execute(db)

	for (let remainder = 0; remainder < FILE_PARTITIONS; remainder++) {
		await sql`
			create table ${sql.raw(`repo_file_p${remainder}`)}
				partition of repo_file
				for values with (modulus ${sql.raw(String(FILE_PARTITIONS))}, remainder ${sql.raw(String(remainder))})
				with (${sql.raw(FILE_LEAF_RELOPTS)})
		`.execute(db)
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table if exists repo_file`.execute(db)
}

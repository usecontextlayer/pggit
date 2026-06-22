import { type Kysely, sql } from "kysely"

// pggit Postgres-native storage — Chunk 1 of the redesign at
// internal/in-progress/2026-06-22-pggit-postgres-native-storage-redesign.md.
//
// The reframe: git's core data is immutable content-addressed objects, not packs.
// So objects live as one row each (no pack blobs), scoped per-repo behind a bigint
// surrogate, HASH-partitioned by repo_id; OIDs are raw 20-byte `bytea`; content is
// the raw inflated body, lz4-TOASTed Postgres-side. Refs are the only mutable
// surface. `git_edge` (the DAG) and `repo_file` (the tip index) arrive in later
// chunks; `peeled_oid` is present but dormant until Chunk 5 populates it.
//
// Partitioning, per-partition reloptions and column compression are raw SQL: the
// Kysely schema builder cannot express them. Two DDL constraints settled
// empirically against postgres:18: storage parameters are illegal on a partitioned
// PARENT (they must sit on each leaf partition), but inline column COMPRESSION on
// the parent DOES propagate to partitions.

const OBJECT_PARTITIONS = 16

// Leaf-partition tuning for the insert-only spine: no reserved page space
// (fillfactor 100), insert-triggered vacuum to keep the visibility map fresh and
// freeze pages while cache-hot, plus a modest dead-tuple threshold for the future
// GC burst — mirrored onto the TOAST relation that holds the content.
const OBJECT_LEAF_RELOPTS = [
	"fillfactor = 100",
	"autovacuum_vacuum_insert_scale_factor = 0.0",
	"autovacuum_vacuum_insert_threshold = 10000",
	"autovacuum_vacuum_scale_factor = 0.05",
	"autovacuum_freeze_min_age = 0",
	"toast.autovacuum_vacuum_insert_scale_factor = 0.0",
	"toast.autovacuum_vacuum_insert_threshold = 10000",
	"toast.autovacuum_freeze_min_age = 0",
].join(", ")

export async function up(db: Kysely<unknown>): Promise<void> {
	// Repo identity: a 64-bit surrogate — never wraps, halves every downstream
	// index versus a text key, and is the per-repo advisory-lock key the write
	// path will adopt. The wire-facing repo path is `name`.
	await sql`
		create table repos (
			id   bigint generated always as identity primary key,
			name text not null unique
		)
	`.execute(db)

	// The spine: one immutable row per git object. `content` is the raw inflated
	// body — no "<type> <size>\0" loose header, no zlib (that is the content seam).
	// `type` is the pack object-type code (1 commit, 2 tree, 3 blob, 4 tag); `size`
	// is the inflated length served verbatim in the pack header. Insert-only, so it
	// fits Postgres ideally: no UPDATE bloat, no long-held xid.
	await sql`
		create table git_object (
			repo_id    bigint      not null references repos (id),
			oid        bytea       not null,
			type       smallint    not null,
			size       int         not null,
			content    bytea       compression lz4 not null,
			created_at timestamptz not null default clock_timestamp(),
			primary key (repo_id, oid),
			constraint git_object_oid_len check (length(oid) = 20)
		) partition by hash (repo_id)
	`.execute(db)

	for (let remainder = 0; remainder < OBJECT_PARTITIONS; remainder++) {
		await sql`
			create table ${sql.raw(`git_object_p${remainder}`)}
				partition of git_object
				for values with (modulus ${sql.raw(String(OBJECT_PARTITIONS))}, remainder ${sql.raw(String(remainder))})
				with (${sql.raw(OBJECT_LEAF_RELOPTS)})
		`.execute(db)
	}

	// The only mutable surface: a handful of refs per repo. The opposite tuning to
	// the spine — fillfactor 70 leaves room for same-page (HOT) CAS updates, and
	// dead tuples are vacuumed near-instantly so churn never drags the big tables.
	// `peeled_oid` is dormant until Chunk 5 computes it at ref-write.
	await sql`
		create table git_ref (
			repo_id       bigint not null references repos (id),
			name          text   not null,
			oid           bytea,
			peeled_oid    bytea,
			symref_target text,
			primary key (repo_id, name),
			constraint git_ref_oid_xor_symref check ((oid is null) != (symref_target is null))
		) with (
			fillfactor = 70,
			autovacuum_vacuum_scale_factor = 0.0,
			autovacuum_vacuum_threshold = 20,
			autovacuum_vacuum_cost_delay = 0
		)
	`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// git_ref + git_object reference repos, so drop them first; dropping the
	// partitioned parent drops its leaf partitions.
	await sql`drop table if exists git_ref`.execute(db)
	await sql`drop table if exists git_object`.execute(db)
	await sql`drop table if exists repos`.execute(db)
}

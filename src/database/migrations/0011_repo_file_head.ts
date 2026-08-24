import { type Kysely, sql } from "kysely"

// The derived-state spine, chunk 4 (slice S3): `repo_file_head` records which
// commit each branch's `repo_file` snapshot currently reflects. The basis is
// PERSISTED, never inferred (R12): `syncRefProjection` runs after the push commits
// and carries no old oid, so inferring the basis from the push command would make
// a TORN projection representable — a diff applied onto rows from a different
// basis matches no commit, permanently. With the basis in the database and read
// FOR UPDATE, the projection moves only FORWARD along a branch (R13's descendant
// guard) and concurrent pushes serialize per branch instead of racing.
//
// Its own table rather than a column on `git_ref` (the weighed runner-up): the
// projection is an explicitly droppable/rebuildable derived surface, its
// watermark lives with it and dies with `clearRepo`, and repo-view never writes
// the refs-store's table.
//
// One row per (repo, branch), UPDATEd once per push: the repos/git_ref churn
// profile (0004) — fillfactor 70 for HOT room (no secondary index, and the PK
// columns never change on update), near-instant autovacuum.

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		create table repo_file_head (
			repo_id    bigint not null references repos (id) on delete cascade,
			ref_name   text   not null,
			commit_oid bytea  not null,
			primary key (repo_id, ref_name),
			constraint repo_file_head_oid_len check (length(commit_oid) = 20)
		) with (
			fillfactor = 70,
			autovacuum_vacuum_scale_factor = 0.0,
			autovacuum_vacuum_threshold = 20,
			autovacuum_vacuum_cost_delay = 0
		)
	`.execute(db)

	// Backfill: existing snapshots have no recorded basis, and the projection code
	// treats an absent head as "full rebuild on next push" — correct and cheap for
	// every pre-0011 branch, so no data backfill is needed or possible (the old
	// delete+rebuild flow never recorded what it built from).
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table if exists repo_file_head`.execute(db)
}

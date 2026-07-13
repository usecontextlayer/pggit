import { type Kysely, sql } from "kysely"

// Whole-repo deletion (the workspace-deletion API pass): re-point every child FK
// at `repos (id)` to ON DELETE CASCADE, so deleting the `repos` row IS the whole
// teardown — one statement takes the objects, edges, refs and file projection with
// it, and no consumer ever orders child deletes by hand. Until now the FKs were
// declared with no action, which made a `repos` delete impossible while children
// existed (and nothing deleted repos, so it never mattered).
//
// DDL notes, same empirical ground as 0001: for the HASH-partitioned children
// (git_object, git_edge, repo_file) the constraint lives on the partitioned
// parent — dropping it there drops the per-partition clones, and re-adding it
// there re-validates every leaf in one pass. git_ref is unpartitioned. A cascade
// delete of a large repo runs in one transaction; repo deletion is terminal and
// rare, so atomicity is worth more than the burst (GC's batching exists for the
// opposite case: surgical sweeps inside a LIVE repo).

const CHILD_TABLES = ["git_object", "git_edge", "git_ref", "repo_file"] as const

export async function up(db: Kysely<unknown>): Promise<void> {
	for (const table of CHILD_TABLES) {
		await sql`
			alter table ${sql.raw(table)}
				drop constraint ${sql.raw(`${table}_repo_id_fkey`)}
		`.execute(db)
		await sql`
			alter table ${sql.raw(table)}
				add constraint ${sql.raw(`${table}_repo_id_fkey`)}
					foreign key (repo_id) references repos (id) on delete cascade
		`.execute(db)
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const table of CHILD_TABLES) {
		await sql`
			alter table ${sql.raw(table)}
				drop constraint ${sql.raw(`${table}_repo_id_fkey`)}
		`.execute(db)
		await sql`
			alter table ${sql.raw(table)}
				add constraint ${sql.raw(`${table}_repo_id_fkey`)}
					foreign key (repo_id) references repos (id)
		`.execute(db)
	}
}

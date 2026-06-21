import type { Kysely } from "kysely"

// The queryable file-view projection (the deferred "files as rows" layer): a flat
// per-branch-tip snapshot of a repo's working tree, derived from the canonical
// packs at ingest. The tables live in the default schema (prefixed `repo_view_`)
// alongside packs/objects/refs, so the per-test schema isolation works unchanged.

export async function up(db: Kysely<unknown>): Promise<void> {
	// Deduped content-addressed blob bytes — one row per unique blob per repo.
	await db.schema
		.createTable("repo_view_blobs")
		.addColumn("repo_id", "text", (col) => col.notNull())
		.addColumn("oid", "text", (col) => col.notNull())
		.addColumn("content", "bytea", (col) => col.notNull())
		.addPrimaryKeyConstraint("repo_view_blobs_pkey", ["repo_id", "oid"])
		.execute()

	// Flat per-branch-tip snapshot — one row per file path per branch. Every row
	// points at present content (FK, not-null): a missing blob is an error, never
	// a NULL. The orphan reaper keeps `repo_view_blobs` to exactly what this
	// references.
	await db.schema
		.createTable("repo_view_files")
		.addColumn("repo_id", "text", (col) => col.notNull())
		.addColumn("ref_name", "text", (col) => col.notNull())
		.addColumn("path", "text", (col) => col.notNull())
		.addColumn("mode", "text", (col) => col.notNull())
		.addColumn("blob_oid", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("repo_view_files_pkey", ["repo_id", "ref_name", "path"])
		.addForeignKeyConstraint(
			"repo_view_files_blob_fkey",
			["repo_id", "blob_oid"],
			"repo_view_blobs",
			["repo_id", "oid"],
		)
		.execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("repo_view_files").execute()
	await db.schema.dropTable("repo_view_blobs").execute()
}

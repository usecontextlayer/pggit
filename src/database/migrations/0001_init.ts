import { type Kysely, sql } from "kysely"

// Encodes the M0 schema exactly as first built (inline DDL, now migration-owned):
// self-contained undeltified packs (one `bytes` bytea per pack), an OID→pack
// index, and refs. `repo_id` is `text` here — the §3.3 elaboration (a `repos`
// table, `pack_chunks`, a bigint `repo_id` PK) is a deliberate later migration.

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("packs")
		.addColumn("id", "bigint", (col) => col.generatedAlwaysAsIdentity().primaryKey())
		.addColumn("repo_id", "text", (col) => col.notNull())
		.addColumn("checksum", "text", (col) => col.notNull())
		.addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
		.addColumn("dead_at", "timestamptz")
		.addColumn("bytes", "bytea", (col) => col.notNull())
		.execute()

	await db.schema
		.createTable("objects")
		.addColumn("repo_id", "text", (col) => col.notNull())
		.addColumn("oid", "text", (col) => col.notNull())
		.addColumn("pack_id", "bigint", (col) => col.notNull().references("packs.id"))
		.addColumn("type", "text", (col) => col.notNull())
		.addColumn("size", "bigint", (col) => col.notNull())
		.addPrimaryKeyConstraint("objects_pkey", ["repo_id", "oid"])
		.execute()

	await db.schema
		.createTable("refs")
		.addColumn("repo_id", "text", (col) => col.notNull())
		.addColumn("name", "text", (col) => col.notNull())
		.addColumn("oid", "text")
		.addColumn("symref_target", "text")
		.addPrimaryKeyConstraint("refs_pkey", ["repo_id", "name"])
		// A ref is exactly one of: direct (oid) or symbolic (symref_target).
		.addCheckConstraint(
			"refs_oid_xor_symref",
			sql`(oid is null) != (symref_target is null)`,
		)
		.execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("objects").execute()
	await db.schema.dropTable("refs").execute()
	await db.schema.dropTable("packs").execute()
}

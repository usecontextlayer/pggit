import { type Kysely, sql } from "kysely"

// The derived-state spine, chunk 1 landing its deletion (slice S2,
// docs/2026-08-17-derived-state-spine-design.md): `git_edge` is dropped with NO
// replacement structure. Kind-3 rows (tree→subtree — ~80% of the database on the
// motivating repo, growth exponent 1.99) were a second copy of what tree bodies
// already carry; walks now read tree content (`store/reachability.ts`). Kinds
// 1/2/5 live on as `git_commit`/`git_tag` rows (0009). The drop reclaims the
// table and its ~2/3-of-total indexes instantly, with no VACUUM.

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`drop table if exists git_edge`.execute(db)
}

export async function down(): Promise<void> {
	// Irreversible by design: edge DERIVATION no longer exists (the spine deleted
	// it with the table), so recreating 0003's schema would leave a permanently
	// empty table that every pre-spine reader would silently trust. Fail loud.
	throw new Error(
		"0010_drop_git_edge is irreversible: git_edge derivation was deleted with the table (spine S2)",
	)
}

import type { Sql } from "postgres"

/**
 * Fixture assembly by row copy: duplicate an already-seeded repo under a new name
 * with set-based `INSERT … SELECT`, so a suite needing N identical repos pays ONE
 * `putPack` ingest instead of N (docs/2026-08-20-test-efficiency.md, lever 1(a) —
 * fixture assembly, not the raced operation, is what these suites actually spend).
 *
 * Three commitments keep that honest:
 *
 * - **Fixture assembly ONLY.** This bypasses the public store surface to build
 *   STATE; it never stands in for exercising it. Everything a suite races, serves,
 *   verifies or measures still goes through `ObjectStore` / `RefStore` / the wire.
 *   Bypassing `putPack` here is the entire point — "improving" this to seed through
 *   the store would rebuild exactly the cost it removes.
 * - **Identity is anchored by the CALLING suite.** A copy path can drift from the
 *   ingest path silently, so each suite proves its FIRST copy of a template with
 *   `assertCanonicalStoreFixture` against the same expectations the template was
 *   seeded with. The proof lives in the suite because the canonical expectations do;
 *   this helper stays generic and asserts nothing about content.
 * - **Per-schema by construction.** It takes the suite's own `Sql`, so a template
 *   cannot outlive the isolated schema that migrated it. Caching templates across
 *   suites would break that isolation.
 *
 * `git_commit.generation` is copied AS STORED. Re-deriving it — replaying the
 * objects through the ingest path per copy — is the plausible-but-wrong
 * implementation: it restores the cost this removes, and a re-derivation over a
 * partial parent set derives absorbing NULLs the template does not have.
 */

/**
 * Every table hanging off `repos`, with the columns a copy carries, in FK-safe
 * insert order — derived from `src/database/migrations/` (0001–0012), not from
 * memory. `git_object` precedes its dependents (`git_commit`, `git_tag`,
 * `git_pack_encoding`, `git_reach_bitmap`) and `git_reach_epoch` precedes the
 * bitmaps keyed on it. The list is the WHOLE schema rather than any one suite's
 * subset: an empty table copies for free, and a table left out of a copy is a
 * silently wrong fixture. `repos.id` is `generated always as identity`, so the new
 * id comes from the insert; every other stored column is carried verbatim,
 * `created_at` and the `last_*_at` watermarks included — repack's own staleness
 * math reads them, so a copy that reset them would not be the same repo.
 */
const COPIED_TABLES: readonly { table: string; columns: readonly string[] }[] = [
	{ columns: ["oid", "type", "size", "content", "created_at"], table: "git_object" },
	{
		columns: ["oid", "tree_oid", "parents", "commit_time", "generation"],
		table: "git_commit",
	},
	{ columns: ["oid", "target_oid", "target_type"], table: "git_tag" },
	{
		columns: ["oid", "base_oid", "data_size", "data"],
		table: "git_pack_encoding",
	},
	{ columns: ["name", "oid", "peeled_oid", "symref_target"], table: "git_ref" },
	{ columns: ["ref_name", "path", "mode", "blob_oid"], table: "repo_file" },
	{ columns: ["ref_name", "commit_oid"], table: "repo_file_head" },
	{ columns: ["epoch", "tips", "oids"], table: "git_reach_epoch" },
	{ columns: ["epoch", "tip_oid", "bits"], table: "git_reach_bitmap" },
]

/**
 * Copy `sourceName`'s rows into a fresh repo named `targetName`, in one
 * transaction (a half-built repo is never observable, and a failure leaves the
 * schema untouched). The caller names the target: repo naming belongs to the
 * suite that builds the URL. Loud when the source does not exist; the unique index
 * on `repos.name` is loud when the target already does.
 *
 * Table and column names are module constants, never caller input — the same
 * SQL-identifier contract as `database/copy-insert.ts`.
 */
export async function copyTemplateRepo(
	sql: Sql,
	sourceName: string,
	targetName: string,
): Promise<void> {
	await sql.begin(async (tx) => {
		const [source] = await tx<{ id: string }[]>`
			select id::text as id from repos where name = ${sourceName}`
		if (source === undefined) {
			throw new Error(`template repo ${JSON.stringify(sourceName)} does not exist`)
		}
		const [target] = await tx<{ id: string }[]>`
			insert into repos (name, last_pushed_at, last_gc_at, last_repack_at)
			select ${targetName}, last_pushed_at, last_gc_at, last_repack_at
			from repos where id = ${source.id}::bigint
			returning id::text as id`
		if (target === undefined) {
			throw new Error(
				`copying template repo ${JSON.stringify(sourceName)} inserted no row`,
			)
		}
		for (const { columns, table } of COPIED_TABLES) {
			const cols = tx.unsafe(columns.join(", "))
			await tx`
				insert into ${tx(table)} (repo_id, ${cols})
				select ${target.id}::bigint, ${cols}
				from ${tx(table)} where repo_id = ${source.id}::bigint`
		}
	})
}

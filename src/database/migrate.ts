import type { Kysely } from "kysely"
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration"
import * as m0001 from "./migrations/0001_init"
import * as m0002 from "./migrations/0002_repo_file"
import * as m0003 from "./migrations/0003_git_edge"
import * as m0004 from "./migrations/0004_repo_gc_state"
import * as m0005 from "./migrations/0005_gc_delete_autovacuum"
import * as m0006 from "./migrations/0006_repo_file_path_pattern"

// The schema source of truth — a STATIC migration set built from explicit module imports,
// not Kysely's `FileMigrationProvider` (which reads `.ts`/`.js` files off disk at runtime).
// The static set is what makes pggit's schema CONSUMER-MIGRATABLE: tsdown bundles these
// imports into `dist`, so `import { migrateToLatest } from "@usecontextlayer/pggit"` works
// from the published package (a fresh `ctx_pggit` in an e2e, or a production deploy) — not
// just a developer running from source. Keys are the migration names; the map's sort order
// IS the apply order, exactly as the old `0001…`-prefixed filenames sorted.
const MIGRATIONS: Record<string, Migration> = {
	"0001_init": { down: m0001.down, up: m0001.up },
	"0002_repo_file": { down: m0002.down, up: m0002.up },
	"0003_git_edge": { down: m0003.down, up: m0003.up },
	"0004_repo_gc_state": { down: m0004.down, up: m0004.up },
	"0005_gc_delete_autovacuum": { down: m0005.down, up: m0005.up },
	"0006_repo_file_path_pattern": { down: m0006.down, up: m0006.up },
}

function migrationProvider(): MigrationProvider {
	return { getMigrations: async () => MIGRATIONS }
}

/** Migrator over the static migration set — the single schema source of truth. */
export function createMigrator<T>(db: Kysely<T>): Migrator {
	return new Migrator({ db, provider: migrationProvider() })
}

/** Run every pending migration; throw loudly on the first failure. */
export async function migrateToLatest<T>(db: Kysely<T>): Promise<void> {
	const { error, results } = await createMigrator(db).migrateToLatest()
	for (const result of results ?? []) {
		if (result.status === "Error") {
			throw new Error(`migration failed: ${result.migrationName}`)
		}
	}
	if (error) throw error
}

/**
 * Apply every migration's `up()` directly, in name order, WITHOUT Kysely's
 * Migrator — so no `kysely_migration` bookkeeping table and, crucially, no
 * whole-database `getTables` introspection. The test fixture carves many fresh
 * `t_<uuid>` schemas on one shared container and `DROP SCHEMA … CASCADE`s them
 * concurrently; the Migrator's existence check introspects EVERY schema (it
 * evaluates `pg_get_serial_sequence` per column) and throws `3F000` the moment
 * it races a sibling's drop. A throwaway schema needs each migration exactly once
 * with no tracking, so applying `up()` directly is both correct and race-free.
 * Production + consumers use `migrateToLatest` (real incremental tracking).
 */
export async function applyMigrations<T>(db: Kysely<T>): Promise<void> {
	const migrations = await migrationProvider().getMigrations()
	for (const name of Object.keys(migrations).sort()) {
		const migration: Migration | undefined = migrations[name]
		await migration?.up(db)
	}
}

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { Kysely } from "kysely"
import { FileMigrationProvider, type Migration, Migrator } from "kysely/migration"

export const MIGRATIONS_FOLDER = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"migrations",
)

function migrationProvider(): FileMigrationProvider {
	return new FileMigrationProvider({ fs, migrationFolder: MIGRATIONS_FOLDER, path })
}

/** Migrator over `src/database/migrations/` — the single schema source of truth. */
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
 * Production uses `migrateToLatest` (real incremental tracking).
 */
export async function applyMigrations<T>(db: Kysely<T>): Promise<void> {
	const migrations = await migrationProvider().getMigrations()
	for (const name of Object.keys(migrations).sort()) {
		const migration: Migration | undefined = migrations[name]
		await migration?.up(db)
	}
}

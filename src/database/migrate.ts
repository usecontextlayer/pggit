import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { Kysely } from "kysely"
import { FileMigrationProvider, Migrator } from "kysely/migration"

export const MIGRATIONS_FOLDER = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"migrations",
)

/**
 * Migrator over `src/database/migrations/` — the single schema source of truth.
 *
 * `migrationTableSchema` scopes Kysely's own bookkeeping tables
 * (`kysely_migration`/`_lock`) to a schema. It is load-bearing when several
 * search_path-isolated schemas share ONE physical database (the test fixture):
 * Kysely's table-existence check introspects all schemas, so without scoping it
 * sees another schema's bookkeeping and skips creating it in the new schema,
 * then the migration lock fails. Production (single schema) leaves it undefined.
 */
export function createMigrator<T>(
	db: Kysely<T>,
	migrationTableSchema?: string,
): Migrator {
	return new Migrator({
		db,
		migrationTableSchema,
		provider: new FileMigrationProvider({ fs, migrationFolder: MIGRATIONS_FOLDER, path }),
	})
}

/** Run every pending migration; throw loudly on the first failure. */
export async function migrateToLatest<T>(
	db: Kysely<T>,
	migrationTableSchema?: string,
): Promise<void> {
	const { error, results } = await createMigrator(
		db,
		migrationTableSchema,
	).migrateToLatest()
	for (const result of results ?? []) {
		if (result.status === "Error") {
			throw new Error(`migration failed: ${result.migrationName}`)
		}
	}
	if (error) throw error
}

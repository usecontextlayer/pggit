import { randomUUID } from "node:crypto"
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql"
import type { Kysely } from "kysely"
import postgres, { type Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import { applyMigrations } from "@/database/migrate"

const DEFAULT_IMAGE = "postgres:18-alpine"

export type IsolatedDb = {
	sql: Sql
	db: Kysely<Database>
	schema: string
	drop: () => Promise<void>
}

/** Start one real Postgres container (slow; share across a file's tests). */
export async function startPostgres(
	image = DEFAULT_IMAGE,
): Promise<StartedPostgreSqlContainer> {
	return new PostgreSqlContainer(image).start()
}

/**
 * Carve an isolated schema out of a running container, migrate it to latest, and
 * return both the raw porsager client (every pooled connection's `search_path`
 * is set to the schema) and a typed Kysely bound to it — so tests never collide.
 * `drop()` tears the schema (and clients) down.
 */
export async function createIsolatedSchema(baseUrl: string): Promise<IsolatedDb> {
	const schema = `t_${randomUUID().replaceAll("-", "")}`

	const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })
	await admin`create schema ${admin(schema)}`
	await admin.end()

	const sql = postgres(baseUrl, {
		connection: { search_path: schema },
		max: 4,
		onnotice: () => {},
	})
	const db = initKysely<Database>(sql)
	// Apply migrations directly, not via Kysely's Migrator: its migration-table
	// existence check introspects EVERY schema on the shared container and throws
	// when it races a sibling's `drop schema cascade`. A fresh schema just needs
	// each `up()` run once (see applyMigrations).
	await applyMigrations(db)

	return {
		db,
		drop: async () => {
			await db.destroy() // ends the shared porsager pool (`sql`)
			const cleanup = postgres(baseUrl, { max: 1, onnotice: () => {} })
			await cleanup`drop schema ${cleanup(schema)} cascade`
			await cleanup.end()
		},
		schema,
		sql,
	}
}

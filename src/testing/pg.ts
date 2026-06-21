import { randomUUID } from "node:crypto"
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql"
import postgres, { type Sql } from "postgres"

const DEFAULT_IMAGE = "postgres:18-alpine"

export type IsolatedDb = {
	sql: Sql
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
 * Carve an isolated schema out of a running container and return a porsager
 * client whose every pooled connection has `search_path` set to it — so tests
 * never collide. `drop()` tears the schema (and client) down.
 */
export async function createIsolatedSchema(baseUrl: string): Promise<IsolatedDb> {
	const schema = `t_${randomUUID().replaceAll("-", "")}`

	const admin = postgres(baseUrl, { max: 1 })
	await admin`create schema ${admin(schema)}`
	await admin.end()

	const sql = postgres(baseUrl, { connection: { search_path: schema }, max: 4 })

	return {
		drop: async () => {
			await sql.end()
			const cleanup = postgres(baseUrl, { max: 1 })
			await cleanup`drop schema ${cleanup(schema)} cascade`
			await cleanup.end()
		},
		schema,
		sql,
	}
}

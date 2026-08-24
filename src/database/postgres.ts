import { Kysely } from "kysely"
import { PostgresJSDialect } from "kysely-postgres-js"
import type { Sql } from "postgres"
import { recordQuery } from "@/instrument"

/** Wrap a caller-owned porsager client in a typed Kysely. Each store builds its
 * own handle so independently mounted stores and per-schema tests stay isolated;
 * callers retain the raw client for COPY ingest. */
export function initKysely<T>(pg: Sql): Kysely<T> {
	return new Kysely<T>({
		dialect: new PostgresJSDialect({ postgres: pg }),
		log(event) {
			if (event.level === "query" || event.level === "error") {
				recordQuery(event.query.sql, event.queryDurationMillis)
			}
		},
	})
}

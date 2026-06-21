import { Kysely } from "kysely"
import { PostgresJSDialect } from "kysely-postgres-js"
import type { Sql } from "postgres"
import { recordQuery } from "@/instrument"

// Mirrors web/postgres.ts: Kysely over the porsager `postgres` driver via
// PostgresJSDialect. Unlike web, pggit does NOT keep a module-level singleton —
// the caller owns the porsager instance and injects the Kysely it builds (so the
// app stays a mountable sub-app and per-schema test isolation works).
const EVENT_SIGNS = { error: "🔴", query: "🟢" } as const

/** Wrap a porsager client in a typed Kysely. Dev builds log query/error events. */
export function initKysely<T>(pg: Sql): Kysely<T> {
	return new Kysely<T>({
		dialect: new PostgresJSDialect({ postgres: pg }),
		log(event) {
			if (event.level === "query" || event.level === "error") {
				recordQuery(event.query.sql, event.queryDurationMillis)
				if (process.env.NODE_ENV === "development") {
					console.debug(
						`${EVENT_SIGNS[event.level]} ${event.queryDurationMillis}ms ${event.query.sql}`,
					)
				}
			}
		},
	})
}

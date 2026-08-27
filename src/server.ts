import { serve } from "@hono/node-server"
import type { Hono } from "hono"
import postgres from "postgres"
import { env } from "@/env"
import { createGcDrain, type GcSchedulerOptionsInput } from "@/gc-drain"
import { createGitApp, createGitDeps } from "@/index"

export type GitServer = {
	port: number
	close: () => Promise<void>
}

/**
 * Serve a Hono app over Node HTTP. Awaits "listening" and recovers the bound
 * port (so `port: 0` yields an ephemeral free port — used by the oracle harness).
 * No import-time side effects; the standalone boot lives in `src/main.ts`.
 */
export async function serveOnPort(app: Hono, port: number): Promise<GitServer> {
	const server = serve({ fetch: app.fetch, port })
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve())
		server.once("error", reject)
	})
	const address = server.address()
	const boundPort = typeof address === "object" && address ? address.port : port
	return {
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()))
			}),
		port: boundPort,
	}
}

/** Build the Postgres-backed git app and serve it. */
export async function startServer(
	opts: {
		port?: number
		databaseUrl?: string
		/** Self-scheduling GC overrides (docs/2026-06-24-gc-scheduler-design.md §4/§5;
		 * repack phase: docs/2026-08-25-drain-repack-wiring.md). `enabled` gates the
		 * background drain as a whole, `repackEnabled` just its repack phase; an
		 * unset tunable falls through env (`PGGIT_GC_*`) to the drain schema's
		 * own defaults. */
		gc?: { enabled?: boolean } & GcSchedulerOptionsInput
	} = {},
): Promise<GitServer> {
	const databaseUrl = opts.databaseUrl ?? env.PGGIT_DATABASE_URL
	if (!databaseUrl) {
		throw new Error("pggit: PGGIT_DATABASE_URL is required to serve")
	}

	// The drain rides `createGcDrain` (gc-drain.ts), which owns its DEDICATED pool
	// and the pool's sizing — never this request pool. `enabled` is host policy:
	// it gates whether the drain is constructed at all. Unset tunables fall
	// through env to the drain schema's defaults.
	const gcEnabled = opts.gc?.enabled ?? env.PGGIT_GC_ENABLED
	const pg = postgres(databaseUrl)
	const app = createGitApp(createGitDeps(pg))
	const drain = gcEnabled
		? createGcDrain(databaseUrl, {
				concurrency: opts.gc?.concurrency ?? env.PGGIT_GC_CONCURRENCY,
				graceSeconds: opts.gc?.graceSeconds ?? env.PGGIT_GC_GRACE_SECONDS,
				intervalMs: opts.gc?.intervalMs ?? env.PGGIT_GC_INTERVAL_MS,
				repackEnabled: opts.gc?.repackEnabled ?? env.PGGIT_GC_REPACK_ENABLED,
			})
		: undefined

	const server = await serveOnPort(app, opts.port ?? env.PGGIT_PORT)
	drain?.start()
	return {
		close: async () => {
			// Drain first (awaits any in-flight pass, ends its own pool — safe ahead
			// of the server close because that pool is exclusively the drain's),
			// then the listener, then the request pool.
			await drain?.stop()
			await server.close()
			await pg.end()
		},
		port: server.port,
	}
}

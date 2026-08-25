import { serve } from "@hono/node-server"
import type { Hono } from "hono"
import postgres from "postgres"
import { env } from "@/env"
import { createGitApp, createGitDeps } from "@/index"
import {
	createGcSchedulerFromResolvedOptions,
	type GcSchedulerOptions,
	resolveGcSchedulerOptions,
} from "@/store/gc-scheduler"

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
		 * repack phase: docs/2026-08-25-drain-repack-wiring.md). Defaults come from
		 * `env` (`PGGIT_GC_*`); `enabled` gates the background drain as a whole,
		 * `repackEnabled` just its repack phase. */
		gc?: { enabled?: boolean } & Partial<GcSchedulerOptions>
	} = {},
): Promise<GitServer> {
	const databaseUrl = opts.databaseUrl ?? env.PGGIT_DATABASE_URL
	if (!databaseUrl) {
		throw new Error("pggit: PGGIT_DATABASE_URL is required to serve")
	}

	// Self-scheduling maintenance: the background GC-then-repack drain, off the request path (docs/2026-08-25-drain-repack-wiring.md). Enabled by default; opts override env (`PGGIT_GC_*`). A mounted host starts its own scheduler over its `pg` — `createGitApp` stays scheduler-free.
	//
	// The drain runs on a DEDICATED connection pool, separate from the request path:
	// each concurrent gc() reserves a connection for its whole live-set plan and sweep,
	// so sharing the request pool could starve clone/fetch/push under load. GC off the
	// hot path means off the hot pool — and the repack phase rides this same pool
	// (a repo's repack runs its queries serially, at most one connection at a time,
	// inside the headroom below). Sized to `concurrency` (one reservation per
	// concurrent repo) + 1 for the per-repo bookkeeping queries.
	const gcEnabled = opts.gc?.enabled ?? env.PGGIT_GC_ENABLED
	const gcOptions = resolveGcSchedulerOptions({
		concurrency: opts.gc?.concurrency ?? env.PGGIT_GC_CONCURRENCY,
		graceSeconds: opts.gc?.graceSeconds ?? env.PGGIT_GC_GRACE_SECONDS,
		intervalMs: opts.gc?.intervalMs ?? env.PGGIT_GC_INTERVAL_MS,
		repackEnabled: opts.gc?.repackEnabled ?? env.PGGIT_GC_REPACK_ENABLED,
	})
	const pg = postgres(databaseUrl)
	const app = createGitApp(createGitDeps(pg))
	const gcPg = gcEnabled
		? postgres(databaseUrl, { max: gcOptions.concurrency + 1 })
		: undefined
	const scheduler = gcPg
		? createGcSchedulerFromResolvedOptions(gcPg, gcOptions)
		: undefined

	const server = await serveOnPort(app, opts.port ?? env.PGGIT_PORT)
	scheduler?.start()
	return {
		close: async () => {
			// Drain the in-flight pass before tearing down its pool — stop() awaits it,
			// so no drain query runs into a closed pool (a clean SIGTERM, no spurious error).
			await scheduler?.stop()
			await server.close()
			await pg.end()
			await gcPg?.end()
		},
		port: server.port,
	}
}

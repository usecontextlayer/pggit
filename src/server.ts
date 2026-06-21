import { serve } from "@hono/node-server"
import type { Hono } from "hono"
import postgres from "postgres"
import { type Database, initKysely } from "@/database"
import { env } from "@/env"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { createSnapshotStore } from "@/repo-view/snapshot-store"

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
	opts: { port?: number; databaseUrl?: string } = {},
): Promise<GitServer> {
	const databaseUrl = opts.databaseUrl ?? env.PGGIT_DATABASE_URL
	if (!databaseUrl) {
		throw new Error("pggit: PGGIT_DATABASE_URL is required to serve")
	}
	const db = initKysely<Database>(postgres(databaseUrl))
	const app = createGitApp({
		objects: createObjectStore(db),
		refs: createRefStore(db),
		snapshots: createSnapshotStore(db),
	})
	const server = await serveOnPort(app, opts.port ?? env.PGGIT_PORT)
	return {
		close: async () => {
			await server.close()
			await db.destroy()
		},
		port: server.port,
	}
}

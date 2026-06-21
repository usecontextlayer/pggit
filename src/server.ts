import { serve } from "@hono/node-server"
import { env } from "@/env"
import { createGitApp } from "@/index"

export type GitServer = {
	port: number
	close: () => Promise<void>
}

/**
 * Builds the git app and serves it over Node HTTP. Mirrors slate-bridge's boot
 * sequence — serve(), await "listening", recover the actually-bound port (so
 * `port: 0` works for the oracle harness, which needs an ephemeral free port).
 *
 * This module has NO import-time side effects: importing it (e.g. from the test
 * harness) does not start a server. The standalone boot lives in `src/main.ts`.
 */
export async function startServer(
	opts: { port?: number; databaseUrl?: string } = {},
): Promise<GitServer> {
	const port = opts.port ?? env.PGGIT_PORT
	const app = createGitApp({
		databaseUrl: opts.databaseUrl ?? env.PGGIT_DATABASE_URL,
	})

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

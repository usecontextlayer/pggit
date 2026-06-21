import { Hono } from "hono"
import { cors } from "hono/cors"

export type AppEnv = {
	Variables: {
		// Populated by routing once repo-name → repo_id resolution lands.
		repoId: string
	}
}

export type CreateGitAppOptions = {
	// porsager DSN; if absent, object-store routes throw loudly (no fallback).
	databaseUrl?: string
}

/**
 * Builds the git-remote Hono app. Mountable as a sub-app into any host Hono app
 * via `host.route("/git", createGitApp(opts))`. No module-level singleton —
 * one app per call, the host owns lifecycle.
 */
export function createGitApp(_opts: CreateGitAppOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	app.use(cors())

	// Smart-HTTP git wire protocol surface (stubs — implemented per the spec):
	//   GET  /:repo/info/refs?service=git-upload-pack   (v2 fetch advertisement)
	//   POST /:repo/git-upload-pack                      (v2 fetch)
	//   GET  /:repo/info/refs?service=git-receive-pack   (v0 push advertisement)
	//   POST /:repo/git-receive-pack                     (v0 push)
	app.get("/health", (c) => c.text("ok"))

	return app
}

import { inject } from "vitest"
import { createGitApp, createGitDeps, type GitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

export type GitServerFixture = {
	db: IsolatedDb
	deps: GitDeps
	server: GitServer
}

/** Stand up the ordinary test server: an isolated migrated schema and its real stores. */
export async function setupGitServerFixture(
	baseUrl = inject("pgBaseUrl"),
): Promise<GitServerFixture> {
	const db = await createIsolatedSchema(baseUrl)
	try {
		const deps = createGitDeps(db.sql)
		const server = await serveOnPort(createGitApp(deps), 0)
		return { db, deps, server }
	} catch (error) {
		await db.drop()
		throw error
	}
}

/** Close the listener before destroying the database clients it may still be using. */
export async function teardownGitServerFixture(
	fixture: Pick<GitServerFixture, "db" | "server">,
): Promise<void> {
	try {
		await fixture.server.close()
	} finally {
		await fixture.db.drop()
	}
}

/** Smart-HTTP URL for one repo on a fixture server. */
export function repoUrl(server: Pick<GitServer, "port">, repo: string): string {
	return `http://127.0.0.1:${server.port}/${repo}`
}

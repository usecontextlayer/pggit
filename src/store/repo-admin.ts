import { sql } from "kysely"
import type { Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import type { RepoResolver } from "@/store/repo-resolver"

export type RepoAdmin = ReturnType<typeof createRepoAdmin>

/**
 * Administrative repo lifecycle, deliberately dumb and string-keyed: pggit knows
 * repo NAMES, never what they mean. Any naming grammar (and any notion of which
 * repos belong together) lives with the caller, who passes plain names and
 * prefixes down — the same opacity the wire surface keeps by treating the whole
 * request path as one repo name.
 *
 * `repos` must be the SAME resolver instance the live stores resolve through
 * (`createGitDeps` shares one across all of them): deletion invalidates its
 * name→id cache, and a store resolving through a different instance would keep
 * serving the dead id from its own cache.
 */
export function createRepoAdmin(pg: Sql, repos: RepoResolver) {
	const db = initKysely<Database>(pg)
	return {
		/**
		 * Delete a repo row; the child FKs (git_object / git_edge / git_ref /
		 * repo_file, ON DELETE CASCADE since 0007) take every dependent row with it
		 * in the same statement. An unknown name is a no-op returning false — repos
		 * are lazily created on first push, so "never existed" and "already deleted"
		 * are the same observable state, and a caller can re-run a partially-failed
		 * teardown blindly.
		 *
		 * A live writer racing this call can resurrect the repo (ensureRepoId is
		 * get-or-create); quiescing writers is the caller's contract, not enforced
		 * here.
		 */
		async deleteRepo(name: string): Promise<boolean> {
			const result = await db
				.deleteFrom("repos")
				.where("name", "=", name)
				.executeTakeFirst()
			repos.invalidate(name)
			return result.numDeletedRows > 0n
		},
		/**
		 * Names of every repo whose wire name starts with `prefix`, sorted. Plain
		 * `starts_with` — no wildcard semantics, so callers never escape anything.
		 */
		async listRepos(prefix: string): Promise<string[]> {
			const rows = await db
				.selectFrom("repos")
				.select("name")
				.where(sql<boolean>`starts_with(name, ${prefix})`)
				.orderBy("name")
				.execute()
			return rows.map((row) => row.name)
		},
	}
}

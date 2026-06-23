import type { Kysely } from "kysely"
import type { Database } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"

export type RepoResolver = ReturnType<typeof createRepoResolver>

/**
 * Resolves a wire repo name to its `repos.id` surrogate, memoized. The object and
 * ref stores both key on the bigint `repo_id`, so each builds one of these as its
 * name→id boundary.
 *
 * The mapping is immutable once a repo exists (ids are `generated always`, names
 * are unique), so a found id is cached for the resolver's lifetime — keeping the
 * per-object hot path (getObject) at one point-read, not a join. Misses are NEVER
 * cached: a name the lookup didn't find may be created by a later push, and a
 * cached `null` would mask it.
 *
 * Reads resolve (lookup; `null` ⇒ the repo has never been written, i.e. empty).
 * Writes ensure (race-safe get-or-create).
 */
export function createRepoResolver(db: Kysely<Database>) {
	const cache = new Map<string, ReposId>()

	return {
		/** The repo's id, creating the row if absent. Race-safe under concurrent
		 * first-pushes, and avoids a no-op UPDATE on the common (exists) path. */
		async ensureRepoId(name: string): Promise<ReposId> {
			const cached = cache.get(name)
			if (cached !== undefined) return cached
			const existing = await db
				.selectFrom("repos")
				.select("id")
				.where("name", "=", name)
				.executeTakeFirst()
			if (existing) {
				cache.set(name, existing.id)
				return existing.id
			}
			const inserted = await db
				.insertInto("repos")
				.values({ name })
				.onConflict((oc) => oc.doNothing())
				.returning("id")
				.executeTakeFirst()
			// `inserted` is undefined iff a concurrent push won the insert race; the
			// row is guaranteed present now, so re-select it.
			const id =
				inserted?.id ??
				(
					await db
						.selectFrom("repos")
						.select("id")
						.where("name", "=", name)
						.executeTakeFirstOrThrow()
				).id
			cache.set(name, id)
			return id
		},
		/** The repo's id, or `null` if it has never been written to. */
		async resolveRepoId(name: string): Promise<ReposId | null> {
			const cached = cache.get(name)
			if (cached !== undefined) return cached
			const row = await db
				.selectFrom("repos")
				.select("id")
				.where("name", "=", name)
				.executeTakeFirst()
			if (!row) return null
			cache.set(name, row.id)
			return row.id
		},
	}
}

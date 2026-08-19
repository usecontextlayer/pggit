import type { Kysely } from "kysely"
import type { Database } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"

export type RepoResolver = ReturnType<typeof createRepoResolver>

/**
 * One un-memoized name→id lookup — the primitive under the resolver. Memoizing
 * this mapping is safe ONLY for a component whose cache `admin.deleteRepo` can
 * reach with `invalidate` (the ONE resolver a `createGitDeps` composition
 * shares); any other holder — the offline passes, a store composed standalone —
 * would keep a deleted-and-recreated name pinned to the dead id and silently
 * read zero rows forever. Those callers use THIS, per operation: one point-read
 * is the whole price of staying correct.
 */
export async function lookupRepoId(
	db: Kysely<Database>,
	name: string,
): Promise<ReposId | null> {
	const row = await db
		.selectFrom("repos")
		.select("id")
		.where("name", "=", name)
		.executeTakeFirst()
	return row?.id ?? null
}

/**
 * Resolves a wire repo name to its `repos.id` surrogate, memoized. The object and
 * ref stores both key on the bigint `repo_id`, so each builds one of these as its
 * name→id boundary.
 *
 * The mapping is immutable once a repo exists (ids are `generated always`, names
 * are unique), so a found id is cached for the resolver's lifetime — keeping the
 * per-object hot path (getObject) at one point-read, not a join. Misses are NEVER
 * cached: a name the lookup didn't find may be created by a later push, and a
 * cached `null` would mask it. Deletion breaks the immutability premise, which is
 * why `invalidate` exists — and the actual safety condition is holding THE
 * resolver instance that `repo-admin` invalidates (the one `createGitDeps`
 * threads through the whole composition). Any resolver outside that composition —
 * the offline passes, a store built standalone with its own default resolver —
 * cannot be invalidated and must use `lookupRepoId` above instead.
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
			const existing = await lookupRepoId(db, name)
			if (existing !== null) {
				cache.set(name, existing)
				return existing
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
		/** Forget a cached mapping. Repo deletion calls this: the id is dead, and a
		 * later push under the same name must get-or-create a NEW row — a stale hit
		 * would write children against the deleted id and FK-fail. */
		invalidate(name: string): void {
			cache.delete(name)
		},
		/** The repo's id, or `null` if it has never been written to. */
		async resolveRepoId(name: string): Promise<ReposId | null> {
			const cached = cache.get(name)
			if (cached !== undefined) return cached
			const id = await lookupRepoId(db, name)
			if (id === null) return null
			cache.set(name, id)
			return id
		},
	}
}

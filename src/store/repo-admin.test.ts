import { describe, expect, inject, it } from "vitest"
import { createGitDeps, type GitDeps } from "@/index"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

const A = "a".repeat(40)
const ZERO = "0".repeat(40)

/** Fresh deps (the real composition: shared resolver across stores + admin) on an
 * isolated schema carved from the shared globalSetup container. */
async function freshDeps(): Promise<{ deps: GitDeps; db: IsolatedDb }> {
	const db = await createIsolatedSchema(inject("pgBaseUrl"))
	return { db, deps: createGitDeps(db.sql) }
}

/** Create `name` by writing a ref into it — the same lazy first-write birth a
 * real push performs (applyRefUpdates → ensureRepoId). */
async function bearRepo(deps: GitDeps, name: string): Promise<void> {
	await deps.refs.applyRefUpdates(
		name,
		[{ newOid: A, oldOid: ZERO, ref: "refs/heads/main" }],
		false,
	)
}

describe("repo admin — deleteRepo", () => {
	it("deletes the repo's rows, leaves siblings intact, and no-ops on unknown names", async () => {
		const { deps, db } = await freshDeps()
		try {
			await bearRepo(deps, "workspace/acme/w1")
			await bearRepo(deps, "workspace/acme/w2")

			expect(await deps.admin.deleteRepo("workspace/acme/w1")).toBe(true)

			// The deleted repo reads as never-written; the sibling is untouched.
			expect(await deps.refs.listRefs("workspace/acme/w1")).toEqual([])
			expect(await deps.refs.listRefs("workspace/acme/w2")).toEqual([
				{ name: "refs/heads/main", oid: A },
			])

			// Unknown and already-deleted names are the same observable state: no-op.
			expect(await deps.admin.deleteRepo("workspace/acme/w1")).toBe(false)
			expect(await deps.admin.deleteRepo("never/existed")).toBe(false)
		} finally {
			await db.drop()
		}
	})

	it("invalidates the shared resolver: a write under a deleted name gets a NEW repo, not an FK failure", async () => {
		const { deps, db } = await freshDeps()
		try {
			// First write warms the shared name→id cache through the ref store.
			await bearRepo(deps, "workspace/acme/w1")
			await deps.admin.deleteRepo("workspace/acme/w1")

			// Re-bearing the same name must get-or-create a fresh repos row. With a
			// stale cached id this insert would violate the git_ref→repos FK.
			await bearRepo(deps, "workspace/acme/w1")
			expect(await deps.refs.listRefs("workspace/acme/w1")).toEqual([
				{ name: "refs/heads/main", oid: A },
			])
		} finally {
			await db.drop()
		}
	})
})

describe("repo admin — listRepos", () => {
	it("lists names by plain prefix, sorted, without wildcard semantics", async () => {
		const { deps, db } = await freshDeps()
		try {
			await bearRepo(deps, "claude/slate/w1/user-b")
			await bearRepo(deps, "claude/slate/w1/user-a")
			await bearRepo(deps, "claude/slate/w10/user-c")
			await bearRepo(deps, "workspace/slate/w1")

			// The trailing separator scopes to w1 — w10 does not leak in.
			expect(await deps.admin.listRepos("claude/slate/w1/")).toEqual([
				"claude/slate/w1/user-a",
				"claude/slate/w1/user-b",
			])
			// `_` is a literal, not a LIKE wildcard: it matches nothing extra.
			expect(await deps.admin.listRepos("claude/slate/w_/")).toEqual([])
			expect(await deps.admin.listRepos("no/such/prefix")).toEqual([])
		} finally {
			await db.drop()
		}
	})
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

// Spine chunk 1 at the store seam: seeding a REAL git repo yields exactly one
// `git_commit`/`git_tag` row per commit/tag object — values cross-checked against
// real git's own readings of the same repo — and NOTHING else gets a row (trees
// and blobs are content, not graph rows). The e2e derivation suite
// (commit-graph-derivation.test.ts) covers the wire path and generation
// semantics; this file pins the seed/putPack path and the row-shape exactness.
describe("git_commit/git_tag derivation at seed", () => {
	let db: IsolatedDb
	let src = ""
	let c1 = ""
	let c2 = ""
	let t2 = ""
	let tag = ""
	let c1Time = 0
	let c2Time = 0

	type CommitRow = {
		oid: string
		tree: string
		parents: string[]
		commit_time: string
		generation: number
	}
	let commitRows = new Map<string, CommitRow>()
	let tagRows: { oid: string; target: string; target_type: number }[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)

		// A repo with a subtree (dir/), blobs, two commits (a real parent link), and
		// an annotated tag.
		src = mkdtempSync(join(tmpdir(), "pggit-rows-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		mkdirSync(join(src, "dir"))
		writeFileSync(join(src, "dir/inner.txt"), "inner\n")
		writeFileSync(join(src, "root.txt"), "one\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		writeFileSync(join(src, "root.txt"), "two\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c2"], { cwd: src })
		await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: src })

		await seedRepoIntoStore("repo", src, { objects, refs })

		const rp = async (rev: string): Promise<string> =>
			(await spawnGit(["rev-parse", rev], { cwd: src })).stdout.trim()
		c2 = await rp("HEAD")
		c1 = await rp("HEAD~1")
		t2 = await rp("HEAD^{tree}")
		tag = await rp("refs/tags/v1")
		const ct = async (rev: string): Promise<number> =>
			Number(
				(await spawnGit(["log", "-1", "--format=%ct", rev], { cwd: src })).stdout.trim(),
			)
		c1Time = await ct(c1)
		c2Time = await ct(c2)

		const commits = await db.sql<CommitRow[]>`
			select encode(c.oid, 'hex') as oid, encode(c.tree_oid, 'hex') as tree,
				(select coalesce(array_agg(encode(p.h, 'hex') order by p.ord), '{}')
					from unnest(c.parents) with ordinality as p(h, ord)) as parents,
				c.commit_time, c.generation
			from git_commit c join repos r on r.id = c.repo_id where r.name = 'repo'`
		commitRows = new Map(commits.map((r) => [r.oid, r]))
		tagRows = [
			...(await db.sql<{ oid: string; target: string; target_type: number }[]>`
				select encode(t.oid, 'hex') as oid, encode(t.target_oid, 'hex') as target,
					t.target_type
				from git_tag t join repos r on r.id = t.repo_id where r.name = 'repo'`),
		]
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("exactly one row per commit — trees and blobs contribute none", () => {
		expect(commitRows.size).toBe(2)
		expect(tagRows).toHaveLength(1)
	})

	it("each commit row matches git's own readings: tree, parents, committer time", () => {
		expect(commitRows.get(c1)).toMatchObject({
			commit_time: String(c1Time),
			generation: 1,
			parents: [],
		})
		expect(commitRows.get(c2)).toMatchObject({
			commit_time: String(c2Time),
			generation: 2,
			parents: [c1],
			tree: t2,
		})
	})

	it("the annotated tag's row carries target + stored type code", () => {
		expect(tagRows[0]).toMatchObject({ oid: tag, target: c2, target_type: 1 })
	})
})

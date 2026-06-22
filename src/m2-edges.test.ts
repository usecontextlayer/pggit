import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { EDGE_KIND } from "@/object-edges"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

// Chunk 2: edges are derived at ingest but nothing reads them yet, so the wire
// oracle cannot see this — assert the `git_edge` rows directly, cross-checked
// against real git's own view of the same objects.
describe("git_edge derivation at ingest", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let src = ""
	// oids gathered from real git after building the repo.
	let c1 = ""
	let c2 = ""
	let t1 = ""
	let t2 = ""
	let sub = ""
	let tag = ""
	type Edge = { parent: string; child: string; kind: number }
	let edges: Edge[] = []
	let blobOids: string[] = []

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.db)
		const refs = createRefStore(db.db)

		// A repo with a subtree (dir/), blobs, two commits (a parent edge), and an
		// annotated tag (a tag→target edge). dir/ is unchanged across commits, so its
		// subtree is shared — both root trees point at the same subtree.
		src = mkdtempSync(join(tmpdir(), "pggit-edges-src-"))
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
		t1 = await rp("HEAD~1^{tree}")
		sub = await rp("HEAD:dir")
		tag = await rp("refs/tags/v1")

		const rows = await db.db
			.selectFrom("git_edge")
			.select(["parent", "child", "kind"])
			.execute()
		edges = rows.map((r) => ({
			child: r.child.toString("hex"),
			kind: r.kind,
			parent: r.parent.toString("hex"),
		}))

		const list = await spawnGit(
			["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
			{ cwd: src },
		)
		blobOids = list.stdout
			.trim()
			.split("\n")
			.filter((l) => l.endsWith(" blob"))
			.map((l) => l.split(" ")[0] as string)
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		await container?.stop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	const has = (parent: string, child: string, kind: number): boolean =>
		edges.some((e) => e.parent === parent && e.child === child && e.kind === kind)

	it("commit → its root tree (kind 1)", () => {
		expect(has(c1, t1, EDGE_KIND.COMMIT_TREE)).toBe(true)
		expect(has(c2, t2, EDGE_KIND.COMMIT_TREE)).toBe(true)
	})

	it("commit → its parent (kind 2); a root commit has none", () => {
		expect(has(c2, c1, EDGE_KIND.COMMIT_PARENT)).toBe(true)
		expect(edges.some((e) => e.parent === c1 && e.kind === EDGE_KIND.COMMIT_PARENT)).toBe(
			false,
		)
	})

	it("tree → its subtree (kind 3), shared across both root trees", () => {
		expect(has(t1, sub, EDGE_KIND.TREE_SUBTREE)).toBe(true)
		expect(has(t2, sub, EDGE_KIND.TREE_SUBTREE)).toBe(true)
	})

	it("annotated tag → its target (kind 5)", () => {
		expect(has(tag, c2, EDGE_KIND.TAG_TARGET)).toBe(true)
	})

	it("blobs are never edges — no blob OID appears as a child, and the leaf subtree has no edges", () => {
		const children = new Set(edges.map((e) => e.child))
		for (const b of blobOids) expect(children.has(b)).toBe(false)
		// dir/ holds only inner.txt (a blob), so its subtree contributes no edge.
		expect(edges.some((e) => e.parent === sub)).toBe(false)
	})

	it("every commit and tag object carries its outgoing edges (no edgeless non-leaf)", () => {
		const parents = new Set(edges.map((e) => e.parent))
		for (const commit of [c1, c2]) expect(parents.has(commit)).toBe(true)
		expect(parents.has(tag)).toBe(true)
	})
})

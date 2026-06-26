import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { rebuildAllSnapshots } from "@/repo-view/rebuild"
import {
	createRepoFileProjection,
	type RepoFileProjection,
} from "@/repo-view/repo-file-projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { parseLsTree } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

// The EXTERNAL contract of the queryable file view, end to end: real `git push`
// is the input; the documented SQL surface — `repo_file` joined to `git_object`
// for content (resolving the wire repo name via `repos`) — is the read interface
// (output); real git is the oracle. Nothing here reaches into the decode / walk /
// store internals, so the implementation behind this contract is free to be
// refactored. The table and column names ARE the contract.

type FileRow = { path: string; mode: string; content: Buffer }

describe("repo-view — queryable file view (behaviour, real git)", () => {
	let db: IsolatedDb
	let server: GitServer
	let objects: ObjectStore
	let refs: RefStore
	let snapshots: RepoFileProjection

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		snapshots = createRepoFileProjection(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
	})

	/** The documented external read surface: the canonical "files at a ref" query —
	 * the slim repo_file index joined to git_object for content. */
	async function queryFiles(repoId: string, ref: string): Promise<FileRow[]> {
		const rows = await db.sql<FileRow[]>`
			select f.path, f.mode, o.content
			from repo_file f
			join repos r on r.id = f.repo_id
			join git_object o on o.repo_id = f.repo_id and o.oid = f.blob_oid
			where r.name = ${repoId} and f.ref_name = ${ref}
			order by f.path
		`
		return rows.map((r) => ({ content: r.content, mode: r.mode, path: r.path }))
	}

	/** Index rows for a ref — the projection is tip-bounded, not history-bounded. */
	async function fileRowCount(repoId: string, ref: string): Promise<number> {
		const rows = await db.sql<{ n: number }[]>`
			select count(*)::int as n from repo_file f
			join repos r on r.id = f.repo_id
			where r.name = ${repoId} and f.ref_name = ${ref}
		`
		return rows[0]?.n ?? 0
	}

	/** Path + blob oid per file at a ref — the same direct-SQL read surface a consumer
	 * uses (no read-API method), enough to observe content-addressed dedup across refs. */
	async function indexRows(
		repoId: string,
		ref: string,
	): Promise<{ path: string; blobOid: string }[]> {
		const rows = await db.sql<{ path: string; blob_oid: Buffer }[]>`
			select f.path, f.blob_oid
			from repo_file f
			join repos r on r.id = f.repo_id
			where r.name = ${repoId} and f.ref_name = ${ref}
			order by f.path collate "C"
		`
		return rows.map((r) => ({ blobOid: r.blob_oid.toString("hex"), path: r.path }))
	}

	/** Oracle: `git ls-tree -r` + `cat-file` as `{path, mode, content}`, sorted. */
	async function lsTreeFiles(dir: string, ref: string): Promise<FileRow[]> {
		const out = (await spawnGit(["ls-tree", "-r", ref], { cwd: dir })).stdout
		const files = await Promise.all(
			parseLsTree(out).map(async (e) => {
				const content = (await spawnGit(["cat-file", "blob", e.oid], { cwd: dir }))
					.stdoutBytes
				return { content, mode: e.mode, path: e.path }
			}),
		)
		return files.sort((a, b) => a.path.localeCompare(b.path))
	}

	function newRepo(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), `pggit-bhv-${prefix}-`))
		return dir
	}

	async function commitAll(dir: string, msg: string): Promise<void> {
		await spawnGit(["add", "-A"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", msg], { cwd: dir })
	}

	async function push(dir: string, repoId: string, refspec: string): Promise<void> {
		await spawnGit(["push", `http://127.0.0.1:${server.port}/${repoId}`, refspec], {
			cwd: dir,
		})
	}

	it("a push exposes the working tree as queryable rows (nested dirs, exec, symlink)", async () => {
		const dir = newRepo("basic")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			mkdirSync(join(dir, "sub"))
			writeFileSync(join(dir, "a.txt"), "alpha\n")
			writeFileSync(join(dir, "sub", "b.txt"), "beta\n")
			writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n")
			chmodSync(join(dir, "run.sh"), 0o755)
			symlinkSync("a.txt", join(dir, "link"))
			await commitAll(dir, "c1")
			await push(dir, "basic", "HEAD:refs/heads/main")

			expect(await queryFiles("basic", "refs/heads/main")).toEqual(
				await lsTreeFiles(dir, "HEAD"),
			)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("re-pushing a modified file updates the queried content", async () => {
		const dir = newRepo("modify")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "f.txt"), "version one\n")
			await commitAll(dir, "v1")
			await push(dir, "modify", "HEAD:refs/heads/main")
			expect((await queryFiles("modify", "refs/heads/main"))[0]?.content.toString()).toBe(
				"version one\n",
			)

			writeFileSync(join(dir, "f.txt"), "version two\n")
			await commitAll(dir, "v2")
			await push(dir, "modify", "HEAD:refs/heads/main")
			expect(await queryFiles("modify", "refs/heads/main")).toEqual(
				await lsTreeFiles(dir, "HEAD"),
			)
			expect((await queryFiles("modify", "refs/heads/main"))[0]?.content.toString()).toBe(
				"version two\n",
			)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("renaming a file moves it in the query and drops the old path", async () => {
		const dir = newRepo("rename")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "old.txt"), "content\n")
			await commitAll(dir, "v1")
			await push(dir, "rename", "HEAD:refs/heads/main")

			rmSync(join(dir, "old.txt"))
			writeFileSync(join(dir, "new.txt"), "content\n")
			await commitAll(dir, "v2")
			await push(dir, "rename", "HEAD:refs/heads/main")

			const got = await queryFiles("rename", "refs/heads/main")
			expect(got.map((f) => f.path)).toEqual(["new.txt"])
			expect(got).toEqual(await lsTreeFiles(dir, "HEAD"))
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("deleting a file removes it from the query", async () => {
		const dir = newRepo("delfile")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "keep.txt"), "keep\n")
			writeFileSync(join(dir, "drop.txt"), "drop\n")
			await commitAll(dir, "v1")
			await push(dir, "delfile", "HEAD:refs/heads/main")

			rmSync(join(dir, "drop.txt"))
			await commitAll(dir, "v2")
			await push(dir, "delfile", "HEAD:refs/heads/main")

			const got = await queryFiles("delfile", "refs/heads/main")
			expect(got.map((f) => f.path)).toEqual(["keep.txt"])
			expect(got).toEqual(await lsTreeFiles(dir, "HEAD"))
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("deleting the branch empties its query", async () => {
		const dir = newRepo("delbranch")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "x.txt"), "ex\n")
			await commitAll(dir, "c1")
			await push(dir, "delbranch", "HEAD:refs/heads/main")
			expect((await queryFiles("delbranch", "refs/heads/main")).length).toBe(1)

			await push(dir, "delbranch", ":refs/heads/main") // delete the branch
			expect(await queryFiles("delbranch", "refs/heads/main")).toEqual([])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("each branch is queryable independently", async () => {
		const dir = newRepo("multi")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "alpha\n")
			await commitAll(dir, "c1")
			await push(dir, "multi", "HEAD:refs/heads/main")
			const mainHead = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()

			writeFileSync(join(dir, "b.txt"), "beta\n")
			await commitAll(dir, "c2")
			await push(dir, "multi", "HEAD:refs/heads/dev")

			expect(await queryFiles("multi", "refs/heads/main")).toEqual(
				await lsTreeFiles(dir, mainHead),
			)
			expect(await queryFiles("multi", "refs/heads/dev")).toEqual(
				await lsTreeFiles(dir, "HEAD"),
			)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("the file index tracks only the tip across rewrites (one row, latest content)", async () => {
		const dir = newRepo("rewrite")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			for (const v of ["one", "two", "three"]) {
				writeFileSync(join(dir, "f.txt"), `${v}\n`)
				await commitAll(dir, v)
				await push(dir, "rewrite", "HEAD:refs/heads/main")
			}
			// Three pushes, but the index holds exactly the tip's one file (the object
			// store keeps history; the projection does not).
			expect(await fileRowCount("rewrite", "refs/heads/main")).toBe(1)
			expect(
				(await queryFiles("rewrite", "refs/heads/main"))[0]?.content.toString(),
			).toBe("three\n")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("identical content across branches shares one content-addressed blob", async () => {
		const dir = newRepo("dedup")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "shared\n")
			await commitAll(dir, "c1")
			await push(dir, "dedup", "HEAD:refs/heads/main")

			// Same content under a different path on another branch.
			rmSync(join(dir, "a.txt"))
			writeFileSync(join(dir, "b.txt"), "shared\n")
			await commitAll(dir, "c2")
			await push(dir, "dedup", "HEAD:refs/heads/dev")

			const main = await indexRows("dedup", "refs/heads/main")
			const dev = await indexRows("dedup", "refs/heads/dev")
			expect(main.map((f) => f.path)).toEqual(["a.txt"])
			expect(dev.map((f) => f.path)).toEqual(["b.txt"])
			// Same content → same OID → both index rows point at one git_object blob.
			expect(main[0]?.blobOid).toBe(dev[0]?.blobOid)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("rebuildAllSnapshots reconstructs the view after the projection is wiped", async () => {
		const dir = newRepo("backfill")
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "alpha\n")
			await commitAll(dir, "c1")
			await push(dir, "backfill", "HEAD:refs/heads/main")
			const mainHead = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
			writeFileSync(join(dir, "b.txt"), "beta\n")
			await commitAll(dir, "c2")
			await push(dir, "backfill", "HEAD:refs/heads/dev")

			// Simulate drift: wipe the projection via the public clearRepo (clean slate),
			// not raw table DELETEs — so the test is coupled to the documented store API,
			// not to the projection's internal table set.
			await snapshots.clearRepo("backfill")
			expect(await queryFiles("backfill", "refs/heads/main")).toEqual([])

			await rebuildAllSnapshots({ objects, refs, snapshots }, "backfill")

			expect(await queryFiles("backfill", "refs/heads/main")).toEqual(
				await lsTreeFiles(dir, mainHead),
			)
			expect(await queryFiles("backfill", "refs/heads/dev")).toEqual(
				await lsTreeFiles(dir, "HEAD"),
			)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

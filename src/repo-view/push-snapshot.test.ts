import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { createSnapshotStore, type SnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import { parseLsTree } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** Oracle: `git ls-tree -r` + `cat-file` as `{path, mode, content}`, sorted. */
async function lsTreeFiles(
	dir: string,
	ref: string,
): Promise<{ path: string; mode: string; content: Buffer }[]> {
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

describe("repo-view push hook (real git)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let snapshots: SnapshotStore

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.db)
		const refs = createRefStore(db.db)
		snapshots = createSnapshotStore(db.db)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
	})

	it("a push to refs/heads/main makes the working tree queryable as rows", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-view-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			mkdirSync(join(src, "sub"))
			writeFileSync(join(src, "a.txt"), "alpha\n")
			writeFileSync(join(src, "sub", "b.txt"), "beta\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })

			const url = `http://127.0.0.1:${server.port}/repo1`
			await spawnGit(["push", url, "HEAD:refs/heads/main"], { cwd: src })
			const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			const got = (await snapshots.readSnapshot("repo1", "refs/heads/main")).sort(
				(a, b) => a.path.localeCompare(b.path),
			)
			expect(got).toEqual(await lsTreeFiles(src, head))
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	it("deleting the branch drops its snapshot", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-view-del-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "x.txt"), "ex\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })

			const url = `http://127.0.0.1:${server.port}/repo2`
			await spawnGit(["push", url, "HEAD:refs/heads/main"], { cwd: src })
			expect(
				(await snapshots.listFiles("repo2", "refs/heads/main")).map((f) => f.path),
			).toEqual(["x.txt"])

			await spawnGit(["push", url, ":refs/heads/main"], { cwd: src }) // delete the branch
			expect(await snapshots.listFiles("repo2", "refs/heads/main")).toEqual([])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})
})

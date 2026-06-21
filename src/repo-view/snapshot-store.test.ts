import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ObjectReader } from "@/graph-walk"
import { computeOid } from "@/object"
import { createObjectStore, type ObjectStore } from "@/object-store"
import { buildFileList, type FileList } from "@/repo-view/build-file-list"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { loadAllObjects, parseLsTree } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** Adapt the object store into the ObjectReader the walk expects. */
function storeReader(objects: ObjectStore, repoId: string): ObjectReader {
	return async (oid) => {
		const obj = await objects.getObject(repoId, oid)
		if (!obj) throw new Error(`object ${oid} missing`)
		return obj
	}
}

/** Make a temp git repo, commit the given files, return its dir + HEAD oid. */
async function makeRepo(
	files: Record<string, string>,
): Promise<{ dir: string; head: string }> {
	const dir = mkdtempSync(join(tmpdir(), "pggit-snap-"))
	await spawnGit(["init", "-q"], { cwd: dir })
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path)
		mkdirSync(join(full, ".."), { recursive: true })
		writeFileSync(full, content)
	}
	await spawnGit(["add", "."], { cwd: dir })
	await spawnGit(["commit", "-q", "-m", "c"], { cwd: dir })
	const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
	return { dir, head }
}

/** A FileList exactly as buildFileList would produce, from in-line content. */
function fileListOf(
	entries: { path: string; mode?: string; content: string }[],
): FileList {
	const blobs = new Map<string, Buffer>()
	const files = entries.map((e) => {
		const content = Buffer.from(e.content)
		const oid = computeOid("blob", content)
		blobs.set(oid, content)
		return { blobOid: oid, mode: e.mode ?? "100644", path: e.path }
	})
	return { blobs: [...blobs].map(([oid, content]) => ({ content, oid })), files }
}

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

describe("snapshot store", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb

	beforeAll(async () => {
		container = await startPostgres()
	}, 180_000)

	afterAll(async () => {
		await container?.stop()
	})

	it("persists a ref snapshot readable as (path, mode, content) matching git ls-tree -r", async () => {
		db = await createIsolatedSchema(container.getConnectionUri())
		const { dir, head } = await makeRepo({
			"a.txt": "alpha\n",
			"sub/b.txt": "beta\n",
		})
		try {
			const objects = createObjectStore(db.db)
			await objects.putPack("repo1", await loadAllObjects(dir))
			const fileList = await buildFileList(storeReader(objects, "repo1"), head)

			const snapshots = createSnapshotStore(db.db)
			await snapshots.rebuildRefSnapshot("repo1", "refs/heads/main", fileList)

			const got = (await snapshots.readSnapshot("repo1", "refs/heads/main")).sort(
				(a, b) => a.path.localeCompare(b.path),
			)
			expect(got).toEqual(await lsTreeFiles(dir, head))
		} finally {
			await db.drop()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("replacing a ref drops removed files and reaps their orphaned blobs", async () => {
		db = await createIsolatedSchema(container.getConnectionUri())
		const dir = mkdtempSync(join(tmpdir(), "pggit-snap-"))
		try {
			const objects = createObjectStore(db.db)
			const snapshots = createSnapshotStore(db.db)
			const reader = storeReader(objects, "repo1")

			// v1: a.txt + gone.txt
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "alpha\n")
			writeFileSync(join(dir, "gone.txt"), "removed\n")
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "v1"], { cwd: dir })
			const headV1 = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
			await objects.putPack("repo1", await loadAllObjects(dir))
			await snapshots.rebuildRefSnapshot(
				"repo1",
				"refs/heads/main",
				await buildFileList(reader, headV1),
			)

			// v2: gone.txt removed
			rmSync(join(dir, "gone.txt"))
			await spawnGit(["add", "-A"], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "v2"], { cwd: dir })
			const headV2 = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
			await objects.putPack("repo1", await loadAllObjects(dir))
			await snapshots.rebuildRefSnapshot(
				"repo1",
				"refs/heads/main",
				await buildFileList(reader, headV2),
			)

			// Only a.txt survives in the snapshot.
			expect(
				(await snapshots.readSnapshot("repo1", "refs/heads/main")).map((f) => f.path),
			).toEqual(["a.txt"])
			// The removed file's blob is reaped; the surviving file's blob is kept.
			const oids = (
				await db.sql<
					{ oid: string }[]
				>`select oid from repo_view_blobs where repo_id = ${"repo1"}`
			).map((r) => r.oid)
			expect(oids).toContain(computeOid("blob", Buffer.from("alpha\n")))
			expect(oids).not.toContain(computeOid("blob", Buffer.from("removed\n")))
		} finally {
			await db.drop()
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("keeps a blob shared by another branch when one branch drops it", async () => {
		db = await createIsolatedSchema(container.getConnectionUri())
		try {
			const snapshots = createSnapshotStore(db.db)
			const shared = "shared\n"
			await snapshots.rebuildRefSnapshot(
				"repo1",
				"refs/heads/main",
				fileListOf([{ content: shared, path: "a.txt" }]),
			)
			await snapshots.rebuildRefSnapshot(
				"repo1",
				"refs/heads/dev",
				fileListOf([{ content: shared, path: "b.txt" }]),
			)
			// main moves off the shared blob; dev still references it.
			await snapshots.rebuildRefSnapshot(
				"repo1",
				"refs/heads/main",
				fileListOf([{ content: "other\n", path: "c.txt" }]),
			)

			const oids = (
				await db.sql<
					{ oid: string }[]
				>`select oid from repo_view_blobs where repo_id = ${"repo1"}`
			).map((r) => r.oid)
			expect(oids).toContain(computeOid("blob", Buffer.from(shared)))
			expect(
				(await snapshots.readSnapshot("repo1", "refs/heads/main")).map((f) => f.path),
			).toEqual(["c.txt"])
			expect(
				(await snapshots.readSnapshot("repo1", "refs/heads/dev")).map((f) => f.path),
			).toEqual(["b.txt"])
		} finally {
			await db.drop()
		}
	})

	it("dropRefSnapshot removes a branch's files and reaps its now-orphaned blobs", async () => {
		db = await createIsolatedSchema(container.getConnectionUri())
		try {
			const snapshots = createSnapshotStore(db.db)
			const shared = "shared\n"
			await snapshots.rebuildRefSnapshot(
				"repo1",
				"refs/heads/main",
				fileListOf([
					{ content: shared, path: "a.txt" },
					{ content: "mainonly\n", path: "m.txt" },
				]),
			)
			await snapshots.rebuildRefSnapshot(
				"repo1",
				"refs/heads/dev",
				fileListOf([{ content: shared, path: "d.txt" }]),
			)

			await snapshots.dropRefSnapshot("repo1", "refs/heads/main")

			expect(await snapshots.readSnapshot("repo1", "refs/heads/main")).toEqual([])
			expect(
				(await snapshots.readSnapshot("repo1", "refs/heads/dev")).map((f) => f.path),
			).toEqual(["d.txt"])
			const oids = (
				await db.sql<
					{ oid: string }[]
				>`select oid from repo_view_blobs where repo_id = ${"repo1"}`
			).map((r) => r.oid)
			expect(oids).toContain(computeOid("blob", Buffer.from(shared))) // dev keeps it alive
			expect(oids).not.toContain(computeOid("blob", Buffer.from("mainonly\n"))) // reaped
		} finally {
			await db.drop()
		}
	})

	it("listFiles returns paths/modes without content; readFile returns one file's content", async () => {
		db = await createIsolatedSchema(container.getConnectionUri())
		try {
			const snapshots = createSnapshotStore(db.db)
			await snapshots.rebuildRefSnapshot(
				"repo1",
				"refs/heads/main",
				fileListOf([
					{ content: "alpha\n", path: "a.txt" },
					{ content: "#!/bin/sh\n", mode: "100755", path: "run.sh" },
				]),
			)

			expect(await snapshots.listFiles("repo1", "refs/heads/main")).toEqual([
				{
					blobOid: computeOid("blob", Buffer.from("alpha\n")),
					mode: "100644",
					path: "a.txt",
				},
				{
					blobOid: computeOid("blob", Buffer.from("#!/bin/sh\n")),
					mode: "100755",
					path: "run.sh",
				},
			])
			expect(await snapshots.readFile("repo1", "refs/heads/main", "run.sh")).toEqual({
				content: Buffer.from("#!/bin/sh\n"),
				mode: "100755",
			})
			expect(
				await snapshots.readFile("repo1", "refs/heads/main", "missing.txt"),
			).toBeNull()
		} finally {
			await db.drop()
		}
	})
})

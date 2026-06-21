import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { computeOid } from "@/object"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { rebuildAllSnapshots } from "@/repo-view/rebuild"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { loadAllObjects } from "@/testing/git-fixtures"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("rebuildAllSnapshots", () => {
	let container: StartedPostgreSqlContainer

	beforeAll(async () => {
		container = await startPostgres()
	}, 180_000)

	afterAll(async () => {
		await container?.stop()
	})

	it("backfills every branch tip, skips non-branches, and clears drift", async () => {
		const db = await createIsolatedSchema(container.getConnectionUri())
		const dir = mkdtempSync(join(tmpdir(), "pggit-rebuildall-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })
			const c1 = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
			writeFileSync(join(dir, "d.txt"), "delta\n")
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "c2"], { cwd: dir })
			const c2 = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()

			const objects = createObjectStore(db.db)
			const refs = createRefStore(db.db)
			const snapshots = createSnapshotStore(db.db)
			await objects.putPack("repo1", await loadAllObjects(dir))
			await refs.setRef("repo1", "refs/heads/main", c1)
			await refs.setRef("repo1", "refs/heads/dev", c2)
			await refs.setRef("repo1", "refs/tags/v1", c2) // non-branch ref → must be skipped

			// Pre-existing drift: a stale snapshot for a branch that no longer exists.
			const staleOid = computeOid("blob", Buffer.from("stale\n"))
			await snapshots.rebuildRefSnapshot("repo1", "refs/heads/old", {
				blobs: [{ content: Buffer.from("stale\n"), oid: staleOid }],
				files: [{ blobOid: staleOid, mode: "100644", path: "stale.txt" }],
			})

			await rebuildAllSnapshots({ objects, refs, snapshots }, "repo1")

			expect(
				(await snapshots.listFiles("repo1", "refs/heads/main")).map((f) => f.path),
			).toEqual(["a.txt"])
			expect(
				(await snapshots.listFiles("repo1", "refs/heads/dev")).map((f) => f.path),
			).toEqual(["a.txt", "d.txt"])
			expect(await snapshots.listFiles("repo1", "refs/tags/v1")).toEqual([]) // non-branch skipped
			expect(await snapshots.listFiles("repo1", "refs/heads/old")).toEqual([]) // drift cleared
		} finally {
			await db.drop()
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

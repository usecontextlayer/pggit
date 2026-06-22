import { type Kysely, sql } from "kysely"
import type { Database } from "@/database"
import { createRepoResolver } from "@/repo-store"
import type { FileList } from "@/repo-view/build-file-list"

export type SnapshotFile = { path: string; mode: string; blobOid: string }
export type SnapshotFileContent = { path: string; mode: string; content: Buffer }

export type SnapshotStore = ReturnType<typeof createSnapshotStore>

/**
 * Postgres-backed queryable file view: a slim per-branch-tip `path → (mode,
 * blob_oid)` index (`repo_file`), with content read by joining `git_object` — no
 * duplicate blob bytes, no orphan reaper (the redesign's collapse, §4.5). It is a
 * derived projection of the canonical objects, rebuilt on push and droppable/
 * rebuildable at will. The wire repo name resolves to its bigint surrogate
 * (memoized) here, like the other stores.
 */
export function createSnapshotStore(db: Kysely<Database>) {
	const repos = createRepoResolver(db)

	/** repo_file ⋈ git_object: the file's content for the joined blob_oid. */
	const withContent = () =>
		db
			.selectFrom("repo_file")
			.innerJoin("git_object", (join) =>
				join
					.onRef("git_object.repo_id", "=", "repo_file.repo_id")
					.onRef("git_object.oid", "=", "repo_file.blob_oid"),
			)

	return {
		/** Drop a repo's entire projection (all branches) — the clean slate for a full
		 * rebuild. No blob bytes to reap; the index is the only state. */
		async clearRepo(repoId: string): Promise<void> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return
			await db.deleteFrom("repo_file").where("repo_id", "=", id).execute()
		},

		/** Drop `refName`'s snapshot (branch deleted). */
		async dropRefSnapshot(repoId: string, refName: string): Promise<void> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return
			await db
				.deleteFrom("repo_file")
				.where("repo_id", "=", id)
				.where("ref_name", "=", refName)
				.execute()
		},

		/** Every file at `refName`'s tip — path, mode, blob oid — ordered by path.
		 * No content (never joins git_object), so "what files exist" stays cheap. */
		async listFiles(repoId: string, refName: string): Promise<SnapshotFile[]> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return []
			const rows = await db
				.selectFrom("repo_file")
				.select(["path", "mode", "blob_oid"])
				.where("repo_id", "=", id)
				.where("ref_name", "=", refName)
				// COLLATE "C" = byte order, matching `git ls-tree -r` regardless of the
				// database's default collation.
				.orderBy(sql`path collate "C"`)
				.execute()
			return rows.map((r) => ({
				blobOid: r.blob_oid.toString("hex"),
				mode: r.mode,
				path: r.path,
			}))
		},

		/** One file's mode + content at `refName`'s tip, or null if absent. */
		async readFile(
			repoId: string,
			refName: string,
			path: string,
		): Promise<{ mode: string; content: Buffer } | null> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return null
			const row = await withContent()
				.select(["repo_file.mode", "git_object.content"])
				.where("repo_file.repo_id", "=", id)
				.where("repo_file.ref_name", "=", refName)
				.where("repo_file.path", "=", path)
				.executeTakeFirst()
			return row ? { content: row.content, mode: row.mode } : null
		},

		/** Every file at `refName`'s tip, with content, ordered by path. */
		async readSnapshot(repoId: string, refName: string): Promise<SnapshotFileContent[]> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return []
			const rows = await withContent()
				.select(["repo_file.path", "repo_file.mode", "git_object.content"])
				.where("repo_file.repo_id", "=", id)
				.where("repo_file.ref_name", "=", refName)
				.orderBy(sql`repo_file.path collate "C"`)
				.execute()
			return rows.map((r) => ({ content: r.content, mode: r.mode, path: r.path }))
		},

		/** Replace `refName`'s snapshot with `fileList` (one atomic transaction). The
		 * blobs already live in git_object — we store only the path→blob_oid index. */
		async rebuildRefSnapshot(
			repoId: string,
			refName: string,
			fileList: FileList,
		): Promise<void> {
			const id = await repos.ensureRepoId(repoId)
			await db.transaction().execute(async (tx) => {
				await tx
					.deleteFrom("repo_file")
					.where("repo_id", "=", id)
					.where("ref_name", "=", refName)
					.execute()
				if (fileList.files.length > 0) {
					await tx
						.insertInto("repo_file")
						.values(
							fileList.files.map((f) => ({
								blob_oid: Buffer.from(f.blobOid, "hex"),
								mode: f.mode,
								path: f.path,
								ref_name: refName,
								repo_id: id,
							})),
						)
						.execute()
				}
			})
		},
	}
}

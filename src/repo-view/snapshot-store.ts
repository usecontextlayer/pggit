import { type Kysely, sql, type Transaction } from "kysely"
import type { Database } from "@/database"
import type {
	RepoViewBlobsOid,
	RepoViewBlobsRepoId,
} from "@/database/models/public/RepoViewBlobs"
import type {
	RepoViewFilesPath,
	RepoViewFilesRefName,
} from "@/database/models/public/RepoViewFiles"
import type { FileList } from "@/repo-view/build-file-list"

export type SnapshotFile = { path: string; mode: string; blobOid: string }
export type SnapshotFileContent = { path: string; mode: string; content: Buffer }

export type SnapshotStore = ReturnType<typeof createSnapshotStore>

/**
 * Postgres-backed queryable file view: a flat per-branch-tip snapshot of a repo's
 * working tree (`repo_view_files` joined to deduped `repo_view_blobs`). It is a
 * derived projection of the canonical packs — rebuilt on push, droppable and
 * rebuildable at will. Like the other stores, this is the wire→DB boundary, so
 * plain hex strings are cast to their generated branded column types here.
 */
export function createSnapshotStore(db: Kysely<Database>) {
	return {
		/** Drop a repo's entire projection (all branches + blobs) — the clean slate
		 * for a full rebuild. Files first, then blobs (FK order). */
		async clearRepo(repoId: string): Promise<void> {
			await db.transaction().execute(async (tx) => {
				await tx
					.deleteFrom("repo_view_files")
					.where("repo_id", "=", repoId as RepoViewBlobsRepoId)
					.execute()
				await tx
					.deleteFrom("repo_view_blobs")
					.where("repo_id", "=", repoId as RepoViewBlobsRepoId)
					.execute()
			})
		},

		/** Drop `refName`'s snapshot entirely (branch deleted), reaping orphans. */
		async dropRefSnapshot(repoId: string, refName: string): Promise<void> {
			await db.transaction().execute(async (tx) => {
				await tx
					.deleteFrom("repo_view_files")
					.where("repo_id", "=", repoId as RepoViewBlobsRepoId)
					.where("ref_name", "=", refName as RepoViewFilesRefName)
					.execute()
				await reapOrphanBlobs(tx, repoId)
			})
		},

		/** Every file at `refName`'s tip — path, mode, blob oid — ordered by path.
		 * No content (never touches blobs), so "what files exist" stays cheap. */
		async listFiles(repoId: string, refName: string): Promise<SnapshotFile[]> {
			const rows = await db
				.selectFrom("repo_view_files")
				.select(["path", "mode", "blob_oid"])
				.where("repo_id", "=", repoId as RepoViewBlobsRepoId)
				.where("ref_name", "=", refName as RepoViewFilesRefName)
				.orderBy("path")
				.execute()
			return rows.map((r) => ({ blobOid: r.blob_oid, mode: r.mode, path: r.path }))
		},

		/** One file's mode + content at `refName`'s tip, or null if absent. */
		async readFile(
			repoId: string,
			refName: string,
			path: string,
		): Promise<{ mode: string; content: Buffer } | null> {
			const row = await db
				.selectFrom("repo_view_files")
				.innerJoin("repo_view_blobs", (join) =>
					join
						.onRef("repo_view_blobs.repo_id", "=", "repo_view_files.repo_id")
						.onRef("repo_view_blobs.oid", "=", "repo_view_files.blob_oid"),
				)
				.select(["repo_view_files.mode", "repo_view_blobs.content"])
				.where("repo_view_files.repo_id", "=", repoId as RepoViewBlobsRepoId)
				.where("repo_view_files.ref_name", "=", refName as RepoViewFilesRefName)
				.where("repo_view_files.path", "=", path as RepoViewFilesPath)
				.executeTakeFirst()
			return row ? { content: row.content, mode: row.mode } : null
		},

		/** Every file at `refName`'s tip, with content, ordered by path. */
		async readSnapshot(repoId: string, refName: string): Promise<SnapshotFileContent[]> {
			const rows = await db
				.selectFrom("repo_view_files")
				.innerJoin("repo_view_blobs", (join) =>
					join
						.onRef("repo_view_blobs.repo_id", "=", "repo_view_files.repo_id")
						.onRef("repo_view_blobs.oid", "=", "repo_view_files.blob_oid"),
				)
				.select([
					"repo_view_files.path",
					"repo_view_files.mode",
					"repo_view_blobs.content",
				])
				.where("repo_view_files.repo_id", "=", repoId as RepoViewBlobsRepoId)
				.where("repo_view_files.ref_name", "=", refName as RepoViewFilesRefName)
				.orderBy("repo_view_files.path")
				.execute()
			return rows.map((r) => ({ content: r.content, mode: r.mode, path: r.path }))
		},

		/** Replace `refName`'s snapshot with `fileList` (one atomic transaction). */
		async rebuildRefSnapshot(
			repoId: string,
			refName: string,
			fileList: FileList,
		): Promise<void> {
			await db.transaction().execute(async (tx) => {
				// Content first — the files FK requires the blob to already exist.
				if (fileList.blobs.length > 0) {
					await tx
						.insertInto("repo_view_blobs")
						.values(
							fileList.blobs.map((b) => ({
								content: b.content,
								oid: b.oid as RepoViewBlobsOid,
								repo_id: repoId as RepoViewBlobsRepoId,
							})),
						)
						.onConflict((oc) => oc.doNothing())
						.execute()
				}
				await tx
					.deleteFrom("repo_view_files")
					.where("repo_id", "=", repoId as RepoViewBlobsRepoId)
					.where("ref_name", "=", refName as RepoViewFilesRefName)
					.execute()
				if (fileList.files.length > 0) {
					await tx
						.insertInto("repo_view_files")
						.values(
							fileList.files.map((f) => ({
								blob_oid: f.blobOid as RepoViewBlobsOid,
								mode: f.mode,
								path: f.path as RepoViewFilesPath,
								ref_name: refName as RepoViewFilesRefName,
								repo_id: repoId as RepoViewBlobsRepoId,
							})),
						)
						.execute()
				}
				await reapOrphanBlobs(tx, repoId)
			})
		},
	}
}

/**
 * Delete every blob of `repoId` no longer referenced by any ref's snapshot — the
 * cost of the shared (deduped) blob table, run in the rebuild transaction so
 * storage stays bounded by the live working-tree size. Per-repo serialization
 * (the push advisory lock) keeps a concurrent rebuild from re-adding a row this
 * anti-join is about to drop.
 */
async function reapOrphanBlobs(tx: Transaction<Database>, repoId: string): Promise<void> {
	await sql`
		delete from repo_view_blobs b
		where b.repo_id = ${repoId}
		  and not exists (
			select 1 from repo_view_files f
			where f.repo_id = b.repo_id and f.blob_oid = b.oid
		)
	`.execute(tx)
}

import type { Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import { type CopyValue, copyInsert } from "@/database/copy-insert"
import type { FileList } from "@/repo-view/build-file-list"
import { createRepoResolver } from "@/store/repo-resolver"

export type RepoFileProjection = ReturnType<typeof createRepoFileProjection>

/**
 * Write-only maintainer of `repo_file`: the slim per-branch-tip `path → (mode,
 * blob_oid)` index that IS pggit's public read surface. Reads never go through this
 * module — a consumer queries `repo_file ⋈ git_object` (on `oid = blob_oid`) with
 * direct SQL, the one read mechanism (docs/2026-06-26-read-surface-sharpening-design.md).
 * So this only ever rebuilds or drops the projection on push; there is no read method
 * here by design. It is a derived projection of the canonical objects — no duplicate
 * blob bytes, no orphan reaper (the redesign's collapse, §4.5) — droppable and
 * rebuildable at will. The wire repo name resolves to its bigint surrogate (memoized)
 * here, like the other stores.
 */
export function createRepoFileProjection(pg: Sql) {
	const db = initKysely<Database>(pg)
	const repos = createRepoResolver(db)

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

		/** Replace `refName`'s snapshot with `fileList` (one atomic transaction). The
		 * blobs already live in git_object — we store only the path→blob_oid index. */
		async rebuildRefSnapshot(
			repoId: string,
			refName: string,
			fileList: FileList,
		): Promise<void> {
			const id = await repos.ensureRepoId(repoId)
			const rows: CopyValue[][] = fileList.files.map((f) => [
				{ t: "int8", v: id },
				{ t: "text", v: refName },
				{ t: "text", v: f.path },
				{ t: "text", v: f.mode },
				{ t: "bytea", v: Buffer.from(f.blobOid, "hex") },
			])
			// Replace the branch's snapshot in one transaction. COPY into staging has no
			// bind-parameter ceiling, so a tip with any file count lands in a single
			// statement (an un-chunked multi-row INSERT died at ~13k files, §a06).
			await pg.begin(async (tx) => {
				await tx`delete from repo_file where repo_id = ${id} and ref_name = ${refName}`
				await copyInsert(
					tx,
					"repo_file",
					["repo_id", "ref_name", "path", "mode", "blob_oid"],
					rows,
				)
			})
		},
	}
}

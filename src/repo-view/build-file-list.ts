import type { ObjectReader } from "@/graph-walk"
import { commitTreeOid, isTreeEntryMode, treeEntries } from "@/object"

export type FileEntry = { path: string; mode: string; blobOid: string }
export type BlobEntry = { oid: string; content: Buffer }
export type FileList = { files: FileEntry[]; blobs: BlobEntry[] }

/** Gitlink/submodule entries point at a commit in another repo — no blob here. */
const GITLINK_MODE = "160000"

/**
 * The flat file list of a commit's tree: one FileEntry per blob (full path from
 * the root, raw mode, blob oid) plus the deduped blob contents. It is the
 * `git ls-tree -r` of a commit, read straight from the object store — no
 * checkout. Subtrees are recursed; gitlinks (submodules) are skipped (they have
 * no blob in this repo). Blobs are deduped by oid (identical content stored once).
 */
export async function buildFileList(
	read: ObjectReader,
	commitOid: string,
): Promise<FileList> {
	const commit = await read(commitOid)
	const files: FileEntry[] = []
	const blobs = new Map<string, Buffer>()

	const walk = async (treeOid: string, prefix: string): Promise<void> => {
		const tree = await read(treeOid)
		for (const entry of treeEntries(tree.content)) {
			const path = prefix + entry.name
			if (isTreeEntryMode(entry.mode)) {
				await walk(entry.oid, `${path}/`)
			} else if (entry.mode !== GITLINK_MODE) {
				files.push({ blobOid: entry.oid, mode: entry.mode, path })
				if (!blobs.has(entry.oid)) blobs.set(entry.oid, (await read(entry.oid)).content)
			}
		}
	}

	await walk(commitTreeOid(commit.content), "")
	return {
		blobs: [...blobs].map(([oid, content]) => ({ content, oid })),
		files,
	}
}

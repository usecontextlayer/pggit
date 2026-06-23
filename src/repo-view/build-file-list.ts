import {
	commitTreeOid,
	type GitObjectType,
	isTreeEntryMode,
	treeEntries,
} from "@/object/object"

/** Reads a stored object's type + content by OID — the snapshot builder's view of
 * the object store. */
export type ObjectReader = (
	oid: string,
) => Promise<{ type: GitObjectType; content: Buffer }>

export type FileEntry = { path: string; mode: string; blobOid: string }
export type FileList = { files: FileEntry[] }

/** Gitlink/submodule entries point at a commit in another repo — no blob here. */
const GITLINK_MODE = "160000"

/**
 * The flat path→blob index of a commit's tree (the `git ls-tree -r` of a commit,
 * read straight from the object store): one FileEntry per blob — full path from the
 * root, raw mode, blob oid. Subtrees are recursed; gitlinks (submodules) are skipped
 * (no blob in this repo). Blob CONTENT is NOT read — it lives in git_object and is
 * joined at query time (§4.5 collapse), so this walk touches only commits + trees.
 */
export async function buildFileList(
	read: ObjectReader,
	commitOid: string,
): Promise<FileList> {
	const commit = await read(commitOid)
	const files: FileEntry[] = []

	const walk = async (treeOid: string, prefix: string): Promise<void> => {
		const tree = await read(treeOid)
		for (const entry of treeEntries(tree.content)) {
			const path = prefix + entry.name
			if (isTreeEntryMode(entry.mode)) {
				await walk(entry.oid, `${path}/`)
			} else if (entry.mode !== GITLINK_MODE) {
				files.push({ blobOid: entry.oid, mode: entry.mode, path })
			}
		}
	}

	await walk(commitTreeOid(commit.content), "")
	return { files }
}

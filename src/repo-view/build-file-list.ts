import { commitTreeOid } from "@/object/object"
import { type FileEntry, listFiles, type TreeReader } from "@/object/tree-diff"

export type ObjectReader = (oid: string) => Promise<{ content: Buffer }>
export type { FileEntry } from "@/object/tree-diff"
export type FileList = { files: FileEntry[] }

/**
 * The flat path→blob index of a commit's tree (the `git ls-tree -r` of a commit,
 * read straight from the object store): one FileEntry per blob — full path from
 * the root, raw mode, blob oid. Subtrees are recursed; gitlinks (submodules) are
 * skipped (no blob in this repo). Blob CONTENT is NOT read — it lives in
 * git_object and is joined at query time (§4.5 collapse). The walk itself is
 * `listFiles` (object/tree-diff.ts), shared with the diff path so the full and
 * incremental projections can never disagree about what a tree contains.
 */
export async function buildFileList(
	readObject: ObjectReader,
	commitOid: string,
): Promise<FileList> {
	const commit = await readObject(commitOid)
	const readTree: TreeReader = async (oid) => (await readObject(oid)).content
	return { files: await listFiles(readTree, commitTreeOid(commit.content)) }
}

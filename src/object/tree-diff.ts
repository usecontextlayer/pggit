import {
	GITLINK_MODE,
	isTreeEntryMode,
	type TreeEntry,
	treeEntries,
} from "@/object/object"

/**
 * File-level tree diffing (spine chunk 4 / S3) — the deliberate NO-LIBRARY
 * exception: git's tree grammar is the fsck-critical parser this repo already
 * owns, and no library implements git tree-diff semantics, so a second grammar
 * implementation would be two truths for one concept. Entries pair by NAME per
 * directory (git's structural unit) and compare `(mode, oid)` — a mode-only
 * change (100644→100755, file↔symlink) is a change (R14). Unchanged subtrees
 * prune the walk whole: the cost is O(changed entries + touched directories),
 * never O(files at tip).
 *
 * Gitlinks are INVISIBLE on both sides — they have no blob in this repo, so the
 * `repo_file` projection never rows them (`listFiles` skips them exactly as the
 * full rebuild always has), and a gitlink appearing, vanishing, or retargeting
 * diffs to nothing. This is the one deliberate divergence from `git diff-tree`
 * output, which does report them; the arbiter for this module is
 * "incremental ≡ full rebuild", not gitlink parity.
 */

/** Reads a tree body by OID. The caller resolves the object; the stored
 * typed-edge invariant guarantees the content crossing into this core is a tree. */
export type TreeReader = (oid: string) => Promise<Buffer>

/** One projected file: full path from the root, raw stored mode, blob oid. */
export type FileEntry = { path: string; mode: string; blobOid: string }

async function entriesOf(read: TreeReader, treeOid: string): Promise<TreeEntry[]> {
	return treeEntries(await read(treeOid))
}

/**
 * Every file under `treeOid`, recursively, `prefix`ed — the `git ls-tree -r` of
 * a tree. Gitlinks are skipped (no blob in this repo); blob CONTENT is never
 * read (the projection joins it at query time).
 */
export async function listFiles(
	read: TreeReader,
	treeOid: string,
	prefix = "",
): Promise<FileEntry[]> {
	const files: FileEntry[] = []
	for (const e of await entriesOf(read, treeOid)) {
		if (isTreeEntryMode(e.mode)) {
			for (const f of await listFiles(read, e.oid, `${prefix}${e.name}/`)) files.push(f)
		} else if (e.mode !== GITLINK_MODE) {
			files.push({ blobOid: e.oid, mode: e.mode, path: prefix + e.name })
		}
	}
	return files
}

export type FileDiff = { removed: string[]; upserts: FileEntry[] }

/**
 * The file-level difference `beforeTree → afterTree`: `removed` paths and
 * `upserts` (added ∪ changed, with their after-side mode + blob). Applying it to
 * the before-side file list yields exactly the after-side file list — the
 * incremental `repo_file` maintenance primitive.
 */
export async function diffFileLists(
	read: TreeReader,
	beforeTree: string,
	afterTree: string,
): Promise<FileDiff> {
	const diff: FileDiff = { removed: [], upserts: [] }
	await diffLevel(read, beforeTree, afterTree, "", diff)
	return diff
}

async function diffLevel(
	read: TreeReader,
	aOid: string,
	bOid: string,
	prefix: string,
	diff: FileDiff,
): Promise<void> {
	if (aOid === bOid) return
	const before = new Map((await entriesOf(read, aOid)).map((e) => [e.name, e]))
	const after = await entriesOf(read, bOid)
	const afterNames = new Set<string>()

	const addSide = async (e: TreeEntry, path: string): Promise<void> => {
		if (isTreeEntryMode(e.mode)) {
			for (const f of await listFiles(read, e.oid, `${path}/`)) diff.upserts.push(f)
		} else if (e.mode !== GITLINK_MODE) {
			diff.upserts.push({ blobOid: e.oid, mode: e.mode, path })
		}
	}
	const removeSide = async (e: TreeEntry, path: string): Promise<void> => {
		if (isTreeEntryMode(e.mode)) {
			for (const f of await listFiles(read, e.oid, `${path}/`)) diff.removed.push(f.path)
		} else if (e.mode !== GITLINK_MODE) {
			diff.removed.push(path)
		}
	}

	for (const be of after) {
		afterNames.add(be.name)
		const ae = before.get(be.name)
		const path = prefix + be.name
		if (ae === undefined) {
			await addSide(be, path)
			continue
		}
		const aTree = isTreeEntryMode(ae.mode)
		const bTree = isTreeEntryMode(be.mode)
		if (aTree && bTree) {
			if (ae.oid !== be.oid) await diffLevel(read, ae.oid, be.oid, `${path}/`, diff)
		} else if (aTree || bTree) {
			// dir↔file swap at one name: the old side's files go, the new side comes.
			await removeSide(ae, path)
			await addSide(be, path)
		} else if (ae.mode !== be.mode || ae.oid !== be.oid) {
			// Both non-tree. A gitlink flip is add/remove of the visible side;
			// a same-shape change upserts with the after-side (mode, oid).
			if (ae.mode === GITLINK_MODE || be.mode === GITLINK_MODE) {
				await removeSide(ae, path)
				await addSide(be, path)
			} else {
				diff.upserts.push({ blobOid: be.oid, mode: be.mode, path })
			}
		}
	}
	for (const [name, ae] of before) {
		if (!afterNames.has(name)) await removeSide(ae, prefix + name)
	}
}

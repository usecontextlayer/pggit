import {
	GITLINK_MODE,
	isTreeEntryMode,
	type TreeEntry,
	treeEntries,
} from "@/object/object"

/**
 * Git tree comparison — the deliberate NO-LIBRARY exception. This repo already
 * owns the fsck-critical tree grammar, and no library implements git tree-diff
 * semantics. {@link IndexedTree} and {@link pairTreeEntries} own the structural
 * rule shared by projection, frontier, and repack: entries pair by NAME within
 * each directory.
 *
 * {@link diffFileLists} layers the `repo_file` projection semantics on that
 * pairing. It compares `(mode, oid)`, including mode-only changes, and prunes
 * unchanged subtrees whole. Gitlinks are invisible to this projection because
 * they name no blob stored in this repo; `listFiles` skips them on rebuild, so an
 * incremental gitlink change must likewise produce no projected row change.
 */

/** Reads a tree body by OID. The caller resolves the object; the stored
 * typed-edge invariant guarantees the content crossing into this core is a tree. */
export type TreeReader = (oid: string) => Promise<Buffer>

/** One projected file: full path from the root, raw stored mode, blob oid. */
export type FileEntry = { path: string; mode: string; blobOid: string }

/** One parsed tree plus its name index, the structural unit shared by every
 * tree-diff consumer. `content` remains available to consumers such as repack
 * that also encode the body. */
export type IndexedTree = {
	content: Buffer
	entries: TreeEntry[]
	byName: ReadonlyMap<string, TreeEntry>
}

/** Parse a tree once and index its entries by their per-directory name. */
export function indexTreeEntries(content: Buffer): IndexedTree {
	const entries = treeEntries(content)
	const byName = new Map<string, TreeEntry>()
	for (const entry of entries) byName.set(entry.name, entry)
	return {
		byName,
		content,
		entries,
	}
}

async function readIndexedTree(read: TreeReader, treeOid: string): Promise<IndexedTree> {
	return indexTreeEntries(await read(treeOid))
}

export type TreeEntryPair =
	| { state: "added"; after: TreeEntry }
	| { state: "removed"; before: TreeEntry }
	| { state: "paired"; before: TreeEntry; after: TreeEntry }

/** Pair two directories by entry name, preserving after-side order before
 * yielding names that exist only on the before side. */
export function* pairTreeEntries(
	before: IndexedTree,
	after: IndexedTree,
): Generator<TreeEntryPair> {
	const afterNames = new Set<string>()
	for (const entry of after.entries) {
		afterNames.add(entry.name)
		const previous = before.byName.get(entry.name)
		if (previous === undefined) yield { after: entry, state: "added" }
		else yield { after: entry, before: previous, state: "paired" }
	}
	for (const entry of before.byName.values()) {
		if (!afterNames.has(entry.name)) yield { before: entry, state: "removed" }
	}
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
	for (const e of treeEntries(await read(treeOid))) {
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
	beforeOid: string,
	afterOid: string,
	prefix: string,
	diff: FileDiff,
): Promise<void> {
	if (beforeOid === afterOid) return
	const before = await readIndexedTree(read, beforeOid)
	const after = await readIndexedTree(read, afterOid)

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

	for (const pair of pairTreeEntries(before, after)) {
		if (pair.state === "added") {
			await addSide(pair.after, prefix + pair.after.name)
			continue
		}
		if (pair.state === "removed") {
			await removeSide(pair.before, prefix + pair.before.name)
			continue
		}
		const beforeEntry = pair.before
		const afterEntry = pair.after
		const path = prefix + afterEntry.name
		const beforeIsTree = isTreeEntryMode(beforeEntry.mode)
		const afterIsTree = isTreeEntryMode(afterEntry.mode)
		if (beforeIsTree && afterIsTree) {
			if (beforeEntry.oid !== afterEntry.oid) {
				await diffLevel(read, beforeEntry.oid, afterEntry.oid, `${path}/`, diff)
			}
		} else if (beforeIsTree || afterIsTree) {
			// dir↔file swap at one name: the old side's files go, the new side comes.
			await removeSide(beforeEntry, path)
			await addSide(afterEntry, path)
		} else if (
			beforeEntry.mode !== afterEntry.mode ||
			beforeEntry.oid !== afterEntry.oid
		) {
			// Both non-tree. A gitlink flip is add/remove of the visible side;
			// a same-shape change upserts with the after-side (mode, oid).
			if (beforeEntry.mode === GITLINK_MODE || afterEntry.mode === GITLINK_MODE) {
				await removeSide(beforeEntry, path)
				await addSide(afterEntry, path)
			} else {
				diff.upserts.push({
					blobOid: afterEntry.oid,
					mode: afterEntry.mode,
					path,
				})
			}
		}
	}
}

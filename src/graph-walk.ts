import {
	type GitObjectType,
	isTreeEntryMode,
	referencedOids,
	treeEntries,
} from "@/object"

export type WalkObject = { type: GitObjectType; content: Buffer }
export type ObjectReader = (oid: string) => Promise<WalkObject>

export type WalkOptions = {
	/** Omit blobs — the `filter blob:none` partial-clone walk (spec §3.5). */
	omitBlobs?: boolean
}

/**
 * Enumerate every object reachable from `tips` (inclusive), following the OID
 * references each object declares. This is the fetch enumeration engine — the
 * server walks from the wanted tips to build the set of objects to pack. Net-new
 * server work, not an index lookup (spec §5).
 *
 * With `omitBlobs`, trees are walked by entry mode: only subtrees are recursed,
 * so blob entries are never enqueued — never read, never packed. This is the
 * mode-based blobless walk, not a type filter applied after reading.
 */
export async function graphWalk(
	tips: string[],
	read: ObjectReader,
	opts: WalkOptions = {},
): Promise<Set<string>> {
	const omitBlobs = opts.omitBlobs ?? false
	const seen = new Set<string>()
	const queue = [...tips]
	while (queue.length > 0) {
		const oid = queue.pop()
		if (oid === undefined || seen.has(oid)) continue
		seen.add(oid)
		const obj = await read(oid)
		for (const ref of childOids(obj, omitBlobs)) {
			if (!seen.has(ref)) queue.push(ref)
		}
	}
	return seen
}

/** The OIDs to recurse into from `obj`; under `omitBlobs`, subtrees only. */
function childOids(obj: WalkObject, omitBlobs: boolean): string[] {
	if (omitBlobs && obj.type === "tree") {
		return treeEntries(obj.content)
			.filter((e) => isTreeEntryMode(e.mode))
			.map((e) => e.oid)
	}
	return referencedOids(obj.type, obj.content)
}

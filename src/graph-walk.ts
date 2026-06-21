import { type GitObjectType, referencedOids } from "@/object"

export type WalkObject = { type: GitObjectType; content: Buffer }
export type ObjectReader = (oid: string) => Promise<WalkObject>

/**
 * Enumerate every object reachable from `tips` (inclusive), following the OID
 * references each object declares. This is the fetch enumeration engine — the
 * server walks from the wanted tips to build the set of objects to pack. Net-new
 * server work, not an index lookup (spec §5).
 */
export async function graphWalk(
	tips: string[],
	read: ObjectReader,
): Promise<Set<string>> {
	const seen = new Set<string>()
	const queue = [...tips]
	while (queue.length > 0) {
		const oid = queue.pop()
		if (oid === undefined || seen.has(oid)) continue
		seen.add(oid)
		const obj = await read(oid)
		for (const ref of referencedOids(obj.type, obj.content)) {
			if (!seen.has(ref)) queue.push(ref)
		}
	}
	return seen
}

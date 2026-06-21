import { createHash } from "node:crypto"

/** The four addressable git object types (deltas resolve into one of these). */
export type GitObjectType = "blob" | "commit" | "tree" | "tag"

/**
 * The git object ID: SHA-1 of the loose-object representation
 * `"<type> <byteLength>\0" + content`. Returns the 40-char lowercase hex digest.
 */
export function computeOid(type: GitObjectType, content: Buffer): string {
	const header = Buffer.from(`${type} ${content.length}\0`, "latin1")
	return createHash("sha1").update(header).update(content).digest("hex")
}

/** OIDs in the leading `key <oid>` headers (up to the blank line) for given keys. */
function headerOids(content: Buffer, keys: Set<string>): string[] {
	const oids: string[] = []
	for (const line of content.toString("latin1").split("\n")) {
		if (line === "") break // headers end at the blank line
		const sp = line.indexOf(" ")
		if (sp > 0 && keys.has(line.slice(0, sp))) oids.push(line.slice(sp + 1))
	}
	return oids
}

/** OIDs of a tree's entries — `<mode> <name>\0<20-byte oid>` repeated. */
function treeEntryOids(content: Buffer): string[] {
	const oids: string[] = []
	let pos = 0
	while (pos < content.length) {
		const nul = content.indexOf(0x00, pos)
		if (nul < 0) break
		oids.push(content.subarray(nul + 1, nul + 21).toString("hex"))
		pos = nul + 21
	}
	return oids
}

/**
 * The OIDs an object directly references: a commit → its tree + parents, a tree
 * → its entries, a tag → its target, a blob → nothing. The basis of reachability
 * enumeration (fetch, connectivity).
 */
export function referencedOids(type: GitObjectType, content: Buffer): string[] {
	switch (type) {
		case "blob":
			return []
		case "commit":
			return headerOids(content, new Set(["tree", "parent"]))
		case "tag":
			return headerOids(content, new Set(["object"]))
		case "tree":
			return treeEntryOids(content)
	}
}

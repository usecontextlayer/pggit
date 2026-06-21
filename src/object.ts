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

export type TreeEntry = { mode: string; oid: string }

/** A tree's entries — `<mode> <name>\0<20-byte oid>` repeated — with modes. */
export function treeEntries(content: Buffer): TreeEntry[] {
	const entries: TreeEntry[] = []
	let pos = 0
	while (pos < content.length) {
		const space = content.indexOf(0x20, pos)
		const nul = content.indexOf(0x00, pos)
		if (space < 0 || nul < 0 || space > nul) break
		const mode = content.subarray(pos, space).toString("latin1")
		const oid = content.subarray(nul + 1, nul + 21).toString("hex")
		entries.push({ mode, oid })
		pos = nul + 21
	}
	return entries
}

/** A tree entry's mode marks a subtree (directory), not a blob or gitlink. */
export function isTreeEntryMode(mode: string): boolean {
	return mode === "40000"
}

/** OIDs of a tree's entries (all kinds), in tree order. */
function treeEntryOids(content: Buffer): string[] {
	return treeEntries(content).map((e) => e.oid)
}

/** A commit's parent OIDs only (ancestry walk; excludes its tree). */
export function commitParents(content: Buffer): string[] {
	return headerOids(content, new Set(["parent"]))
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

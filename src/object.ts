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

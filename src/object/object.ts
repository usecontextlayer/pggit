import { createHash } from "node:crypto"
import { GitFormatError } from "@/object/format-error"
import { type Oid, parseOid } from "@/object/oid"

/** The four addressable git object types (deltas resolve into one of these). */
export type GitObjectType = "blob" | "commit" | "tree" | "tag"

/**
 * The git object ID: SHA-1 of the loose-object representation
 * `"<type> <byteLength>\0" + content`. Returns the 40-char lowercase hex digest.
 */
export function computeOid(type: GitObjectType, content: Buffer): Oid {
	const header = Buffer.from(`${type} ${content.length}\0`, "latin1")
	return parseOid(createHash("sha1").update(header).update(content).digest("hex"))
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

/** One entry of a tree. `mode` is the raw stored value (`"40000"` for a subtree —
 * git zero-pads to `"040000"` only for display); `name` is the entry's own path
 * segment, not a full path. `nameBytes` is the segment's RAW bytes (a zero-copy
 * view into the tree body): ingest validation (design D16 — pggit paths are
 * UTF-8) must judge the bytes themselves, since `name`'s decode is lossy and a
 * literal U+FFFD in a valid name is indistinguishable from a replacement. */
export type TreeEntry = { mode: string; name: string; nameBytes: Buffer; oid: string }

/** A tree's entries — `<mode> <name>\0<20-byte oid>` repeated. */
export function treeEntries(content: Buffer): TreeEntry[] {
	const entries: TreeEntry[] = []
	let pos = 0
	while (pos < content.length) {
		const space = content.indexOf(0x20, pos)
		const nul = content.indexOf(0x00, pos)
		// Fail loud: a tree is `<mode> <name>\0<20-byte oid>` repeated exactly. Any
		// missing separator or a trailing OID shorter than 20 bytes is corruption —
		// throw rather than return a short list (which would let `isConnected` report
		// a truncated object as connected and silently accept bad data).
		if (space < 0 || nul < 0 || space > nul || nul + 21 > content.length) {
			throw new GitFormatError("malformed-tree", `tree: malformed entry at offset ${pos}`)
		}
		const mode = content.subarray(pos, space).toString("latin1")
		const nameBytes = content.subarray(space + 1, nul)
		const name = nameBytes.toString("utf8")
		const oid = content.subarray(nul + 1, nul + 21).toString("hex")
		entries.push({ mode, name, nameBytes, oid })
		pos = nul + 21
	}
	return entries
}

/** A tree entry's mode marks a subtree (directory), not a blob or gitlink. */
export function isTreeEntryMode(mode: string): boolean {
	return mode === "40000"
}

/** A tree entry pointing at a commit in *another* repo — nothing stored behind
 * it in THIS repo, so walks and projections skip it. */
export const GITLINK_MODE = "160000"

/** A commit's parent OIDs only (ancestry walk; excludes its tree). */
export function commitParents(content: Buffer): string[] {
	return headerOids(content, new Set(["parent"]))
}

/** A commit's root tree OID. Every commit has exactly one `tree` header. */
export function commitTreeOid(content: Buffer): string {
	const [tree] = headerOids(content, new Set(["tree"]))
	if (!tree) {
		throw new GitFormatError(
			"missing-tree-header",
			"commitTreeOid: commit has no tree header",
		)
	}
	return tree
}

/**
 * The committer's epoch seconds — `git_commit.commit_time`, the frontier's
 * tiebreak within and without generation regions. Headers end at
 * the first blank line; continuation lines (a `mergetag` payload) start with a
 * space and can never match. Loud on absence or a non-numeric epoch: the row
 * derivation IS the ingest-side validation of this header.
 */
export function commitCommitterTime(content: Buffer): number {
	for (const line of content.toString("latin1").split("\n")) {
		if (line === "") break
		if (!line.startsWith("committer ")) continue
		// `committer Name <email> <epoch> <tz>` — the epoch is the second-to-last token.
		const tokens = line.split(" ")
		const epoch = tokens[tokens.length - 2]
		if (epoch === undefined || !/^-?\d+$/.test(epoch)) {
			throw new GitFormatError(
				"malformed-committer-time",
				`commit committer header carries no epoch: ${line.slice(0, 80)}`,
			)
		}
		return Number.parseInt(epoch, 10)
	}
	throw new GitFormatError("missing-committer-header", "commit has no committer header")
}

/** The annotated tag's `type` header — its target's object type
 * (`git_tag.target_type`). Loud on absence or an unknown name, like the epoch
 * parse above: deriving the tag row is what validates the header. */
export function tagTargetType(content: Buffer): GitObjectType {
	for (const line of content.toString("latin1").split("\n")) {
		if (line === "") break
		if (!line.startsWith("type ")) continue
		const name = line.slice(5)
		if (name === "blob" || name === "commit" || name === "tag" || name === "tree") {
			return name
		}
		throw new GitFormatError(
			"unknown-tag-type",
			`tag type header names no git object type: ${name.slice(0, 40)}`,
		)
	}
	throw new GitFormatError("missing-tag-type", "annotated tag has no type header")
}

/** The annotated tag's target OID from its `object` header. */
export function tagTargetOid(content: Buffer): string {
	const [target] = headerOids(content, new Set(["object"]))
	if (target === undefined) {
		throw new GitFormatError("missing-tag-object", "annotated tag has no object header")
	}
	return target
}

import { GitFormatError } from "@/object/format-error"
import {
	commitParents,
	commitTreeOid,
	type GitObjectType,
	isTreeEntryMode,
	referencedOids,
	treeEntries,
} from "@/object/object"

/**
 * Edge kinds stored in `git_edge.kind`. tree→blob (would be `4`) is deliberately
 * NOT a kind: blobs are enumerated from tree content, never stored as edges (§4.3),
 * so `4` is reserved/unused.
 */
export const EDGE_KIND = {
	COMMIT_PARENT: 2,
	COMMIT_TREE: 1,
	TAG_TARGET: 5,
	TREE_SUBTREE: 3,
} as const

export type DerivedEdge = { child: string; kind: number }

/** A tree entry pointing at a commit in *another* repo — no blob, no edge here. */
const GITLINK_MODE = "160000"

const WELL_FORMED_OID = /^[0-9a-f]{40}$/

/**
 * Validate an OID parsed from a commit/tag header. `commitParents`/`commitTreeOid`/
 * `referencedOids` take whatever follows the header key verbatim — a forged object
 * could carry a non-OID there and yield a bogus edge child — so reject it loudly at
 * the ingest boundary (§5.1). Tree-entry OIDs are exempt: `treeEntries` already
 * guarantees a 20-byte value, and the `bytea CHECK(length(child)=20)` is the
 * database-level backstop for every edge.
 */
function assertOid(oid: string, context: string): string {
	if (!WELL_FORMED_OID.test(oid)) {
		throw new GitFormatError(
			"malformed-oid",
			`${context}: not a well-formed object id: ${JSON.stringify(oid)}`,
		)
	}
	return oid
}

/** Count the leading `key value` header lines (up to the blank line that ends a
 * commit/tag's header block). */
function countHeader(content: Buffer, key: string): number {
	const prefix = `${key} `
	let n = 0
	for (const line of content.toString("latin1").split("\n")) {
		if (line === "") break // headers end at the blank line
		if (line.startsWith(prefix)) n++
	}
	return n
}

/**
 * fsck-grade structural validation at the ingest boundary (§5.1, invariant §10.2):
 * reject the malformed objects that OID-wellformedness and tree parsing do not
 * catch. A commit must not carry more than one `tree` header (git fsck:
 * multipleTrees — `commitTreeOid` would otherwise silently take the first and drop
 * the rest, recording an edge to a tree the object does not actually root). An
 * annotated tag must carry exactly one `object` header (git fsck: missingObject /
 * an extra object line): zero yields no `kind=5` edge and silently breaks peeling
 * and connectivity; more than one yields multiple divergent `kind=5` edges and a
 * nondeterministic `peeled_oid`. The other structural guarantees are already
 * enforced downstream: `assertOid` on every referenced OID (below), a present root
 * `tree` (`commitTreeOid`, which also rejects a zero-tree commit), and a well-formed
 * tree body (`treeEntries` throws). Called by the store once per object before
 * derivation, in the ingest transaction, so a malformed push aborts before any row
 * lands.
 */
export function validateObject(type: GitObjectType, content: Buffer): void {
	if (type === "commit" && countHeader(content, "tree") > 1) {
		throw new GitFormatError(
			"multiple-tree-headers",
			"commit carries more than one tree header",
		)
	}
	if (type === "tag") {
		const objects = countHeader(content, "object")
		if (objects < 1) {
			throw new GitFormatError("missing-tag-object", "annotated tag has no object header")
		}
		if (objects > 1) {
			throw new GitFormatError(
				"multiple-tag-objects",
				"annotated tag carries more than one object header",
			)
		}
	}
}

/**
 * The edges an object contributes to `git_edge`, with the object's own OID as the
 * parent — the §4.3 standing rule, mode-aware:
 * - commit → its tree (kind 1) then each parent (kind 2);
 * - tree → its **subtrees only** (mode `40000` → kind 3). Blobs and gitlinks
 *   (`160000`, a commit living in another repo) are NOT edges — `isTreeEntryMode`
 *   admits only `40000`, so both are dropped;
 * - tag → its target (kind 5);
 * - blob → nothing.
 *
 * This is the single derivation the store inserts alongside the object row, in the
 * same transaction (§10.1), so edges are a validated total function of content.
 */
export function deriveEdges(type: GitObjectType, content: Buffer): DerivedEdge[] {
	switch (type) {
		case "blob":
			return []
		case "commit":
			return [
				{
					child: assertOid(commitTreeOid(content), "commit tree"),
					kind: EDGE_KIND.COMMIT_TREE,
				},
				...commitParents(content).map((p) => ({
					child: assertOid(p, "commit parent"),
					kind: EDGE_KIND.COMMIT_PARENT,
				})),
			]
		case "tag":
			return referencedOids("tag", content).map((t) => ({
				child: assertOid(t, "tag target"),
				kind: EDGE_KIND.TAG_TARGET,
			}))
		case "tree":
			return treeEntries(content)
				.filter((e) => isTreeEntryMode(e.mode))
				.map((e) => ({ child: e.oid, kind: EDGE_KIND.TREE_SUBTREE }))
	}
}

/**
 * The blob OIDs directly in a tree — the §4.3 standing rule's other half: blobs
 * are enumerated from tree content, never stored as edges. A tree entry is a blob
 * unless it is a subtree (`deriveEdges` covers those as kind-3 edges) or a gitlink
 * (`160000`, a submodule commit living in another repo — neither blob nor edge).
 * Connectivity uses this to find the blobs a present tree requires, since no
 * tree→blob edge exists to anchor a missing one.
 */
export function treeBlobOids(content: Buffer): string[] {
	return treeEntries(content)
		.filter((e) => !isTreeEntryMode(e.mode) && e.mode !== GITLINK_MODE)
		.map((e) => e.oid)
}

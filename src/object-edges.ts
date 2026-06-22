import { GitFormatError } from "@/git-format-error"
import {
	commitParents,
	commitTreeOid,
	type GitObjectType,
	isTreeEntryMode,
	referencedOids,
	treeEntries,
} from "@/object"

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

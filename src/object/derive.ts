import { GitFormatError } from "@/object/format-error"
import {
	commitCommitterTime,
	commitParents,
	commitTreeOid,
	type GitObjectType,
	referencedOids,
	tagTargetType,
	treeEntries,
} from "@/object/object"
import { isOid } from "@/oid"

/**
 * Ingest-boundary validation and row derivation — the single place a pushed
 * object's content becomes queryable state. `validateObject` is pggit's fsck;
 * `deriveCommitRow`/`deriveTagRow` parse the content into the derived
 * `git_commit`/`git_tag` rows (spine chunk 1). Both run inside the ingest
 * transaction, so a malformed object aborts the push before any row lands, and
 * deriving a row IS the validation of the headers it reads.
 */

/** The canonical tree-entry modes git's writers emit (100664 is the legacy
 * group-writable blob some old repos carry; fsck accepts it). Everything else
 * is rejected at ingest — see the mode check in `validateObject`. */
const TREE_ENTRY_MODES = new Set([
	"40000",
	"100644",
	"100755",
	"100664",
	"120000",
	"160000",
])

/** Strict decoder for tree-entry names: `fatal: true` throws on invalid UTF-8
 * instead of substituting U+FFFD (see the D16 note in `validateObject`). */
const UTF8_STRICT = new TextDecoder("utf8", { fatal: true })

/**
 * Validate an OID parsed from a commit/tag header. `commitParents`/`commitTreeOid`/
 * `referencedOids` take whatever follows the header key verbatim — a forged object
 * could carry a non-OID there and yield a bogus row value — so reject it loudly at
 * the ingest boundary (§5.1). Tree-entry OIDs are exempt: `treeEntries` already
 * guarantees a 20-byte value, and the schema's `length(…) = 20` CHECKs are the
 * database-level backstop.
 */
function assertOid(oid: string, context: string): string {
	if (!isOid(oid)) {
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
 * catch — plus pggit's own D16 rule that tree-entry names are valid UTF-8 (which
 * canonical fsck does not require; see the branch below for why). A tree is
 * parsed here for that check, so `malformed-tree` also surfaces from this call
 * for tree objects. A commit must not carry more than one `tree` header (git fsck:
 * multipleTrees — `commitTreeOid` would otherwise silently take the first and drop
 * the rest, deriving a root the object does not actually have). An annotated tag
 * must carry exactly one `object` header (git fsck: missingObject / an extra
 * object line): zero leaves nothing to derive a `git_tag` row from and silently
 * breaks peeling and connectivity; more than one makes the derived target — and
 * with it `peeled_oid` — nondeterministic. The other structural guarantees are
 * already enforced downstream: `assertOid` on every referenced OID (below), a
 * present root `tree` (`commitTreeOid`, which also rejects a zero-tree commit),
 * and a well-formed tree body (`treeEntries` throws). Called by the store once
 * per object before derivation, in the ingest transaction, so a malformed push
 * aborts before any row lands.
 */
export function validateObject(type: GitObjectType, content: Buffer): void {
	if (type === "tree") {
		// D16: pggit paths are UTF-8, judged on the entry's RAW bytes at ingest —
		// a deliberate divergence from git's bytes-are-bytes paths. Decoded lossily,
		// a non-UTF-8 name becomes U+FFFD in the `repo_file path text` projection,
		// where two byte-distinct names can collapse onto one row and the second is
		// SILENTLY dropped from the published read surface. Rejecting the push here
		// (the same unpack-fails channel as any malformed object) makes the
		// projection exact instead. Stored pre-enforcement data is untouched: serve
		// paths never run this, and objects remain byte-faithful bytea.
		for (const e of treeEntries(content)) {
			try {
				UTF8_STRICT.decode(e.nameBytes)
			} catch {
				throw new GitFormatError(
					"non-utf8-path",
					`tree entry name is not valid UTF-8 (pggit paths are UTF-8): 0x${e.nameBytes.subarray(0, 48).toString("hex")}`,
				)
			}
			// The walks type entries by RAW mode ("40000" ⇒ subtree, else blob-ish),
			// so a noncanonical mode — zero-padded "040000", or garbage — would make
			// connectivity and fetch UNDER-WALK: the subtree gets treated as a blob,
			// its descendants never verified nor served. Canonical git tolerates
			// zero-padding with an fsck warning; pggit's derived state cannot, so
			// this rejects at the same unpack-fails boundary as every malformed
			// object (git's own canonical writers never emit these).
			if (!TREE_ENTRY_MODES.has(e.mode)) {
				throw new GitFormatError(
					"malformed-tree-mode",
					`tree entry "${e.name}" carries noncanonical mode "${e.mode}"`,
				)
			}
		}
	}
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

/** The `git_commit` row derived from a commit's content (spine chunk 1). The
 * ordered `parents` list is the point: parent ORDER lives only in commit
 * content, and this row is where it becomes queryable. `generation` is
 * deliberately NOT here: it depends on the parents' rows, so the store computes
 * it in the ingest batch's one topological pass (`computeGenerations`), never
 * per object. */
export type DerivedCommit = { commitTime: number; parents: string[]; treeOid: string }

/** Parse a commit body into its `git_commit` row values. Loud on any malformed
 * header (same ingest-aborting channel as `validateObject`). */
export function deriveCommitRow(content: Buffer): DerivedCommit {
	return {
		commitTime: commitCommitterTime(content),
		parents: commitParents(content).map((p) => assertOid(p, "commit parent")),
		treeOid: assertOid(commitTreeOid(content), "commit tree"),
	}
}

/** The `git_tag` row derived from an annotated tag's content (spine chunk 1).
 * `targetType` stays the domain NAME here; the store serializes it to the stored
 * code at its own boundary. */
export type DerivedTag = { targetOid: string; targetType: GitObjectType }

/** Parse a tag body into its `git_tag` row values. Loud on a missing target or
 * type header — deriving the row IS the validation of those headers. */
export function deriveTagRow(content: Buffer): DerivedTag {
	const target = referencedOids("tag", content)[0]
	if (target === undefined) {
		throw new GitFormatError("missing-tag-object", "annotated tag has no object header")
	}
	return {
		targetOid: assertOid(target, "tag target"),
		targetType: tagTargetType(content),
	}
}

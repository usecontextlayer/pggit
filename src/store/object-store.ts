import { createHash } from "node:crypto"
import { sql } from "kysely"
import type { Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import { type CopyValue, copyInsert } from "@/database/copy-insert"
import type { ReposId } from "@/database/models/public/Repos"
import { count, withPhase } from "@/instrument"
import { deriveEdges, EDGE_KIND, validateObject } from "@/object/edges"
import { computeOid, type GitObjectType } from "@/object/object"
import { PACK_OBJ_TYPE } from "@/pack/object-header"
import { readPack } from "@/pack/read-pack"
import {
	type PackInputObject,
	packHeader,
	packObject,
	writePack,
} from "@/pack/write-pack"
import { WantNotFoundError } from "@/protocol/errors"
import { ancestryReachesCommon, reachableClosure } from "@/store/reachability"
import { createRepoResolver } from "@/store/repo-resolver"

/** Objects fetched per round-trip when streaming content into a served pack. */
const PACK_BATCH = 1000

/**
 * A stored object at/over this size is read in size-bounded chunks, never in one
 * round-trip. The porsager driver decodes a `bytea` RESULT from its text form
 * (`\x` + hex, DOUBLE the byte length), so a value over ~256MiB would build a JS
 * string past V8's max length and throw on the SERVE path — the read-side mirror of
 * the ingest string-cap that binary COPY fixed (a07/blb01). Kept well under the cap
 * so the doubled hex of a single chunk stays safely below it.
 */
const BIG_OBJECT_BYTES = 200_000_000
const READ_CHUNK_BYTES = 100_000_000

/** Split `items` into consecutive batches of at most `size`. */
function batches<T>(items: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
	return out
}

export type StoredObject = {
	type: GitObjectType
	content: Buffer
}

export type ObjectStore = ReturnType<typeof createObjectStore>

// `git_object.type` stores the pack object-type code (1 commit, 2 tree, 3 blob,
// 4 tag) — so it maps straight to the pack header on serve. Mirrors the codec's
// own private map (write-pack.ts), referencing the same constants; the codec
// stays storage-independent and untouched.
const TYPE_TO_CODE: Record<GitObjectType, number> = {
	blob: PACK_OBJ_TYPE.BLOB,
	commit: PACK_OBJ_TYPE.COMMIT,
	tag: PACK_OBJ_TYPE.TAG,
	tree: PACK_OBJ_TYPE.TREE,
}

const CODE_TO_TYPE = new Map<number, GitObjectType>([
	[PACK_OBJ_TYPE.BLOB, "blob"],
	[PACK_OBJ_TYPE.COMMIT, "commit"],
	[PACK_OBJ_TYPE.TAG, "tag"],
	[PACK_OBJ_TYPE.TREE, "tree"],
])

function typeFromCode(code: number): GitObjectType {
	const type = CODE_TO_TYPE.get(code)
	if (!type) throw new Error(`object-store: unknown git object type code ${code}`)
	return type
}

/**
 * Postgres-backed git object store. Each immutable object is one row in the
 * per-repo, HASH-partitioned `git_object` (raw 20-byte `bytea` OID, pack type
 * code, raw inflated body lz4-TOASTed Postgres-side) — packs are a transport
 * encoding produced on serve and consumed on ingest, never stored. So a fetch is
 * a primary-key point-read, not a whole-pack re-inflate.
 *
 * The store is the wire→DB boundary: callers speak hex OIDs and the wire repo
 * name; OIDs are coerced hex↔raw here, and the repo name is resolved to its
 * bigint surrogate (memoized) here.
 */
export function createObjectStore(pg: Sql) {
	const db = initKysely<Database>(pg)
	const repos = createRepoResolver(db)

	const store = {
		/**
		 * Build the served pack for a fetch: the want-closure minus the have-closure,
		 * re-adding the explicit wants (promisor lazy-fetch roots — a partial clone may
		 * want a blob reachable from a tree it already has, so it must not be
		 * subtracted). The object count is known from the closure before any content is
		 * read; content then streams in keyset batches into the pack encoder, so only
		 * one batch of inflated content is ever held (never the whole repo).
		 */
		async buildPack(
			repoId: string,
			wants: string[],
			haves: string[],
			omitBlobs: boolean,
			includeTag = false,
		): Promise<Buffer> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null || wants.length === 0) return writePack([])

			const served = await withPhase("closure", async () => {
				const want = await reachableClosure(db, id, wants, omitBlobs)
				// A want whose closure is incomplete cannot be served (git rejects it
				// too) — fail loud rather than ship a short pack. The have side may be
				// incomplete (we just don't subtract what we lack), so only wants matter.
				if (want.missing.size > 0) {
					throw new WantNotFoundError([...want.missing])
				}
				const have =
					haves.length > 0
						? await reachableClosure(db, id, haves, omitBlobs)
						: { missing: new Set<string>(), present: new Set<string>() }
				const set = new Set<string>()
				for (const o of want.present) if (!have.present.has(o)) set.add(o)
				// Under a blobless/partial filter the client may explicitly want an object
				// reachable from a `have` whose closure it does NOT fully possess (a promisor
				// root the omitBlobs subtraction drops), so re-add those wants. On an unfiltered
				// fetch a `have` implies its whole closure — a want already in it is genuinely
				// owned, so re-adding would re-send what the client has (a non-minimal pack).
				if (omitBlobs) for (const w of wants) if (want.present.has(w)) set.add(w)
				if (includeTag) await augmentWithTags(id, set)
				return [...set]
			})

			return withPhase("pack-encode", async () => {
				const hash = createHash("sha1")
				const parts: Buffer[] = []
				const push = (chunk: Buffer) => {
					hash.update(chunk)
					parts.push(chunk)
				}
				push(packHeader(served.length))
				for (const batch of batches(served, PACK_BATCH)) {
					const rows = await db
						.selectFrom("git_object")
						.select(["oid", "type"])
						// Keep a >256MiB blob's content server-side (CASE → NULL on the wire) so the
						// porsager driver never builds its over-cap `\x`+hex string; oversized rows
						// (content NULL here) are read in size-bounded chunks below.
						.select(sql<number>`octet_length(content)`.as("size"))
						.select(
							sql<Buffer | null>`case when octet_length(content) < ${BIG_OBJECT_BYTES} then content end`.as(
								"content",
							),
						)
						.where("repo_id", "=", id)
						.where(
							"oid",
							"in",
							batch.map((h) => Buffer.from(h, "hex")),
						)
						.execute()
					for (const r of rows) {
						const content = r.content ?? (await readContentChunked(id, r.oid, r.size))
						push(packObject(typeFromCode(r.type), content))
					}
				}
				const pack = Buffer.concat([...parts, hash.digest()])
				count("objectsServed", served.length)
				count("packBytes", pack.length)
				return pack
			})
		},

		/** The subset of `haves` this repo actually has — the negotiation common set,
		 * in one indexed lookup rather than a per-have probe. */
		async commonHaves(repoId: string, haves: string[]): Promise<string[]> {
			if (haves.length === 0) return []
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return []
			const rows = await db
				.selectFrom("git_object")
				.select("oid")
				.where("repo_id", "=", id)
				.where(
					"oid",
					"in",
					haves.map((h) => Buffer.from(h, "hex")),
				)
				.execute()
			// Preserve the client's `have` order (the ACK lines echo it) — the `in`
			// query returns rows in arbitrary order.
			const present = new Set(rows.map((r) => r.oid.toString("hex")))
			return haves.filter((h) => present.has(h))
		},
		async getObject(repoId: string, oid: string): Promise<StoredObject | null> {
			count("getObjectCalls")
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return null

			const row = await db
				.selectFrom("git_object")
				.select(["type"])
				.select(sql<number>`octet_length(content)`.as("size"))
				.select(
					sql<Buffer | null>`case when octet_length(content) < ${BIG_OBJECT_BYTES} then content end`.as(
						"content",
					),
				)
				.where("repo_id", "=", id)
				.where("oid", "=", Buffer.from(oid, "hex"))
				.executeTakeFirst()
			if (!row) return null

			// A >256MiB object comes back with content NULL (the CASE guard); read it chunked
			// so its bytes never transit the porsager driver as one over-cap hex string.
			const content =
				row.content ?? (await readContentChunked(id, Buffer.from(oid, "hex"), row.size))
			count("objectBytesRead", content.length)
			return { content, type: typeFromCode(row.type) }
		},

		async hasObject(repoId: string, oid: string): Promise<boolean> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return false
			const row = await db
				.selectFrom("git_object")
				.select("oid")
				.where("repo_id", "=", id)
				.where("oid", "=", Buffer.from(oid, "hex"))
				.executeTakeFirst()
			return row !== undefined
		},

		/**
		 * Ingest a received pack: parse it — resolving in-pack deltas, and thin-pack
		 * REF_DELTA bases against objects already in this repo — then insert every
		 * resolved object as a row.
		 */
		async ingestPack(repoId: string, packBytes: Buffer): Promise<{ oids: string[] }> {
			const id = await repos.ensureRepoId(repoId)
			const parsed = await readPack(packBytes, (oid) => store.getObject(repoId, oid))
			const oids = await insertObjects(
				id,
				parsed.map((p) => ({ content: p.content, type: p.type })),
			)
			return { oids }
		},

		/**
		 * Connectivity check (spec §5.2): is every object reachable from `oid` present?
		 * A push whose new tip fails this references an object the pack neither carried
		 * nor delta-resolved, and must be rejected. Delegates to the one reachability
		 * engine (`reachableClosure`) shared with clone/fetch, so connectivity and
		 * serving can never disagree on what is reachable. Full-closure (matching the
		 * old walk's scope); the bounded "new objects only" form is a deferred
		 * optimization (OQ-14).
		 */
		async isConnected(repoId: string, oid: string): Promise<boolean> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return false
			const { missing } = await reachableClosure(db, id, [oid], false)
			return missing.size === 0
		},

		/** Seed objects directly (the differential harness + perf bench path): insert
		 * each as a row, idempotently. Equivalent to `ingestPack` minus the pack codec. */
		async putPack(
			repoId: string,
			objects: PackInputObject[],
		): Promise<{ oids: string[] }> {
			const id = await repos.ensureRepoId(repoId)
			const oids = await insertObjects(id, objects)
			return { oids }
		},

		/**
		 * git's `ok_to_give_up`: ready once every want reaches a common have by commit/
		 * tag ancestry (the haves form a cut below all wants, so the delta is well-
		 * defined). One ancestry CTE (edge kinds 2,5) per want replaces `reachesCommon`'s
		 * per-object BFS. Generation-number pruning is a deferred §6.4 lever.
		 */
		async readyToGiveUp(
			repoId: string,
			wants: string[],
			common: string[],
		): Promise<boolean> {
			if (common.length === 0) return false
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return false
			const commonBufs = common.map((h) => Buffer.from(h, "hex"))
			for (const want of wants) {
				if (!(await ancestryReachesCommon(db, id, want, commonBufs))) return false
			}
			return true
		},
	}

	/** Insert objects as rows + their derived edges, idempotent (re-sent objects are
	 * skipped). Each object row and its complete edge set go in ONE transaction from
	 * ONE derivation (§10.1) — so no object ever exists without its edges. Edge
	 * derivation validates at the boundary and throws on malformed content (§5.1),
	 * aborting the ingest before any row lands. Returns every object's hex OID, in
	 * input order. */
	async function insertObjects(
		id: Awaited<ReturnType<typeof repos.ensureRepoId>>,
		objects: PackInputObject[],
	): Promise<string[]> {
		const entries = objects.map((obj) => {
			validateObject(obj.type, obj.content)
			const hex = computeOid(obj.type, obj.content)
			const oid = Buffer.from(hex, "hex")
			return {
				edges: deriveEdges(obj.type, obj.content).map((e) => ({
					child: Buffer.from(e.child, "hex"),
					kind: e.kind,
					parent: oid,
					repo_id: id,
				})),
				hex,
				row: {
					content: obj.content,
					oid,
					repo_id: id,
					size: obj.content.length,
					type: TYPE_TO_CODE[obj.type],
				},
			}
		})
		if (entries.length === 0) return []

		const objectRows: CopyValue[][] = entries.map((e) => [
			{ t: "int8", v: e.row.repo_id },
			{ t: "bytea", v: e.row.oid },
			{ t: "int2", v: e.row.type },
			{ t: "int4", v: e.row.size },
			{ t: "bytea", v: e.row.content },
		])
		const edgeRows: CopyValue[][] = entries.flatMap((e) =>
			e.edges.map((edge): CopyValue[] => [
				{ t: "int8", v: edge.repo_id },
				{ t: "bytea", v: edge.parent },
				{ t: "bytea", v: edge.child },
				{ t: "int2", v: edge.kind },
			]),
		)
		// One transaction (the object⟺edges invariant, §10.1) via COPY into staging:
		// no bind-parameter ceiling and content streams as raw bytes (see copyInsert),
		// so neither object count nor blob size has a hard wall. Empty edgeRows (an
		// all-blob push) is a no-op, never an empty insert.
		await pg.begin(async (tx) => {
			await copyInsert(
				tx,
				"git_object",
				["repo_id", "oid", "type", "size", "content"],
				objectRows,
			)
			await copyInsert(tx, "git_edge", ["repo_id", "parent", "child", "kind"], edgeRows)
			// Stamp the repo's GC-activity watermark in the SAME transaction as the
			// ingest: these objects are reclaim candidates (a force-commit orphans the
			// prior snapshot the instant the ref moves), so the self-scheduling drain must
			// judge this repo eligible (gc-scheduler.ts §2). A tiny single-row HOT update
			// on the churn-tuned `repos` (0004) — reached only on a non-empty ingest (the
			// empty case returned above).
			await tx`update repos set last_pushed_at = clock_timestamp() where id = ${id}::bigint`
		})
		return entries.map((e) => e.hex)
	}

	/**
	 * Read a single object's `content` in size-bounded chunks via `substring`, so a
	 * blob larger than V8's max string length never reaches the porsager driver as one
	 * over-cap `\x`+hex string — the serve-side mirror of the binary COPY ingest. Used
	 * only for objects at/over BIG_OBJECT_BYTES (smaller content comes back inline).
	 */
	async function readContentChunked(
		id: ReposId,
		oid: Buffer,
		size: number,
	): Promise<Buffer> {
		const parts: Buffer[] = []
		for (let off = 0; off < size; off += READ_CHUNK_BYTES) {
			const len = Math.min(READ_CHUNK_BYTES, size - off)
			const row = await db
				.selectFrom("git_object")
				.select(sql<Buffer>`substring(content from ${off + 1} for ${len})`.as("chunk"))
				.where("repo_id", "=", id)
				.where("oid", "=", oid)
				.executeTakeFirstOrThrow()
			parts.push(row.chunk)
		}
		return Buffer.concat(parts)
	}

	/**
	 * include-tag augmentation (§6.5): annotated tags whose peeled target is in the
	 * served set get their tag OBJECTS added — transitively over `kind=5`, so a
	 * tag-of-tag chain ships every tag object in it (each must be present for the
	 * client's fsck). Annotated tags are few, so we fetch them all and filter by
	 * served membership app-side rather than feeding the whole served set into SQL.
	 * Mutates `served`. Peeled targets are already in `served` (they qualified the
	 * tag), so re-adding the chain's terminal commit is a no-op.
	 */
	async function augmentWithTags(id: ReposId, served: Set<string>): Promise<void> {
		const tagRefs = await db
			.selectFrom("git_ref")
			.select(["oid", "peeled_oid"])
			.where("repo_id", "=", id)
			.where("oid", "is not", null)
			.where("peeled_oid", "is not", null)
			.execute()
		const qualifying = tagRefs
			.filter((r) => r.peeled_oid !== null && served.has(r.peeled_oid.toString("hex")))
			.map((r) => (r.oid as Buffer).toString("hex"))
		if (qualifying.length === 0) return

		const seed = sql.join(qualifying.map((r) => sql`(${Buffer.from(r, "hex")}::bytea)`))
		const chain = await sql<{ oid: Buffer }>`
			with recursive tags(oid) as (
				select oid from (values ${seed}) as roots(oid)
				union
				select e.child from git_edge e
					join tags t on e.parent = t.oid
					where e.repo_id = ${id}::bigint and e.kind = ${EDGE_KIND.TAG_TARGET}
			)
			select oid from tags
		`.execute(db)
		for (const r of chain.rows) served.add(r.oid.toString("hex"))
	}

	return store
}

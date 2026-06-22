import { createHash } from "node:crypto"
import { type Kysely, sql } from "kysely"
import type { Database } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"
import { count, withPhase } from "@/instrument"
import { computeOid, type GitObjectType } from "@/object"
import { deriveEdges, EDGE_KIND, treeBlobOids } from "@/object-edges"
import { PACK_OBJ_TYPE } from "@/pack/object-header"
import { readPack } from "@/pack/read-pack"
import {
	type PackInputObject,
	packHeader,
	packObject,
	writePack,
} from "@/pack/write-pack"
import { createRepoResolver } from "@/repo-store"

/** Objects fetched per round-trip when streaming content into a served pack. */
const PACK_BATCH = 1000

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
export function createObjectStore(db: Kysely<Database>) {
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
		): Promise<Buffer> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null || wants.length === 0) return writePack([])

			const served = await withPhase("closure", async () => {
				const want = await reachableClosure(id, wants, omitBlobs)
				// A want whose closure is incomplete cannot be served (git rejects it
				// too) — fail loud rather than ship a short pack. The have side may be
				// incomplete (we just don't subtract what we lack), so only wants matter.
				if (want.missing.size > 0) {
					throw new Error(
						`upload-pack: wanted objects missing from store: ${[...want.missing].join(", ")}`,
					)
				}
				const have =
					haves.length > 0
						? await reachableClosure(id, haves, omitBlobs)
						: { missing: new Set<string>(), present: new Set<string>() }
				const set = new Set<string>()
				for (const o of want.present) if (!have.present.has(o)) set.add(o)
				for (const w of wants) if (want.present.has(w)) set.add(w)
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
						.select(["type", "content"])
						.where("repo_id", "=", id)
						.where(
							"oid",
							"in",
							batch.map((h) => Buffer.from(h, "hex")),
						)
						.execute()
					for (const r of rows) push(packObject(typeFromCode(r.type), r.content))
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
				.select(["type", "content"])
				.where("repo_id", "=", id)
				.where("oid", "=", Buffer.from(oid, "hex"))
				.executeTakeFirst()
			if (!row) return null

			count("objectBytesRead", row.content.length)
			return { content: row.content, type: typeFromCode(row.type) }
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
			const { missing } = await reachableClosure(id, [oid], false)
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
				if (!(await ancestryReachesCommon(id, want, commonBufs))) return false
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

		const objectRows = entries.map((e) => e.row)
		const edgeRows = entries.flatMap((e) => e.edges)
		await db.transaction().execute(async (trx) => {
			await trx
				.insertInto("git_object")
				.values(objectRows)
				.onConflict((oc) => oc.doNothing())
				.execute()
			if (edgeRows.length > 0) {
				await trx
					.insertInto("git_edge")
					.values(edgeRows)
					.onConflict((oc) => oc.doNothing())
					.execute()
			}
		})
		return entries.map((e) => e.hex)
	}

	/**
	 * The objects reachable from `roots` over the stored DAG — the ONE reachability
	 * engine shared by connectivity, clone, and incremental fetch (so they can never
	 * disagree). A recursive CTE walks `git_edge` (all stored kinds 1,2,3,5) for the
	 * commit/tree/tag closure; the LEFT JOIN marks which are present. Blobs are not
	 * edges (§4.3), so unless `omitBlobs` they are enumerated from each present tree's
	 * content (mode-aware) and their presence checked. Returns the reachable set
	 * partitioned into present / missing. `::bigint`/`::bytea` casts and the
	 * `VALUES (…::bytea)` seed pin types in the raw CTE (the porsager driver can't
	 * bind a raw `bytea[]`, OQ-13); array lookups use Kysely's `in`-expansion.
	 */
	async function reachableClosure(
		id: ReposId,
		roots: string[],
		omitBlobs: boolean,
	): Promise<{ present: Set<string>; missing: Set<string> }> {
		const present = new Set<string>()
		const missing = new Set<string>()
		if (roots.length === 0) return { missing, present }

		const seed = sql.join(roots.map((r) => sql`(${Buffer.from(r, "hex")}::bytea)`))
		const closure = await sql<{ oid: Buffer; type: number | null }>`
			with recursive closure(oid) as (
				select oid from (values ${seed}) as roots(oid)
				union
				select e.child from git_edge e
					join closure c on e.parent = c.oid
					where e.repo_id = ${id}::bigint
			)
			select c.oid, o.type
			from closure c
			left join git_object o on o.repo_id = ${id}::bigint and o.oid = c.oid
		`.execute(db)

		const treeOids: Buffer[] = []
		for (const r of closure.rows) {
			const hex = r.oid.toString("hex")
			if (r.type === null) {
				missing.add(hex)
			} else {
				present.add(hex)
				if (r.type === PACK_OBJ_TYPE.TREE) treeOids.push(r.oid)
			}
		}
		if (omitBlobs || treeOids.length === 0) return { missing, present }

		const blobCandidates = new Set<string>()
		for (const batch of batches(treeOids, PACK_BATCH)) {
			const trees = await db
				.selectFrom("git_object")
				.select("content")
				.where("repo_id", "=", id)
				.where("oid", "in", batch)
				.execute()
			for (const t of trees) {
				for (const blob of treeBlobOids(t.content)) blobCandidates.add(blob)
			}
		}
		if (blobCandidates.size === 0) return { missing, present }

		const presentBlobs = new Set<string>()
		for (const batch of batches([...blobCandidates], PACK_BATCH)) {
			const rows = await db
				.selectFrom("git_object")
				.select("oid")
				.where("repo_id", "=", id)
				.where(
					"oid",
					"in",
					batch.map((h) => Buffer.from(h, "hex")),
				)
				.execute()
			for (const r of rows) presentBlobs.add(r.oid.toString("hex"))
		}
		for (const b of blobCandidates) (presentBlobs.has(b) ? present : missing).add(b)
		return { missing, present }
	}

	/** Does `want`'s commit/tag ancestry (edge kinds 2,5) reach any oid in `common`?
	 * The ancestry-only CTE that underpins `readyToGiveUp`. */
	async function ancestryReachesCommon(
		id: ReposId,
		want: string,
		commonBufs: Buffer[],
	): Promise<boolean> {
		if (commonBufs.length === 0) return false
		const commons = sql.join(commonBufs.map((b) => sql`(${b}::bytea)`))
		const result = await sql<{ reached: boolean }>`
			with recursive anc(oid) as (
				select ${Buffer.from(want, "hex")}::bytea
				union
				select e.child from git_edge e
					join anc a on e.parent = a.oid
					where e.repo_id = ${id}::bigint
						and e.kind in (${EDGE_KIND.COMMIT_PARENT}, ${EDGE_KIND.TAG_TARGET})
			)
			select exists (
				select 1 from anc join (values ${commons}) as c(oid) on c.oid = anc.oid
			) as reached
		`.execute(db)
		return result.rows[0]?.reached ?? false
	}

	return store
}

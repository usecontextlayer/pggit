import { type Kysely, sql } from "kysely"
import type { Database } from "@/database"
import { count } from "@/instrument"
import { computeOid, type GitObjectType } from "@/object"
import { deriveEdges, treeBlobOids } from "@/object-edges"
import { PACK_OBJ_TYPE } from "@/pack/object-header"
import { readPack } from "@/pack/read-pack"
import type { PackInputObject } from "@/pack/write-pack"
import { createRepoResolver } from "@/repo-store"

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
		 * Connectivity check (spec §5.2): is every object reachable from `oid` present
		 * in this repo? A push whose new tip fails this references an object the pack
		 * neither carried nor delta-resolved, and must be rejected. Three bounded
		 * queries replace the old O(N) app-side walk:
		 *
		 * 1. A recursive CTE walks `git_edge` (kinds 1,2,3,5) for the closure of
		 *    commits/trees/tags reachable from the tip; the LEFT JOIN reveals which are
		 *    present + their type (selecting `type` never detoasts content). Any absent
		 *    closure member ⇒ disconnected.
		 * 2. Blobs are NOT edges (§4.3), so they cannot be found by the CTE — enumerate
		 *    them from each present tree's content, mode-aware (skipping gitlinks).
		 * 3. Anti-join those blobs against `git_object`; any absent ⇒ disconnected.
		 *
		 * Full-closure (re-verifies all reachable history each push, matching the old
		 * walk's scope); the bounded "new objects only" form is a deferred optimization
		 * (OQ-14). `::bigint`/`::bytea` casts pin types in the raw CTE where Kysely's
		 * column knowledge doesn't apply.
		 */
		async isConnected(repoId: string, oid: string): Promise<boolean> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return false
			const tip = Buffer.from(oid, "hex")

			const closure = await sql<{ oid: Buffer; type: number | null }>`
				with recursive closure(oid) as (
					select ${tip}::bytea
					union
					select e.child from git_edge e
						join closure c on e.parent = c.oid
						where e.repo_id = ${id}::bigint
				)
				select c.oid, o.type
				from closure c
				left join git_object o on o.repo_id = ${id}::bigint and o.oid = c.oid
			`.execute(db)
			if (closure.rows.some((r) => r.type === null)) return false

			const treeOids = closure.rows
				.filter((r) => r.type === PACK_OBJ_TYPE.TREE)
				.map((r) => r.oid)
			if (treeOids.length === 0) return true

			// Kysely's `in` expands the bytea array into individual params (the porsager
			// driver can't bind a raw `bytea[]`); the same applies to the blob check.
			const trees = await db
				.selectFrom("git_object")
				.select("content")
				.where("repo_id", "=", id)
				.where("oid", "in", treeOids)
				.execute()
			const blobOids = new Set<string>()
			for (const t of trees) {
				for (const blob of treeBlobOids(t.content)) blobOids.add(blob)
			}
			if (blobOids.size === 0) return true

			const blobBufs = [...blobOids].map((hex) => Buffer.from(hex, "hex"))
			const present = await db
				.selectFrom("git_object")
				.select("oid")
				.where("repo_id", "=", id)
				.where("oid", "in", blobBufs)
				.execute()
			// PK uniqueness ⇒ a present blob matches exactly one row; all present iff the
			// counts agree.
			return present.length === blobOids.size
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

	return store
}

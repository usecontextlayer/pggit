import { type Kysely, sql } from "kysely"
import type { Database } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"
import { EDGE_KIND, treeBlobOids } from "@/object/edges"
import { PACK_OBJ_TYPE } from "@/pack/object-header"

/** Objects looked up per round-trip when chunking tree/blob existence queries. */
const LOOKUP_BATCH = 1000

/** Split `items` into consecutive batches of at most `size`. */
function batches<T>(items: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
	return out
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
export async function reachableClosure(
	db: Kysely<Database>,
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
	for (const batch of batches(treeOids, LOOKUP_BATCH)) {
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
	for (const batch of batches([...blobCandidates], LOOKUP_BATCH)) {
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
export async function ancestryReachesCommon(
	db: Kysely<Database>,
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

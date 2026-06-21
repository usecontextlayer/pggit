import type { Kysely } from "kysely"
import type { Database } from "@/database"
import type { ObjectsOid, ObjectsRepoId } from "@/database/models/public/Objects"
import { computeOid, type GitObjectType } from "@/object"
import { readPack } from "@/pack/read-pack"
import { type PackInputObject, writePack } from "@/pack/write-pack"

export type StoredObject = {
	type: GitObjectType
	content: Buffer
}

export type ObjectStore = ReturnType<typeof createObjectStore>

/**
 * Postgres-backed git object store (JGit DFS lineage). Objects live inside
 * self-contained, undeltified packs; the `objects` index maps each OID to its
 * pack so `has`/type lookups never touch pack bytes. `getObject` currently reads
 * the whole pack — offset-targeted reads are a later optimization.
 *
 * The store is the wire→DB boundary: callers speak plain hex strings, so repo
 * ids and OIDs are cast to their generated branded column types here.
 */
export function createObjectStore(db: Kysely<Database>) {
	return {
		async getObject(repoId: string, oid: string): Promise<StoredObject | null> {
			const objRow = await db
				.selectFrom("objects")
				.select("pack_id")
				.where("repo_id", "=", repoId as ObjectsRepoId)
				.where("oid", "=", oid as ObjectsOid)
				.executeTakeFirst()
			if (!objRow) return null

			const packRow = await db
				.selectFrom("packs")
				.select("bytes")
				.where("id", "=", objRow.pack_id)
				.executeTakeFirst()
			if (!packRow) throw new Error(`object-store: pack ${objRow.pack_id} missing`)

			const found = (await readPack(packRow.bytes)).find((p) => p.oid === oid)
			return found ? { content: found.content, type: found.type } : null
		},

		async hasObject(repoId: string, oid: string): Promise<boolean> {
			const row = await db
				.selectFrom("objects")
				.select("oid")
				.where("repo_id", "=", repoId as ObjectsRepoId)
				.where("oid", "=", oid as ObjectsOid)
				.executeTakeFirst()
			return row !== undefined
		},

		/** Persist objects as one self-contained pack + index its contents. */
		async putPack(
			repoId: string,
			objects: PackInputObject[],
		): Promise<{ packId: string; oids: string[] }> {
			const pack = writePack(objects)
			const checksum = pack.subarray(pack.length - 20).toString("hex")

			const packRow = await db
				.insertInto("packs")
				.values({ bytes: pack, checksum, repo_id: repoId })
				.returning("id")
				.executeTakeFirstOrThrow()
			const packId = packRow.id

			const rows = objects.map((obj) => ({
				oid: computeOid(obj.type, obj.content) as ObjectsOid,
				pack_id: packId,
				repo_id: repoId as ObjectsRepoId,
				size: String(obj.content.length),
				type: obj.type,
			}))
			await db
				.insertInto("objects")
				.values(rows)
				.onConflict((oc) => oc.doNothing())
				.execute()

			return { oids: rows.map((r) => r.oid), packId: String(packId) }
		},
	}
}

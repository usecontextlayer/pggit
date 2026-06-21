import type { Sql } from "postgres"
import { computeOid, type GitObjectType } from "@/object"
import { readPack } from "@/pack/read-pack"
import { type PackInputObject, writePack } from "@/pack/write-pack"

const DDL = `
create table if not exists packs (
	id bigint generated always as identity primary key,
	repo_id text not null,
	checksum text not null,
	created_at timestamptz not null default now(),
	dead_at timestamptz,
	bytes bytea not null
);
create table if not exists objects (
	repo_id text not null,
	oid text not null,
	pack_id bigint not null references packs(id),
	type text not null,
	size bigint not null,
	primary key (repo_id, oid)
);
`

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
 */
export function createObjectStore(sql: Sql) {
	return {
		async getObject(repoId: string, oid: string): Promise<StoredObject | null> {
			const [objRow] = await sql`
				select pack_id from objects where repo_id = ${repoId} and oid = ${oid}
			`
			if (!objRow) return null

			const [packRow] = await sql`
				select bytes from packs where id = ${objRow.pack_id}
			`
			if (!packRow) throw new Error(`object-store: pack ${objRow.pack_id} missing`)

			const raw = packRow.bytes
			const pack = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
			const found = (await readPack(pack)).find((p) => p.oid === oid)
			return found ? { content: found.content, type: found.type } : null
		},

		async hasObject(repoId: string, oid: string): Promise<boolean> {
			const rows = await sql`
				select 1 from objects where repo_id = ${repoId} and oid = ${oid}
			`
			return rows.length > 0
		},
		async migrate(): Promise<void> {
			await sql.unsafe(DDL)
		},

		/** Persist objects as one self-contained pack + index its contents. */
		async putPack(
			repoId: string,
			objects: PackInputObject[],
		): Promise<{ packId: string; oids: string[] }> {
			const pack = writePack(objects)
			const checksum = pack.subarray(pack.length - 20).toString("hex")

			const [packRow] = await sql`
				insert into packs ${sql({ bytes: pack, checksum, repo_id: repoId })}
				returning id
			`
			if (!packRow) throw new Error("object-store: pack insert returned no row")
			const packId = String(packRow.id)

			const rows = objects.map((obj) => ({
				oid: computeOid(obj.type, obj.content),
				pack_id: packId,
				repo_id: repoId,
				size: obj.content.length,
				type: obj.type,
			}))
			await sql`insert into objects ${sql(rows)} on conflict do nothing`

			return { oids: rows.map((r) => r.oid), packId }
		},
	}
}

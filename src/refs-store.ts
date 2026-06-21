import type { Kysely } from "kysely"
import type { Database } from "@/database"
import type { RefsName, RefsRepoId } from "@/database/models/public/Refs"

export type RefRow = { name: string; oid: string }

export type RefStore = ReturnType<typeof createRefStore>

/**
 * Postgres-backed git refs: direct refs (name → oid) and symbolic refs
 * (HEAD → refs/heads/...). Per-op CAS for atomic push lands with M2; M0 needs
 * only set + list for the ls-refs advertisement.
 *
 * Like the object store, this is the wire→DB boundary: repo ids and ref names
 * are cast to their generated branded column types here.
 */
export function createRefStore(db: Kysely<Database>) {
	return {
		async getSymref(repoId: string, name: string): Promise<string | null> {
			const row = await db
				.selectFrom("refs")
				.select("symref_target")
				.where("repo_id", "=", repoId as RefsRepoId)
				.where("name", "=", name as RefsName)
				.executeTakeFirst()
			return row?.symref_target ?? null
		},

		/** Direct refs (name → oid), sorted by name. Excludes symbolic refs. */
		async listRefs(repoId: string): Promise<RefRow[]> {
			const rows = await db
				.selectFrom("refs")
				.select(["name", "oid"])
				.where("repo_id", "=", repoId as RefsRepoId)
				.where("oid", "is not", null)
				.orderBy("name")
				.execute()
			return rows.map((r) => ({ name: r.name, oid: r.oid as string }))
		},

		async setRef(repoId: string, name: string, oid: string): Promise<void> {
			await db
				.insertInto("refs")
				.values({ name: name as RefsName, oid, repo_id: repoId as RefsRepoId })
				.onConflict((oc) =>
					oc.columns(["repo_id", "name"]).doUpdateSet({ oid, symref_target: null }),
				)
				.execute()
		},

		async setSymref(repoId: string, name: string, target: string): Promise<void> {
			await db
				.insertInto("refs")
				.values({
					name: name as RefsName,
					repo_id: repoId as RefsRepoId,
					symref_target: target,
				})
				.onConflict((oc) =>
					oc
						.columns(["repo_id", "name"])
						.doUpdateSet({ oid: null, symref_target: target }),
				)
				.execute()
		},
	}
}

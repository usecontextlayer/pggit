import type { Kysely } from "kysely"
import type { Database } from "@/database"
import type { RefsName, RefsRepoId } from "@/database/models/public/Refs"

export type RefRow = { name: string; oid: string }

/** A ref change: create (oldOid=zero), update (old→new), or delete (newOid=zero). */
export type RefUpdate = { oldOid: string; newOid: string; ref: string }

export type RefStore = ReturnType<typeof createRefStore>

const isZero = (oid: string): boolean => /^0{40}$/.test(oid)

/** Sentinel thrown inside a transaction to roll an atomic batch all the way back. */
class AtomicAbort extends Error {}

/**
 * Apply one ref change by compare-and-swap against the client's advertised old
 * oid, on the given executor (the db, or a transaction for an atomic batch).
 * Returns whether exactly one row changed. Non-ff is accepted by default — CAS
 * guards concurrency, not ancestry (spec §3.6).
 */
async function casRefUpdate(
	exec: Kysely<Database>,
	repoId: string,
	cmd: RefUpdate,
): Promise<boolean> {
	const repo = repoId as RefsRepoId
	const name = cmd.ref as RefsName
	if (isZero(cmd.oldOid)) {
		const rows = await exec
			.insertInto("refs")
			.values({ name, oid: cmd.newOid, repo_id: repo })
			.onConflict((oc) => oc.doNothing())
			.returningAll()
			.execute()
		return rows.length === 1
	}
	if (isZero(cmd.newOid)) {
		const rows = await exec
			.deleteFrom("refs")
			.where("repo_id", "=", repo)
			.where("name", "=", name)
			.where("oid", "=", cmd.oldOid)
			.returningAll()
			.execute()
		return rows.length === 1
	}
	const rows = await exec
		.updateTable("refs")
		.set({ oid: cmd.newOid, symref_target: null })
		.where("repo_id", "=", repo)
		.where("name", "=", name)
		.where("oid", "=", cmd.oldOid)
		.returningAll()
		.execute()
	return rows.length === 1
}

/**
 * Postgres-backed git refs: direct refs (name → oid) and symbolic refs
 * (HEAD → refs/heads/...). Push applies ref changes through `applyRefUpdates`;
 * `setRef`/`setSymref` are the seeding helpers.
 *
 * Like the object store, this is the wire→DB boundary: repo ids and ref names
 * are cast to their generated branded column types here.
 */
export function createRefStore(db: Kysely<Database>) {
	return {
		/**
		 * Apply a batch of ref CAS updates. Non-atomic (the default push mode): each
		 * ref is independent and the returned flags are per-command. Atomic
		 * (`--atomic`): all-or-nothing in one transaction — if any CAS fails, every
		 * command is rolled back and the result is all-false (spec §3.6).
		 */
		async applyRefUpdates(
			repoId: string,
			commands: RefUpdate[],
			atomic: boolean,
		): Promise<boolean[]> {
			if (!atomic) {
				const results: boolean[] = []
				for (const cmd of commands) {
					results.push(await casRefUpdate(db, repoId, cmd))
				}
				return results
			}
			try {
				return await db.transaction().execute(async (trx) => {
					const results: boolean[] = []
					for (const cmd of commands) {
						const ok = await casRefUpdate(trx, repoId, cmd)
						results.push(ok)
						if (!ok) throw new AtomicAbort()
					}
					return results
				})
			} catch (error) {
				if (error instanceof AtomicAbort) return commands.map(() => false)
				throw error
			}
		},
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

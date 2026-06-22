import type { Kysely } from "kysely"
import type { Database } from "@/database"
import type { GitRefName } from "@/database/models/public/GitRef"
import type { ReposId } from "@/database/models/public/Repos"
import { createRepoResolver } from "@/repo-store"

export type RefRow = { name: string; oid: string }

/** A ref change: create (oldOid=zero), update (old→new), or delete (newOid=zero). */
export type RefUpdate = { oldOid: string; newOid: string; ref: string }

export type RefStore = ReturnType<typeof createRefStore>

const isZero = (oid: string): boolean => /^0{40}$/.test(oid)

const toOid = (hex: string): Buffer => Buffer.from(hex, "hex")

/**
 * A ref CAS discriminated on the wire hex strings — BEFORE any `bytea` coercion.
 * The all-zeros sentinel marks create/delete and is classified here, so it can
 * never be coerced to a real all-zero `bytea` and reach a CAS `WHERE` (which would
 * corrupt a ref instead of deleting it). Only the genuine OIDs become `bytea`.
 */
type RefOp =
	| { kind: "create"; newOid: Buffer }
	| { kind: "delete"; oldOid: Buffer }
	| { kind: "update"; oldOid: Buffer; newOid: Buffer }

function classifyRefUpdate(cmd: RefUpdate): RefOp {
	const create = isZero(cmd.oldOid)
	const del = isZero(cmd.newOid)
	if (create && del) {
		// old=new=zero is not a valid command (a create whose target is the zero
		// OID). Fail loud rather than coerce the sentinel into a real bytea.
		throw new Error(`refs-store: malformed ref command (zero old and new) for ${cmd.ref}`)
	}
	if (create) return { kind: "create", newOid: toOid(cmd.newOid) }
	if (del) return { kind: "delete", oldOid: toOid(cmd.oldOid) }
	return { kind: "update", newOid: toOid(cmd.newOid), oldOid: toOid(cmd.oldOid) }
}

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
	repoId: ReposId,
	cmd: RefUpdate,
): Promise<boolean> {
	const name = cmd.ref as GitRefName
	const op = classifyRefUpdate(cmd)
	switch (op.kind) {
		case "create": {
			const rows = await exec
				.insertInto("git_ref")
				.values({ name, oid: op.newOid, repo_id: repoId })
				.onConflict((oc) => oc.doNothing())
				.returningAll()
				.execute()
			return rows.length === 1
		}
		case "delete": {
			const rows = await exec
				.deleteFrom("git_ref")
				.where("repo_id", "=", repoId)
				.where("name", "=", name)
				.where("oid", "=", op.oldOid)
				.returningAll()
				.execute()
			return rows.length === 1
		}
		case "update": {
			const rows = await exec
				.updateTable("git_ref")
				.set({ oid: op.newOid, symref_target: null })
				.where("repo_id", "=", repoId)
				.where("name", "=", name)
				.where("oid", "=", op.oldOid)
				.returningAll()
				.execute()
			return rows.length === 1
		}
	}
}

/**
 * Postgres-backed git refs: direct refs (name → oid) and symbolic refs
 * (HEAD → refs/heads/...). Push applies ref changes through `applyRefUpdates`;
 * `setRef`/`setSymref` are the seeding helpers.
 *
 * Like the object store, this is the wire→DB boundary: the repo name resolves to
 * its bigint surrogate (memoized) here, ref names cast to their branded column
 * type, and oids coerce hex↔raw `bytea`.
 */
export function createRefStore(db: Kysely<Database>) {
	const repos = createRepoResolver(db)

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
			const id = await repos.ensureRepoId(repoId)
			if (!atomic) {
				const results: boolean[] = []
				for (const cmd of commands) {
					results.push(await casRefUpdate(db, id, cmd))
				}
				return results
			}
			try {
				return await db.transaction().execute(async (trx) => {
					const results: boolean[] = []
					for (const cmd of commands) {
						const ok = await casRefUpdate(trx, id, cmd)
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
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return null
			const row = await db
				.selectFrom("git_ref")
				.select("symref_target")
				.where("repo_id", "=", id)
				.where("name", "=", name as GitRefName)
				.executeTakeFirst()
			return row?.symref_target ?? null
		},

		/** Direct refs (name → oid), sorted by name. Excludes symbolic refs. */
		async listRefs(repoId: string): Promise<RefRow[]> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return []
			const rows = await db
				.selectFrom("git_ref")
				.select(["name", "oid"])
				.where("repo_id", "=", id)
				.where("oid", "is not", null)
				.orderBy("name")
				.execute()
			return rows.map((r) => ({ name: r.name, oid: (r.oid as Buffer).toString("hex") }))
		},

		async setRef(repoId: string, name: string, oid: string): Promise<void> {
			const id = await repos.ensureRepoId(repoId)
			const value = toOid(oid)
			await db
				.insertInto("git_ref")
				.values({ name: name as GitRefName, oid: value, repo_id: id })
				.onConflict((oc) =>
					oc
						.columns(["repo_id", "name"])
						.doUpdateSet({ oid: value, symref_target: null }),
				)
				.execute()
		},

		async setSymref(repoId: string, name: string, target: string): Promise<void> {
			const id = await repos.ensureRepoId(repoId)
			await db
				.insertInto("git_ref")
				.values({ name: name as GitRefName, repo_id: id, symref_target: target })
				.onConflict((oc) =>
					oc
						.columns(["repo_id", "name"])
						.doUpdateSet({ oid: null, symref_target: target }),
				)
				.execute()
		},
	}
}

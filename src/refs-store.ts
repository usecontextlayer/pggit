import { type Kysely, sql } from "kysely"
import type { Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import type { GitRefName } from "@/database/models/public/GitRef"
import type { ReposId } from "@/database/models/public/Repos"
import { EDGE_KIND } from "@/object-edges"
import { PACK_OBJ_TYPE } from "@/pack/object-header"
import { createRepoResolver } from "@/repo-store"

export type RefRow = { name: string; oid: string; peeled?: string }

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
	// `oldOid: null` ⇒ the client asserted no expected value (zero old-oid): an
	// unconditional delete — drop the ref if present, a no-op success otherwise.
	| { kind: "delete"; oldOid: Buffer | null }
	| { kind: "update"; oldOid: Buffer; newOid: Buffer }

function classifyRefUpdate(cmd: RefUpdate): RefOp {
	const create = isZero(cmd.oldOid)
	const del = isZero(cmd.newOid)
	// A zero new-oid is a delete regardless of the old-oid. git sends `<zero>
	// <zero> ref` to delete a ref it knows no value for — including one that does
	// not exist, which canonical receive-pack reports as a no-op success — so a
	// zero old-oid here means "delete unconditionally" (oldOid null), never a
	// malformed command. The all-zeros sentinel is classified away here and never
	// coerced into a real all-zero bytea.
	if (del) return { kind: "delete", oldOid: create ? null : toOid(cmd.oldOid) }
	if (create) return { kind: "create", newOid: toOid(cmd.newOid) }
	return { kind: "update", newOid: toOid(cmd.newOid), oldOid: toOid(cmd.oldOid) }
}

/**
 * The peeled target of a ref oid: if it is an annotated tag, follow the `kind=5`
 * (tag→target) chain — while the current node is a tag — to its terminal non-tag
 * object. A branch or a lightweight tag (the oid is not a tag object) peels to
 * `null` → `ls-refs` emits no `peeled` line. git imposes NO depth bound on ref
 * peeling, so neither do we: the `is_tag` predicate terminates the recursion at the
 * first non-tag, and a content-addressed tag chain is acyclic (an oid cannot embed
 * its own hash) hence finite. Computed at ref-write, so the tag's edges + target
 * are already present (connectivity proved the chain on push). Replaces the
 * per-`ls-refs` app-side tag walk.
 */
async function peelRef(
	exec: Kysely<Database>,
	repoId: ReposId,
	oid: Buffer,
): Promise<Buffer | null> {
	const result = await sql<{ peeled: Buffer }>`
		with recursive chain(oid, is_tag, depth) as (
			select o.oid, o.type = ${PACK_OBJ_TYPE.TAG}, 0
				from git_object o
				where o.repo_id = ${repoId}::bigint and o.oid = ${oid}::bytea
			union all
			select e.child, co.type = ${PACK_OBJ_TYPE.TAG}, c.depth + 1
				from chain c
				join git_edge e
					on e.repo_id = ${repoId}::bigint
					and e.parent = c.oid
					and e.kind = ${EDGE_KIND.TAG_TARGET}
				left join git_object co
					on co.repo_id = ${repoId}::bigint and co.oid = e.child
				where c.is_tag
		)
		select oid as peeled from chain where not is_tag and depth > 0
			order by depth desc limit 1
	`.execute(exec)
	return result.rows[0]?.peeled ?? null
}

/** Sentinel thrown inside a transaction to roll an atomic batch all the way back. */
class AtomicAbort extends Error {}

/**
 * A repo is born with `HEAD → refs/heads/main`, mirroring `git init --bare`
 * (init.defaultBranch). Established lazily on the first ref write — a repo's birth
 * is its first push — and never overwritten (do-nothing on conflict). So once the
 * default branch exists `ls-refs` advertises HEAD and a clone checks it out;
 * before then HEAD dangles unadvertised, exactly like a bare repo whose HEAD
 * points at an unborn `main`.
 */
const DEFAULT_HEAD_TARGET = "refs/heads/main"

async function ensureHeadDefault(exec: Kysely<Database>, repoId: ReposId): Promise<void> {
	await exec
		.insertInto("git_ref")
		.values({
			name: "HEAD" as GitRefName,
			repo_id: repoId,
			symref_target: DEFAULT_HEAD_TARGET,
		})
		.onConflict((oc) => oc.columns(["repo_id", "name"]).doNothing())
		.execute()
}

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
			const peeled = await peelRef(exec, repoId, op.newOid)
			const rows = await exec
				.insertInto("git_ref")
				.values({ name, oid: op.newOid, peeled_oid: peeled, repo_id: repoId })
				.onConflict((oc) => oc.doNothing())
				.returningAll()
				.execute()
			return rows.length === 1
		}
		case "delete": {
			// CAS the delete on the asserted old-oid; an unconditional delete (zero
			// old-oid ⇒ null) drops the ref by name and succeeds even when it was
			// already absent — git treats deleting a non-existent ref as a no-op.
			let q = exec
				.deleteFrom("git_ref")
				.where("repo_id", "=", repoId)
				.where("name", "=", name)
			if (op.oldOid !== null) q = q.where("oid", "=", op.oldOid)
			const rows = await q.returningAll().execute()
			return op.oldOid === null || rows.length === 1
		}
		case "update": {
			const peeled = await peelRef(exec, repoId, op.newOid)
			const rows = await exec
				.updateTable("git_ref")
				.set({ oid: op.newOid, peeled_oid: peeled, symref_target: null })
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
export function createRefStore(pg: Sql) {
	const db = initKysely<Database>(pg)
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
			await ensureHeadDefault(db, id)
			if (!atomic) {
				const results: boolean[] = []
				for (const cmd of commands) {
					results.push(await casRefUpdate(db, id, cmd))
				}
				return results
			}
			// Atomic batch: take the per-ref row locks in a deterministic by-name order
			// so two concurrent batches touching the same refs can never form a lock
			// cycle (Postgres 40P01 deadlock). An atomic result is uniform — every CAS
			// succeeds or the first failure aborts the whole batch — so the by-name CAS
			// order never affects the per-command flags, which stay in input order.
			const ordered = [...commands].sort((a, b) =>
				a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0,
			)
			try {
				await db.transaction().execute(async (trx) => {
					for (const cmd of ordered) {
						if (!(await casRefUpdate(trx, id, cmd))) throw new AtomicAbort()
					}
				})
				return commands.map(() => true)
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

		/** Direct refs (name → oid + peeled tag target), sorted by name. Excludes
		 * symbolic refs. */
		async listRefs(repoId: string): Promise<RefRow[]> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return []
			const rows = await db
				.selectFrom("git_ref")
				.select(["name", "oid", "peeled_oid"])
				.where("repo_id", "=", id)
				.where("oid", "is not", null)
				.orderBy("name")
				.execute()
			return rows.map((r) => ({
				name: r.name,
				oid: (r.oid as Buffer).toString("hex"),
				peeled: r.peeled_oid ? r.peeled_oid.toString("hex") : undefined,
			}))
		},

		async setRef(repoId: string, name: string, oid: string): Promise<void> {
			const id = await repos.ensureRepoId(repoId)
			const value = toOid(oid)
			const peeled = await peelRef(db, id, value)
			await db
				.insertInto("git_ref")
				.values({ name: name as GitRefName, oid: value, peeled_oid: peeled, repo_id: id })
				.onConflict((oc) =>
					oc
						.columns(["repo_id", "name"])
						.doUpdateSet({ oid: value, peeled_oid: peeled, symref_target: null }),
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
						// Clear peeled_oid too: a symref has no oid, so it can carry no peeled
						// target (else a stale value survives a tag→symref overwrite).
						.doUpdateSet({ oid: null, peeled_oid: null, symref_target: target }),
				)
				.execute()
		},
	}
}

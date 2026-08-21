import { type Kysely, sql } from "kysely"
import type { Sql } from "postgres"
import { assertNever } from "@/assert-never"
import { type Database, initKysely } from "@/database"
import type { GitRefName } from "@/database/models/public/GitRef"
import type { ReposId } from "@/database/models/public/Repos"
import { isOid, ZERO_OID } from "@/object/oid"
import { PACK_OBJ_TYPE } from "@/pack/object-header"
import { throwMissingDerivedRow } from "@/store/derived-row"
import { stampRepoPush } from "@/store/push-watermark"
import { createRepoResolver, type RepoResolver } from "@/store/repo-resolver"

export type RefRow = { name: string; oid: string; peeled?: string }

/** A ref change: create (oldOid=zero), update (old→new), or delete (newOid=zero). */
export type RefUpdate = { oldOid: string; newOid: string; ref: string }

export type RefStore = ReturnType<typeof createRefStore>

const isZero = (oid: string): boolean => oid === ZERO_OID

const toOidBuffer = (hex: string): Buffer => {
	// `Buffer.from("gg", "hex")` silently yields a SHORT buffer; a persisted
	// short/empty ref oid poisons every later advertisement. The wire paths
	// validate upstream — this guards the platform-facing setRef/seeding calls.
	if (!isOid(hex)) {
		throw new Error(`pggit refs: malformed object id ${JSON.stringify(hex)}`)
	}
	return Buffer.from(hex, "hex")
}

/**
 * A ref CAS discriminated on the wire hex strings — BEFORE any `bytea` coercion.
 * The all-zeros sentinel marks create/delete and is classified here, so it can
 * never be coerced to a real all-zero `bytea` and reach a CAS `WHERE` (which would
 * corrupt a ref instead of deleting it). Only the genuine OIDs become `bytea`.
 */
type RefOp =
	| { kind: "create"; newOid: Buffer }
	| { kind: "delete-unconditional" }
	| { kind: "delete-exact"; oldOid: Buffer }
	| { kind: "update"; oldOid: Buffer; newOid: Buffer }

function classifyRefUpdate(cmd: RefUpdate): RefOp {
	const create = isZero(cmd.oldOid)
	const del = isZero(cmd.newOid)
	// A zero new-oid is a delete regardless of the old-oid. git sends `<zero>
	// <zero> ref` to delete a ref it knows no value for — including one that does
	// not exist, which canonical receive-pack reports as a no-op success — so a
	// zero old-oid here means "delete unconditionally", never a
	// malformed command. The all-zeros sentinel is classified away here and never
	// coerced into a real all-zero bytea.
	if (del) {
		return create
			? { kind: "delete-unconditional" }
			: { kind: "delete-exact", oldOid: toOidBuffer(cmd.oldOid) }
	}
	if (create) return { kind: "create", newOid: toOidBuffer(cmd.newOid) }
	return {
		kind: "update",
		newOid: toOidBuffer(cmd.newOid),
		oldOid: toOidBuffer(cmd.oldOid),
	}
}

/**
 * The peeled target of a ref oid: if it is an annotated tag, follow the `git_tag`
 * (tag→target) chain — while the current node is a tag — to its terminal non-tag
 * object. A branch or a lightweight tag (the oid is not a tag object) peels to
 * `null` → `ls-refs` emits no `peeled` line. git imposes NO depth bound on ref
 * peeling, so neither do we: the `is_tag` predicate terminates the recursion at the
 * first non-tag, and a content-addressed tag chain is acyclic (an oid cannot embed
 * its own hash) hence finite. Computed at ref-write, so the chain's `git_tag` rows
 * and targets are already present (connectivity proved the chain on push).
 * Computing it at write time keeps `ls-refs` a direct row read.
 */
async function peelRef(
	exec: Kysely<Database>,
	repoId: ReposId,
	oid: Buffer,
): Promise<Buffer | null> {
	const result = await sql<{ corrupt_oid: Buffer | null; peeled: Buffer | null }>`
		with recursive chain(oid, is_tag, has_derived, depth) as (
			select o.oid, o.type = ${PACK_OBJ_TYPE.TAG}, t.oid is not null, 0
				from git_object o
				left join git_tag t
					on t.repo_id = o.repo_id and t.oid = o.oid
				where o.repo_id = ${repoId}::bigint and o.oid = ${oid}::bytea
			union all
			select target.oid, target.type = ${PACK_OBJ_TYPE.TAG}, next_tag.oid is not null,
				c.depth + 1
				from chain c
				join git_tag current_tag
					on current_tag.repo_id = ${repoId}::bigint and current_tag.oid = c.oid
				join git_object target
					on target.repo_id = ${repoId}::bigint
					and target.oid = current_tag.target_oid
				left join git_tag next_tag
					on next_tag.repo_id = target.repo_id and next_tag.oid = target.oid
				where c.is_tag
		)
		select
			(select oid from chain where not is_tag and depth > 0
				order by depth desc limit 1) as peeled,
			(select oid from chain where is_tag and not has_derived
				order by depth limit 1) as corrupt_oid
	`.execute(exec)
	const [row] = result.rows
	if (!row) throw new Error("pggit refs: peel query returned no row")
	if (row.corrupt_oid !== null) {
		throwMissingDerivedRow(row.corrupt_oid.toString("hex"), PACK_OBJ_TYPE.TAG)
	}
	return row.peeled
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

/** The loud absorb for a failed post-CAS activity stamp (see the call sites). */
function logStampFailure(repo: string): (err: unknown) => void {
	return (err) => {
		console.error(
			`pggit: last_pushed_at stamp failed for ${JSON.stringify(repo)} (the ref updates are already applied; GC sees this repo on its next successful push):`,
			err,
		)
	}
}

/** The three real CAS outcomes. `noop` is an unconditional delete of an absent
 * ref: report-status success, but no activity stamp. */
type CasResult = { state: "applied" } | { state: "noop" } | { state: "rejected" }

/**
 * Apply one ref change by compare-and-swap against the client's advertised old
 * oid, on the given executor (the db, or a transaction for an atomic batch).
 * Returns the named applied/no-op/rejected outcome.
 * Non-ff is accepted by default — CAS guards concurrency, not ancestry (spec §3.6).
 */
async function casRefUpdate(
	exec: Kysely<Database>,
	repoId: ReposId,
	cmd: RefUpdate,
): Promise<CasResult> {
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
			return { state: rows.length === 1 ? "applied" : "rejected" }
		}
		case "delete-unconditional": {
			// A zero old-oid drops the ref by name and succeeds even when it was
			// already absent — git treats deleting a non-existent ref as a no-op.
			const rows = await exec
				.deleteFrom("git_ref")
				.where("repo_id", "=", repoId)
				.where("name", "=", name)
				.returningAll()
				.execute()
			return { state: rows.length === 1 ? "applied" : "noop" }
		}
		case "delete-exact": {
			const rows = await exec
				.deleteFrom("git_ref")
				.where("repo_id", "=", repoId)
				.where("name", "=", name)
				.where("oid", "=", op.oldOid)
				.returningAll()
				.execute()
			return { state: rows.length === 1 ? "applied" : "rejected" }
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
			return { state: rows.length === 1 ? "applied" : "rejected" }
		}
	}
	return assertNever(op)
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
export function createRefStore(pg: Sql, repoResolver?: RepoResolver) {
	const db = initKysely<Database>(pg)
	const repos = repoResolver ?? createRepoResolver(db)

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
				let mutated = false
				for (const cmd of commands) {
					// Per-ref independence IS non-atomic semantics (git's `ng` line): a
					// storage failure on one command — a lock timeout from a concurrent
					// writer of that ref's row — fails THAT command and never the batch.
					// Letting it throw here would 500 a push whose earlier commands are
					// already applied: refs moved, no report, no projection, no stamp —
					// the three-way tear pg-txn--post-cas-failure-tears-push pins.
					try {
						const r = await casRefUpdate(db, id, cmd)
						results.push(r.state !== "rejected")
						if (r.state === "applied") mutated = true
					} catch (err) {
						console.error(
							`pggit: ref update failed for ${JSON.stringify(cmd.ref)} (reported ng; the rest of the batch continues):`,
							err,
						)
						results.push(false)
					}
				}
				// One activity stamp per push, only when a ref actually changed — a batch
				// of pure no-ops leaves the watermark untouched (so GC is not re-triggered).
				// Best-effort: the refs are already MOVED, so a stamp failure must never
				// fail the push (the client would see failure for an applied update — a
				// torn report). The cost is the documented delayed-GC trade: this repo's
				// garbage waits until some later push stamps it.
				if (mutated) await stampRepoPush(db, id).catch(logStampFailure(repoId))
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
			let anyMutated = false
			try {
				await db.transaction().execute(async (trx) => {
					for (const cmd of ordered) {
						const r = await casRefUpdate(trx, id, cmd)
						if (r.state === "rejected") throw new AtomicAbort()
						if (r.state === "applied") anyMutated = true
					}
				})
			} catch (error) {
				if (error instanceof AtomicAbort) return commands.map(() => false)
				throw error
			}
			// Stamp AFTER the batch commits — NOT inside the txn. `clock_timestamp()` must
			// be read at/after the ref-move's COMMIT so the activity watermark is never
			// stamped earlier than the orphan it announces; an in-txn stamp evaluates
			// before commit, letting a concurrent GC pass write `last_gc_at` past it and
			// lose that garbage forever (the GC primitive's snapshot still protects
			// liveness, so this is leak-not-corruption — but a leak the durable signal is
			// meant to prevent). Mirrors the non-atomic path, which already stamps after
			// its CAS commits — and is best-effort for the same reason (the batch is
			// already applied; a stamp failure must not turn success into a torn report).
			if (anyMutated) await stampRepoPush(db, id).catch(logStampFailure(repoId))
			return commands.map(() => true)
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

		/** EVERY ref name in the repo — value refs AND symrefs. The receive
		 * policy's directory/file check needs the full namespace: a symbolic
		 * `refs/remotes/origin/HEAD` blocks `refs/remotes/origin/HEAD/x` exactly
		 * like a value ref would (`listRefs` deliberately hides symrefs — that
		 * is the ADVERT's contract, not the namespace's). */
		async listRefNames(repoId: string): Promise<string[]> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return []
			const rows = await db
				.selectFrom("git_ref")
				.select("name")
				.where("repo_id", "=", id)
				.execute()
			return rows.map((r) => r.name)
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
			const value = toOidBuffer(oid)
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

import type { Kysely } from "kysely"
import type { ReservedSql, Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import { copyInsert } from "@/database/copy-insert"
import type { ReposId } from "@/database/models/public/Repos"
import { reachableClosure } from "@/store/reachability"
import { createRepoResolver } from "@/store/repo-resolver"

/**
 * Per-repo reachability GC — the one piece of the Postgres-native redesign (§7)
 * that the rest of the spine deferred. See `docs/2026-06-24-force-commit-gc-design.md`
 * for the design; the observable contract is §4 of that doc, and the authoritative
 * algorithm is §7 of `internal/archived/2026-06-22-pggit-postgres-native-storage-
 * redesign.md`.
 *
 * The mechanism (data-structures-first): materialize the LIVE set — the reachable
 * closure from every ref tip — into an UNLOGGED table, then sweep `git_object` in
 * batched short transactions with a server-side anti-join (`NOT EXISTS`) against
 * that table plus a `created_at` grace cutoff. Reachability itself is NOT re-derived
 * here: it is exactly `reachableClosure(omitBlobs=false)`, the one engine clone /
 * fetch / connectivity already share, so GC can never disagree with them about what
 * is reachable.
 */

/** Tunables for one GC pass. `graceSeconds` is REQUIRED — no silent default: an
 * object is reclaimed iff it is unreachable from every ref AND its `created_at`
 * is older than `graceSeconds` (0 ⇒ reclaim all unreachable; a huge value ⇒
 * retain). `batchLimit` caps the per-batch DELETE size (sweep tuning only — it
 * never changes the final observable state). `maintain` (default true) runs the
 * post-sweep VACUUM/REINDEX; the self-scheduling drain passes `false` so a
 * frequent per-repo pass never triggers a full-table VACUUM on the hot cadence
 * (autovacuum reclaims the GC churn instead). Maintenance is observable-neutral —
 * it changes dead-tuple bloat, never the row/clone state. */
export type GcOptions = { graceSeconds: number; batchLimit?: number; maintain?: boolean }

/**
 * Internal-only test seam (NOT part of the public `GcOptions` contract): hooks the
 * GC pass at the one point §5 in-flight safety depends on. `afterLiveSet` is awaited
 * AFTER the live set is materialized and BEFORE the object sweep begins, so a test
 * can deterministically interpose a concurrent push there and assert the just-pushed
 * tip is never partially reclaimed. Test-only; do not document or use in production.
 */
type GcHooks = { afterLiveSet?: () => Promise<void> }
type InternalGcOptions = GcOptions & { _hooks?: GcHooks }

/** What one GC pass reclaimed: the deleted `git_object` / `git_edge` row counts. */
export type GcResult = { deletedObjects: number; deletedEdges: number }

export type Gc = ReturnType<typeof createGc>

/** Default per-batch DELETE cap when the caller omits `batchLimit`. Large enough to
 * sweep a typical force-commit orphan set in one or two batches, small enough to
 * bound the dead-tuple burst and lock duration per transaction (§7). */
const DEFAULT_BATCH_LIMIT = 10_000

/** OIDs loaded per COPY round-trip into the live table (the live set can be the whole
 * reachable tree, so it streams in bounded batches, never one giant payload). */
const LIVE_LOAD_BATCH = 10_000

/**
 * Build the GC over a porsager client (the same wire→DB boundary the object and ref
 * stores take). `gc(repo, opts)` reclaims a single repo's unreachable-and-old-enough
 * objects offline; reachable objects are always retained.
 */
export function createGc(pg: Sql) {
	const db = initKysely<Database>(pg)
	const repos = createRepoResolver(db)

	return {
		async gc(repo: string, opts: InternalGcOptions): Promise<GcResult> {
			// 1. Resolve the repo. A name never written has nothing to reclaim.
			const id = await repos.resolveRepoId(repo)
			if (id === null) return { deletedEdges: 0, deletedObjects: 0 }

			const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT

			// 2 + 3. Materialize the live set under a consistent snapshot.
			//
			// CONCURRENCY: the write/ingest path (`object-store.insertObjects`) does NOT
			// yet take a per-repo `pg_advisory_xact_lock` — that lock was deferred to this
			// GC chunk (redesign §5.4 / §12) and has no other consumer. So GC takes its
			// safety from two defenses (§5): (a) a REPEATABLE READ transaction, so the
			// ref-tip read and the closure walk see ONE consistent MVCC snapshot that
			// hides any push not yet committed when the snapshot opened; and (b) the
			// `created_at` grace below, which protects the present-but-unreachable window
			// (just-ingested objects a ref does not yet reach). When the write path adopts
			// the same per-repo advisory lock, GC should take that SAME key around this
			// read for full §5 mutual exclusion — DO NOT add a key here that the write path
			// does not also hold, or the lock would guard nothing.
			//
			// The live OIDs land in a per-repo UNLOGGED table (named by repo id, so two
			// DIFFERENT repos' GC passes never collide) — server-side so the sweep's
			// anti-join scales to a ~30k-orphan repo without pulling the orphan set through
			// JS. SINGLE-INSTANCE ONLY: two pggit processes GC'ing the SAME repo would share
			// this id-named table — B's `truncate`/`drop` could wipe A's live set mid-sweep,
			// and A's anti-join would then match (and delete) the whole reachable set. So the
			// deferred multi-instance advisory lock (redesign §5.4; scheduler design §8) MUST
			// wrap the ENTIRE pass (create→load→sweep→drop) AND the staging table be
			// instance-scoped, before a second instance is ever run.
			const live = `gc_live_${id}`
			await pg.unsafe(
				`create unlogged table if not exists ${live} (oid bytea primary key)`,
			)
			try {
				await pg.unsafe(`truncate ${live}`)

				const roots = await liveSet(id)
				await loadLive(live, roots)

				// TEST SEAM (§5 in-flight safety): interpose a concurrent push here, between
				// the live-set materialization and the object sweep.
				await opts._hooks?.afterLiveSet?.()

				// 4. SWEEP objects: batched DELETE, each batch its own short transaction,
				// anti-join `NOT EXISTS` against the live set, `created_at` past the grace
				// cutoff. `clock_timestamp()` (not `now()`) so the cutoff advances per batch.
				const deletedObjects = await sweepObjects(id, live, opts.graceSeconds, batchLimit)

				// 5. SWEEP edges: drop every edge whose PARENT object no longer survives —
				// run AFTER the object sweep, so a grace-retained object keeps its edges and a
				// surviving (reachable) parent's edges (which point only at reachable children)
				// never dangle.
				const deletedEdges = await sweepEdges(id, batchLimit)

				// 6. MAINTENANCE (best-effort, not part of the counted deletion): reclaim the
				// dead tuples + reindex the walk index. VACUUM cannot run in a txn block, so
				// these are standalone statements run outside any transaction. Skipped when
				// the pass reclaimed nothing (no dead tuples to chase) or the caller opted out
				// (`maintain: false`, the drain's choice) — so a frequent per-repo drain never
				// triggers a full-table VACUUM/REINDEX on its hot cadence; the leaf partitions'
				// autovacuum (0001_init.ts) reclaims the GC churn. Observable-neutral either way.
				if (opts.maintain !== false && deletedObjects + deletedEdges > 0) {
					await maintain()
				}

				return { deletedEdges, deletedObjects }
			} finally {
				await pg.unsafe(`drop table if exists ${live}`)
			}
		},
	}

	/**
	 * The live set: the reachable closure from every ref tip, read under ONE
	 * REPEATABLE READ snapshot so the ref-tip read and the multi-statement closure
	 * walk cannot interleave with a concurrent push's ref update (§5 defense (a)).
	 *
	 * `reachableClosure` is the shared engine and takes a `Kysely`, but the
	 * kysely-postgres-js dialect drives queries by calling `.reserve()` on its
	 * `postgres` client for EACH query — so a plain pooled Kysely would scatter the
	 * closure's statements across connections (no shared snapshot), and a
	 * transaction-scoped `Sql` has no `.reserve()` at all. So we pin ONE porsager
	 * connection, open a REPEATABLE READ transaction on it, and back a Kysely with a
	 * shim whose `reserve()` always returns that pinned connection with a no-op
	 * `release()` — every closure statement then runs on the one snapshotted
	 * connection. The transaction is read-only; it commits (releasing the snapshot)
	 * before the sweep's own short write transactions begin.
	 */
	async function liveSet(id: ReposId): Promise<Set<string>> {
		const conn = await pg.reserve()
		try {
			await conn`begin isolation level repeatable read`
			const pinned = pinnedKysely(conn)
			const rows = await conn<{ oid: Buffer | null; peeled_oid: Buffer | null }[]>`
				select oid, peeled_oid from git_ref where repo_id = ${id} and oid is not null
			`
			// Roots: every direct ref tip plus each annotated tag's peeled target. The
			// closure over kinds (1,2,3,5) already descends tag→target, so the peeled
			// target is redundant for the walk, but it is included to match §7 and stay
			// correct even if a tag ref's edge were ever absent.
			const tips = new Set<string>()
			for (const r of rows) {
				if (r.oid) tips.add(r.oid.toString("hex"))
				if (r.peeled_oid) tips.add(r.peeled_oid.toString("hex"))
			}
			const { present } = await reachableClosure(pinned, id, [...tips], false)
			await conn`commit`
			return present
		} finally {
			conn.release()
		}
	}

	/** A Kysely pinned to a single porsager connection: its dialect `reserve()`s the
	 * same connection for every statement (so a multi-statement read shares one MVCC
	 * snapshot) and `release()` is a no-op (the caller owns the connection's lifetime).
	 * The shim is a callable with a `reserve` property, the shape the dialect probes
	 * for (`isPostgresJSSql`). */
	function pinnedKysely(conn: ReservedSql): Kysely<Database> {
		// The dialect only ever calls `.unsafe(sql, params)` then `.release()` on the
		// reserved connection — so hand it the real `conn` for `.unsafe` but swallow
		// `.release()` (a no-op), keeping the connection pinned across every closure
		// statement. The caller releases `conn` exactly once when the snapshot is done.
		const nonReleasing = new Proxy(conn, {
			get: (target, prop) =>
				prop === "release" ? () => {} : Reflect.get(target, prop, target),
		})
		const handle = Object.assign(
			() => {
				throw new Error("pggit gc: pinned client used as a tagged template")
			},
			{ reserve: async () => nonReleasing },
		)
		return initKysely<Database>(handle as unknown as Sql)
	}

	/** Bulk-load the live OID set into the UNLOGGED `live` table via binary COPY (the
	 * one bytea-safe bulk path, copy-insert.ts), batched so the payload stays bounded.
	 * Each COPY runs in its own transaction so the staging temp table drops on commit. */
	async function loadLive(live: string, oids: Set<string>): Promise<void> {
		if (oids.size === 0) return
		const all = [...oids]
		for (let i = 0; i < all.length; i += LIVE_LOAD_BATCH) {
			const chunk = all.slice(i, i + LIVE_LOAD_BATCH)
			await pg.begin(async (tx) => {
				await copyInsert(
					tx,
					live,
					["oid"],
					chunk.map((hex) => [{ t: "bytea", v: Buffer.from(hex, "hex") }]),
				)
			})
		}
	}

	/** Batched object sweep. Postgres `DELETE` has no `LIMIT`, so each batch picks a
	 * `LIMIT`-bounded set of victim OIDs then deletes them by PRIMARY KEY `(repo_id,
	 * oid)`. The match is on the PK — NOT `ctid`: `ctid` is per-partition-relative, so
	 * matching `ctid` across the HASH-partitioned table would delete same-ctid rows in
	 * OTHER partitions (other tenants). The loop ends when a batch deletes nothing.
	 * Each batch is its own (implicit) transaction, so `clock_timestamp()` re-evaluates
	 * per batch and the grace cutoff advances. Returns total rows deleted. */
	async function sweepObjects(
		id: ReposId,
		live: string,
		graceSeconds: number,
		batchLimit: number,
	): Promise<number> {
		let total = 0
		for (;;) {
			const deleted = await pg.unsafe<{ n: number }[]>(
				`with victims as (
					select o.oid from git_object o
					where o.repo_id = $1::bigint
						and not exists (select 1 from ${live} l where l.oid = o.oid)
						and o.created_at < clock_timestamp() - make_interval(secs => $2::float8)
					limit $3::int
				)
				delete from git_object o using victims v
				where o.repo_id = $1::bigint and o.oid = v.oid returning 1 as n`,
				[String(id), String(graceSeconds), String(batchLimit)],
			)
			if (deleted.length === 0) break
			total += deleted.length
		}
		return total
	}

	/** Batched edge sweep: delete every `git_edge` row whose PARENT object no longer
	 * exists in `git_object` (a deleted object's outgoing edges). No FK cascade exists
	 * (0003_git_edge.ts), so dangling edges must be swept explicitly. Anti-join on the
	 * parent only: a surviving parent is reachable, so all its children are reachable
	 * and present — its edges never dangle. Like the object sweep, each batch picks a
	 * `LIMIT`-bounded victim set then deletes by PRIMARY KEY `(repo_id, parent, child)`
	 * — never `ctid`, which is per-partition and would reach into other tenants. */
	async function sweepEdges(id: ReposId, batchLimit: number): Promise<number> {
		let total = 0
		for (;;) {
			const deleted = await pg.unsafe<{ n: number }[]>(
				`with victims as (
					select e.parent, e.child from git_edge e
					where e.repo_id = $1::bigint
						and not exists (
							select 1 from git_object o where o.repo_id = e.repo_id and o.oid = e.parent
						)
					limit $2::int
				)
				delete from git_edge e using victims v
				where e.repo_id = $1::bigint and e.parent = v.parent and e.child = v.child
				returning 1 as n`,
				[String(id), String(batchLimit)],
			)
			if (deleted.length === 0) break
			total += deleted.length
		}
		return total
	}

	/** Post-sweep maintenance (best-effort): reclaim the dead tuples GC produced in
	 * the heap + TOAST and refresh planner stats, then reindex the walk index.
	 * `VACUUM` cannot run inside a transaction block, so these are standalone
	 * statements run outside any txn. */
	async function maintain(): Promise<void> {
		await pg.unsafe(`vacuum (analyze) git_object`)
		await pg.unsafe(`vacuum (analyze) git_edge`)
		await pg.unsafe(`reindex index git_edge_walk`)
	}
}

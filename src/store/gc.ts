import type { Kysely } from "kysely"
import type { ReservedSql, Sql } from "postgres"
import { z } from "zod"
import { type Database, initKysely } from "@/database"
import { copyInto } from "@/database/copy-insert"
import type { ReposId } from "@/database/models/public/Repos"
import {
	bitmapFromPositions,
	concatSortedOids,
	deleteEpoch,
	type Epoch,
	type EpochOutcome,
	loadEpoch,
	positionOf,
	remapPositions,
	splitOids,
	unionHas,
	writeEpoch,
} from "@/store/reach-epoch"
import { type OriginWalk, originClosure } from "@/store/reachability"
import { lookupRepoId } from "@/store/repo-resolver"

/** Default per-batch DELETE cap when the caller omits `batchLimit`. Large enough to
 * sweep a typical force-commit orphan set in one or two batches, small enough to
 * bound the dead-tuple burst and lock duration per transaction (§7). */
const DEFAULT_BATCH_LIMIT = 10_000

/**
 * Per-repo reachability GC. See `docs/2026-06-24-force-commit-gc-design.md`
 * for its observable contract and algorithm.
 *
 * The mechanism (data-structures-first): plan the LIVE set from the reachability
 * epoch when possible, otherwise through `originClosure`, and materialize it into
 * a TEMP table on ONE reserved connection. Then sweep `git_object` on that same
 * connection in batched short transactions with a server-side anti-join
 * (`NOT EXISTS`) against the table plus a `created_at` grace cutoff. The epoch
 * plan and live set come from one snapshot, so serving and reclamation share the
 * same reachability truth.
 */

/** Tunables for one GC pass. `graceSeconds` is REQUIRED — no silent default: an
 * object is reclaimed iff it is unreachable from every ref AND its `created_at`
 * is older than `graceSeconds` (0 ⇒ reclaim all unreachable; a huge value ⇒
 * retain). Grace is the ONLY in-flight defense (design D13, git's
 * `gc.pruneExpire`): at 0, a pass racing a live push can reclaim the push's
 * just-ingested objects and the client's ACKED push becomes unfetchable —
 * exactly git's documented `--prune=now` hazard. 0 is an operator/test setting;
 * production drains keep a real grace. `batchLimit` caps the per-batch DELETE size (sweep tuning only — it
 * never changes the final observable state). `maintain` (default true) runs the
 * post-sweep VACUUM/REINDEX; the self-scheduling drain passes `false` so a
 * frequent per-repo pass never triggers a full-table VACUUM on the hot cadence
 * (autovacuum reclaims the GC churn instead). Maintenance is observable-neutral —
 * it changes dead-tuple bloat, never the row/clone state. */
export const GcGraceSecondsSchema = z.number().finite().nonnegative()

const GcOptionsSchema = z
	.object({
		batchLimit: z.number().int().positive().default(DEFAULT_BATCH_LIMIT),
		graceSeconds: GcGraceSecondsSchema,
		maintain: z.boolean().default(true),
	})
	.strict()

export type GcOptions = z.input<typeof GcOptionsSchema>

/**
 * Internal-only test seam (NOT part of the public `GcOptions` contract): hooks the
 * GC pass at the one point §5 in-flight safety depends on. `afterLiveSet` is awaited
 * AFTER the live set is materialized and BEFORE the object sweep begins, so a test
 * can deterministically interpose a concurrent push there and assert the just-pushed
 * tip is never partially reclaimed. Test-only; do not document or use in production.
 */
type GcHooks = { afterLiveSet?: () => Promise<void> }
type InternalGcOptions = GcOptions & { _hooks?: GcHooks }

/** What one GC pass reclaimed: the deleted `git_object` row count. Derived rows
 * (`git_pack_encoding`, `git_commit`, `git_tag`) are not counted: they follow
 * the inventory by FK `ON DELETE CASCADE` (0008/0009), dying inside the object
 * sweep's own DELETEs rather than in passes of their own. `epoch` reports what
 * the pass decided about the reachability epoch, including quiet-drain skips
 * and loud rewind rebuilds. */
export type GcResult = {
	deletedObjects: number
	epoch: EpochOutcome
}

/** One pass's epoch decision, planned under the walk snapshot and applied
 * after the sweep. The write-carrying variants hold the full payload
 * (`writeEpoch`'s shape) so nothing is re-derived outside the snapshot. */
type EpochPlan =
	| { outcome: "unchanged" | "cleared" }
	| (Epoch & { outcome: "advanced" | "rebuilt" })

type AdvanceAttempt =
	| {
			state: "ready"
			live: readonly string[]
			plan: EpochPlan & { outcome: "advanced" }
	  }
	| { state: "rebuild" }

export type Gc = ReturnType<typeof createGc>

/** The per-pass live-set staging table. TEMP, so the fixed name is safe: it is
 * created in the pass's own session (`pg_temp` resolves ahead of the schema's
 * tables), invisible to every other connection, and dies with its own. */
const LIVE_TABLE = "gc_live"

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

	return {
		async gc(repo: string, opts: InternalGcOptions): Promise<GcResult> {
			const { _hooks, ...rawOptions } = opts
			const options = GcOptionsSchema.parse(rawOptions)
			// 1. Resolve the repo. A name never written has nothing to reclaim. Resolved
			// fresh every pass — a long-lived Gc outlives repo delete/re-create cycles
			// (lookupRepoId).
			const id = await lookupRepoId(db, repo)
			if (id === null) return { deletedObjects: 0, epoch: "unchanged" }

			// 2 + 3. Materialize the live set under a consistent snapshot.
			//
			// CONCURRENCY: the write/ingest path (`object-store.insertObjects`) and GC do
			// not share a per-repo advisory lock. GC therefore takes its safety from two
			// defenses: (a) a REPEATABLE READ transaction, so the
			// ref-tip read and the closure walk see ONE consistent MVCC snapshot that
			// hides any push not yet committed when the snapshot opened; and (b) the
			// `created_at` grace below, which protects the present-but-unreachable window
			// (just-ingested objects a ref does not yet reach). A GC-only advisory lock
			// would guard nothing because the writer would not participate in it.
			//
			// The live OIDs land in a TEMP table on this pass's one reserved connection —
			// server-side, so the sweep's anti-join scales to a ~30k-orphan repo without
			// pulling the orphan set through JS, and session-private, so two passes (same
			// repo or not, this instance or another) can NEVER see or clobber each
			// other's live set: `pg_temp` resolves ahead of the schema, and the table
			// dies with its connection. A crashed pass's leftover is healed by the next
			// pass's drop-if-exists on that pooled connection. Multiple instances can
			// duplicate sweep work, but cannot share or corrupt this staging state.
			const connection = await pg.reserve()
			try {
				await connection.unsafe(`drop table if exists ${LIVE_TABLE}`)
				await connection.unsafe(`create temp table ${LIVE_TABLE} (oid bytea primary key)`)

				const { live, plan } = await livePlan(connection, id)
				await loadLive(connection, live)

				// Give every sweep statement statistics that are correct AT PLAN TIME.
				// Autovacuum's analyze cadence is a race, not a guarantee: a burst of
				// ingest (many repos pushed inside one naptime window) leaves the
				// partitions' reltuples orders of magnitude under reality, and a victims
				// anti-join planned in that gap flips from a single-pass Hash Anti Join
				// to a per-row Nested Loop — observed burning >10 minutes of CPU on a
				// 46k-row partition. The TEMP live table is never visible to autovacuum
				// at all. All three ANALYZEs are milliseconds-to-seconds, offline-pass
				// budget; correctness of the pass never depended on them, only its cost.
				await connection.unsafe(`analyze ${LIVE_TABLE}`)
				await connection.unsafe(`analyze git_object`)

				// TEST SEAM (§5 in-flight safety): interpose a concurrent push here, between
				// the live-set materialization and the object sweep.
				await _hooks?.afterLiveSet?.()

				// 4. SWEEP objects: batched DELETE, each batch its own short transaction,
				// anti-join `NOT EXISTS` against the live set, `created_at` past the grace
				// cutoff. `clock_timestamp()` (not `now()`) so the cutoff advances per batch.
				// Each DELETE also takes the reclaimed objects' derived rows — the
				// `git_pack_encoding` encoding (and every delta anchored on it, 0008) and
				// the `git_commit`/`git_tag` rows (0009) — via FK cascades: no derived
				// surface can be torn from the inventory, mid-pass or mid-crash, and none
				// needs a sweep of its own (design D7/D14, expressed as DDL).
				const deletedObjects = await sweepObjects(
					connection,
					id,
					options.graceSeconds,
					options.batchLimit,
				)

				// 5. MAINTENANCE (best-effort, not part of the counted deletion): reclaim
				// the dead tuples the sweep produced. VACUUM cannot run in a txn block, so
				// these are standalone statements run outside any transaction. Skipped when
				// the pass reclaimed nothing (no dead tuples to chase) or the caller opted
				// out (`maintain: false`, the drain's choice) — so a frequent per-repo drain
				// never triggers a full-table VACUUM on its hot cadence; the leaf
				// partitions' autovacuum (0001_init.ts) reclaims the GC churn.
				// Observable-neutral either way.
				if (options.maintain && deletedObjects > 0) {
					await maintain(connection)
				}

				// The reachability epoch, written AFTER the sweep on this
				// same reserved connection. Its tips/bits were computed under the
				// walk's REPEATABLE READ snapshot and carried here in JS — a push
				// landing mid-pass cannot smuggle in a tip the walk never covered
				// (the serve-side guards reconcile that staleness at fetch time).
				// The sweep cannot invalidate the payload: it deletes only
				// UNREACHABLE objects, and every epoch member is reachable.
				if (plan.outcome === "cleared") {
					await deleteEpoch(connection, id)
				} else if (plan.outcome === "advanced" || plan.outcome === "rebuilt") {
					await writeEpoch(connection, id, plan)
				}

				// Loud, and only on the success path: a FAILED pass skips this drop (its
				// connection may be unusable, and a cleanup failure must never replace the
				// pass's real error) — the next pass on this connection heals the leftover.
				await connection.unsafe(`drop table if exists ${LIVE_TABLE}`)
				return { deletedObjects, epoch: plan.outcome }
			} finally {
				connection.release()
			}
		},
	}

	/**
	 * The live set AND the epoch plan, from ONE walk under ONE REPEATABLE READ
	 * snapshot, so the ref-tip read and the multi-statement walk cannot
	 * interleave with a concurrent push's ref update (§5 defense (a)).
	 *
	 * Chunk 5b makes GC the epoch producer, and the epoch pays GC back: tips
	 * identical to the stored epoch ⇒ the live set IS the epoch's array, no
	 * walk at all; refs only advanced ⇒ `originClosure` walks only the
	 * since-epoch delta (unmoved tips stop at themselves instantly) and the
	 * old closure rides in by bitmap remap; anything else — a rewind, a
	 * deleted ref, a current tip sitting INSIDE the old array — rebuilds from
	 * a full walk, LOUDLY visible as `outcome: "rebuilt"`.
	 *
	 * Roots are the ref tip oids alone: the walk descends tag→target through
	 * the `git_tag` rows (the derived-row invariant is loud when violated), so peeled
	 * targets add nothing — and the epoch's per-tip bitmaps must be keyed by
	 * the REF oids exactly.
	 *
	 * `originClosure` is the shared engine and takes a `Kysely`, but the
	 * kysely-postgres-js dialect drives queries by calling `.reserve()` on its
	 * `postgres` client for EACH query — so a plain pooled Kysely would scatter the
	 * walk's statements across connections (no shared snapshot), and a
	 * transaction-scoped `Sql` has no `.reserve()` at all. So we pin ONE porsager
	 * connection, open a REPEATABLE READ transaction on it, and back a Kysely with a
	 * shim whose `reserve()` always returns that pinned connection with a no-op
	 * `release()` — every walk statement then runs on the one snapshotted
	 * connection. The dialect recognizes a client with `"reserve" in handle`, so the
	 * shim must expose `reserve` to both membership and property access. The
	 * transaction is read-only; it commits (releasing the snapshot) before the
	 * sweep's own short write transactions begin.
	 */
	async function livePlan(
		connection: ReservedSql,
		id: ReposId,
	): Promise<{ live: readonly string[]; plan: EpochPlan }> {
		try {
			await connection`begin isolation level repeatable read`
			const pinned = pinnedKysely(connection)
			const rows = await connection<{ oid: Buffer | null }[]>`
				select oid from git_ref where repo_id = ${id} and oid is not null
			`
			const tips = [
				...new Set(rows.flatMap((r) => (r.oid ? [r.oid.toString("hex")] : []))),
			].sort()
			const loadedEpoch = await loadEpoch(pinned, id)
			const epoch = loadedEpoch.state === "absent" ? null : loadedEpoch.epoch
			let decision: { live: readonly string[]; plan: EpochPlan }
			if (tips.length === 0) {
				decision = { live: [], plan: { outcome: epoch ? "cleared" : "unchanged" } }
			} else if (
				loadedEpoch.state === "ready" &&
				sameSortedOids(tips, loadedEpoch.epoch.tips)
			) {
				decision = {
					live: splitOids(loadedEpoch.epoch.oids),
					plan: { outcome: "unchanged" },
				}
			} else {
				decision = await planWalk(pinned, id, tips, epoch)
			}
			await connection`commit`
			return decision
		} catch (err) {
			// The caller `release()`s this connection back to the POOL with its session
			// state intact, so a walk that dies with the transaction open (a statement
			// timeout, a cancel, lock contention — even a BEGIN that errored client-side
			// after starting server-side) would hand every later borrower an open
			// ABORTED transaction — `25P02` on all of them, forever, until a process
			// restart. Roll back here. Best-effort: a dead backend has no transaction
			// left to roll back, and the walk's own error must propagate, never this
			// cleanup's.
			await connection`rollback`.catch(() => {})
			throw err
		}
	}

	/** Walk and plan: the steady-state delta attempt first (when the shape
	 * allows it), the full rebuild otherwise or when the attempt discovers the
	 * old closure is no longer fully live. A current tip found INSIDE the old
	 * epoch array but not among its tips is the rewind signature — a delta walk
	 * from it would re-walk old history for nothing, so it short-circuits to
	 * the rebuild. */
	async function planWalk(
		pinned: Kysely<Database>,
		id: ReposId,
		tips: string[],
		epoch: Epoch | null,
	): Promise<{ live: readonly string[]; plan: EpochPlan }> {
		if (epoch !== null) {
			const stopAt = new Set(epoch.tips)
			const deltaEligible = tips.every(
				(t) => stopAt.has(t) || positionOf(epoch.oids, t) === -1,
			)
			if (deltaEligible) {
				const walk = await originClosure(pinned, id, tips, stopAt, "retain")
				if (walk.missing.size > 0 || walk.violations.size > 0) return withheld(walk)
				const advanced = buildAdvanced(tips, epoch, walk)
				if (advanced.state === "ready") {
					return { live: advanced.live, plan: advanced.plan }
				}
			}
		}
		const walk = await originClosure(pinned, id, tips, new Set(), "retain")
		if (walk.missing.size > 0 || walk.violations.size > 0) return withheld(walk)
		const oids = concatSortedOids(walk.masks.keys())
		const bitmaps = new Map<string, Uint8Array>()
		for (const [tip, positions] of maskPositions(tips, walk, oids)) {
			bitmaps.set(tip, bitmapFromPositions(positions))
		}
		return {
			live: [...walk.masks.keys()],
			plan: {
				bitmaps,
				epoch: (epoch?.epoch ?? 0) + 1,
				oids,
				outcome: "rebuilt",
				tips,
			},
		}
	}

	/** A walk that reported MISSING objects or typed-edge VIOLATIONS (a ref
	 * whose closure is incomplete or malformed) must never publish an epoch: a
	 * bitmap serve answers with `missing: ∅` by construction, so a partial
	 * epoch would convert a detectable defect into a silently short pack. The
	 * stored epoch is dropped too — its guards cannot vouch for a repo in this
	 * state. The pass still sweeps with the walked live set, which under
	 * "retain" keeps every EXISTING object any edge names — a malformed edge
	 * must never make a validly-referenced object sweepable. */
	function withheld(walk: OriginWalk): { live: readonly string[]; plan: EpochPlan } {
		return { live: [...walk.masks.keys()], plan: { outcome: "cleared" } }
	}

	/** The steady-state epoch: new array = old ∪ walk delta; each tip's bitmap
	 * = its walk mask ∪ the REMAPPED bitmaps of every old tip its walk hit.
	 * Returns `rebuild` when a hit tip's bitmap row is gone
	 * (cascaded mid-rewind) or the covered check fails: an old tip neither hit
	 * nor inside the new live set means the closure genuinely shrank (a
	 * deleted or rewound ref), and keeping its objects would leak them forever. */
	function buildAdvanced(tips: string[], epoch: Epoch, walk: OriginWalk): AdvanceAttempt {
		const freshOids = [...walk.masks.keys()].filter(
			(oid) => positionOf(epoch.oids, oid) === -1,
		)
		const oids = concatSortedOids([...splitOids(epoch.oids), ...freshOids])
		const bitmaps = new Map<string, Uint8Array>()
		for (const [tip, positions] of maskPositions(tips, walk, oids)) {
			const bit = 1n << BigInt(tips.indexOf(tip))
			for (const [stop, bits] of walk.hits) {
				if ((bits & bit) === 0n) continue
				const priorBitmap = epoch.bitmaps.get(stop)
				if (priorBitmap === undefined) return { state: "rebuild" }
				positions.push(...remapPositions(priorBitmap, epoch.oids, oids))
			}
			bitmaps.set(tip, bitmapFromPositions(positions))
		}
		for (const oldTip of epoch.tips) {
			if (walk.hits.has(oldTip)) continue
			const position = positionOf(oids, oldTip)
			if (position === -1 || !unionHas(bitmaps.values(), position)) {
				return { state: "rebuild" }
			}
		}
		return {
			live: splitOids(oids),
			plan: {
				bitmaps,
				epoch: epoch.epoch + 1,
				oids,
				outcome: "advanced",
				tips,
			},
			state: "ready",
		}
	}

	/** Each present tip's walk-mask positions against `oids`. Hit remaps are the
	 * caller's to append — a full walk has none. */
	function maskPositions(
		tips: string[],
		walk: OriginWalk,
		oids: Buffer,
	): Map<string, number[]> {
		const positionsByTip = new Map<string, number[]>()
		for (let i = 0; i < tips.length; i++) {
			const tip = tips[i] as string
			const bit = 1n << BigInt(i)
			const positions: number[] = []
			for (const [oid, bits] of walk.masks) {
				if (bits & bit) positions.push(positionOf(oids, oid))
			}
			positionsByTip.set(tip, positions)
		}
		return positionsByTip
	}

	/** Set equality of two SORTED, DEDUPLICATED hex arrays. */
	function sameSortedOids(left: readonly string[], right: readonly string[]): boolean {
		return (
			left.length === right.length && left.every((oid, index) => oid === right[index])
		)
	}

	/** A Kysely pinned to a single porsager connection: its dialect `reserve()`s the
	 * same connection for every statement (so a multi-statement read shares one MVCC
	 * snapshot) and `release()` is a no-op (the caller owns the connection's lifetime).
	 * The shim is a callable with a `reserve` property, the shape the dialect probes
	 * for (`isPostgresJSSql`). */
	function pinnedKysely(connection: ReservedSql): Kysely<Database> {
		// The dialect only ever calls `.unsafe(sql, params)` then `.release()` on the
		// reserved connection — so hand it the real connection for `.unsafe` but swallow
		// `.release()` (a no-op), keeping the connection pinned across every closure
		// statement. The caller releases it exactly once when the snapshot is done.
		const nonReleasing = new Proxy(connection, {
			get: (target, prop) =>
				prop === "release" ? () => {} : Reflect.get(target, prop, target),
		})
		const handle = new Proxy(connection, {
			get: (target, prop) =>
				prop === "reserve" ? async () => nonReleasing : Reflect.get(target, prop, target),
			has: (target, prop) => prop === "reserve" || Reflect.has(target, prop),
		})
		return initKysely<Database>(handle)
	}

	/** Bulk-load the live OID set into the session's TEMP table via binary COPY
	 * (`copyInto`, the bytea-safe bulk primitive — no staging and no transaction:
	 * the oids are already unique, and each COPY is one statement), batched so the
	 * JS payload stays bounded. */
	async function loadLive(
		connection: ReservedSql,
		oids: readonly string[],
	): Promise<void> {
		const all = oids
		for (let i = 0; i < all.length; i += LIVE_LOAD_BATCH) {
			const chunk = all.slice(i, i + LIVE_LOAD_BATCH)
			await copyInto(
				connection,
				LIVE_TABLE,
				["oid"],
				chunk.map((hex) => [{ t: "bytea", v: Buffer.from(hex, "hex") }]),
			)
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
		connection: ReservedSql,
		id: ReposId,
		graceSeconds: number,
		batchLimit: number,
	): Promise<number> {
		let total = 0
		for (;;) {
			const deleted = await connection.unsafe<{ n: number }[]>(
				`with victims as (
					select o.oid from git_object o
					where o.repo_id = $1::bigint
						and not exists (select 1 from ${LIVE_TABLE} l where l.oid = o.oid)
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

	/** Post-sweep maintenance (best-effort): reclaim the dead tuples GC produced in
	 * the heap + TOAST and refresh planner stats. `VACUUM` cannot run inside a
	 * transaction block, so these are standalone statements run outside any txn.
	 * The table list is exactly what the sweep DELETEs touch: `git_object` directly,
	 * `git_pack_encoding` through the 0008 cascades (its rows die with their objects
	 * and bases, so its dead tuples are this pass's too). `git_commit`/`git_tag`
	 * cascade-churn as well but are bytes-tiny and
	 * PK-only; their leaf autovacuum (0009's delete-aware profile) is enough. */
	async function maintain(connection: ReservedSql): Promise<void> {
		// On the pass's RESERVED connection (between transactions — VACUUM cannot
		// run inside one): borrowing through the pool here self-deadlocks at
		// `max: 1`, where the reserved connection IS the pool.
		await connection.unsafe(`vacuum (analyze) git_object`)
		await connection.unsafe(`vacuum (analyze) git_pack_encoding`)
	}
}

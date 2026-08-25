import { deflateSync } from "node:zlib"
import type { Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { type CopyValue, copyInsert } from "@/database/copy-insert"
import type { ReposId } from "@/database/models/public/Repos"
import { isTreeEntryMode } from "@/object/object"
import { indexTreeEntries, pairTreeEntries } from "@/object/tree-diff"
import { DELTA_SIZE_MIN, encodeDelta } from "@/pack/delta"
import { lookupRepoId } from "@/store/repo-resolver"

/**
 * Per-repo offline repack — the producer of the DERIVED pack-encoding tier
 * (`git_pack_encoding`, migration 0008; the design and its provenance:
 * docs/2026-08-15-delta-pack-design.md). The sibling of `store/gc.ts` in every
 * structural respect: built over a porsager client at the wire→DB boundary,
 * invoked per repo by the GC drain's repack phase (`store/gc-scheduler.ts`) or a
 * host's own maintenance schedule, never on the push/fetch hot path.
 *
 * What one pass produces, and the invariants the e2e suite pins:
 *
 * - **Coverage.** Every `git_object` row (under {@link MAX_INLINE_BYTEA_BYTES}) ends
 *   up with exactly one encoding row: `deflate(delta vs its anchor)` for a tree in
 *   a lineage when the delta wins, `deflate(raw)` otherwise. `data_size` is the
 *   inflated length of what `data` holds — the delta PROGRAM's length for a delta
 *   row, the object's size for a whole row (the pack header varint needs exactly
 *   this).
 * - **Star topology, depth ≤ 1** (design D2). A lineage — successive versions of
 *   one path, recovered by walking commits oldest-first and diffing each root tree
 *   against its FIRST parent's — is segmented by anchors: a version whose
 *   predecessor's anchor already carries {@link ANCHOR_EVERY}−1 deltas becomes the
 *   next anchor (stored whole); every other version deltas against its segment's
 *   anchor. A delta's base is therefore always a WHOLE encoding; no chain forms,
 *   in any pass, because the anchor is looked up through the PREDECESSOR'S stored
 *   row rather than recomputed.
 * - **Frozen, deterministic base policy** (design D4). Commits walk in
 *   deterministic topological order (ties by oid), bases finalize before their
 *   dependents, and an object that already has an encoding row is never touched
 *   again: a pass over an unchanged repo reads the pending set, finds it empty,
 *   and writes nothing.
 * - **Derived, never authoritative** (design D1). `git_object` stays the object
 *   inventory and raw-content authority. Absence of an encoding row is normal
 *   (serve falls back to raw); this pass only ever ADDS rows.
 * - **Repair mode** (design D15). The 0008 FK cascades can hole the tier: a live
 *   delta's row dies with its reclaimed base. Holed objects re-enter the pending
 *   set, but the lineage walk prunes at covered trees, so a holed SUBTREE under a
 *   covered root would only ever be swept up WHOLE by phase 2 — permanently, since
 *   rows are never rewritten (D4). So when any pending object PREDATES the repo's
 *   last completed pass (it can only be a hole — new pushes are newer than the
 *   stamp), the walk ignores the covered-tree prune for RECURSION only: covered
 *   rows are never re-emitted, but the walk descends through them to re-delta the
 *   holes against their surviving anchors.
 *
 * Scheduling: repack stamps its own `repos.last_repack_at` watermark on success —
 * the pass-START `clock_timestamp()`, so an object ingested mid-pass (invisible to
 * this pass's reads) stays newer than the stamp and the next pass treats it as
 * ordinary new work, never as a hole. Any invoker that runs both maintenance
 * passes must serialize repack per repo AFTER GC (D5) so it encodes survivors,
 * not garbage — the built-in drain (`store/gc-scheduler.ts`, eligibility
 * `last_pushed_at > last_repack_at`) does exactly this; a host may also invoke
 * `repack()` directly on its own schedule.
 */

/** Anchor cadence: a segment holds one whole anchor plus at most K−1 deltas
 * against it. K=32 sits at the measured size optimum (≈√N) on the motivating
 * repo — see docs/2026-08-15-delta-pack-design.md D2 before changing it. */
export const ANCHOR_EVERY = 32

/** Encoding rows per COPY round-trip when writing a pass's output. */
const WRITE_BATCH = 1000

/** Content bytes fetched per round-trip when reading pending objects. */
const READ_BATCH_BYTES = 16_000_000

/** Oids per read round-trip. `oid in ${pg(list)}` spends one bind parameter per
 * oid and the extended protocol caps a statement at 65,534, so the sweep must
 * bound itself by COUNT as well as bytes: many small objects hit this cap, few
 * large ones hit the byte cap. Sized like GC's LIVE_LOAD_BATCH (bulk offline
 * path), not the serve path's PACK_BATCH. */
const READ_BATCH_OIDS = 10_000

/** What one repack pass wrote. `deltas` counts encodings that reference a base;
 * `wholes` counts self-contained encodings (anchors, non-tree objects, and trees
 * whose delta lost to their whole form). A pass over an already-covered repo
 * returns all zeros. */
export type RepackResult = { wholes: number; deltas: number }

export type Repack = ReturnType<typeof createRepack>

/** A pending object: present in the inventory, no encoding row yet. `stale` marks
 * one created BEFORE the repo's last completed pass — possible only for a hole the
 * FK cascades punched (D15), since anything pushed after that pass is newer. */
type Pending = { oid: string; type: number; size: number; stale: boolean }

/** An existing (or this-pass) encoding, as much of it as the policy reads. */
type EncodingShape = { baseOid: string | null }

/**
 * Build the repack over a porsager client (the same boundary the object store and
 * GC take). `repack(repo)` brings a single repo's encoding tier to coverage,
 * offline; it never blocks or alters the raw serve path.
 */
export function createRepack(pg: Sql) {
	const db = initKysely<Database>(pg)

	return {
		async repack(repo: string): Promise<RepackResult> {
			// A name never written has nothing to encode. Resolved fresh every pass — a
			// long-lived Repack outlives repo delete/re-create cycles (lookupRepoId).
			const id = await lookupRepoId(db, repo)
			if (id === null) return { deltas: 0, wholes: 0 }

			// The watermark this pass will stamp on success: captured BEFORE the pending
			// read (see the module doc's Scheduling note for why start, not end).
			const [startedAt] = await pg<{ timestamp: Date }[]>`
				select clock_timestamp() as timestamp`
			if (!startedAt) throw new Error("pggit repack: clock_timestamp returned no row")

			// The pending set: inventory minus encodings. Objects past the driver-safe
			// cap are excluded by design (see MAX_INLINE_BYTEA_BYTES). `stale` is judged
			// against the repo's last stamp — false on a never-repacked repo, where the
			// ordinary walk already visits everything.
			const pending = await pg<Pending[]>`
				select encode(o.oid, 'hex') as oid, o.type, o.size,
					coalesce(o.created_at < r.last_repack_at, false) as stale
				from git_object o
				join repos r on r.id = o.repo_id
				where o.repo_id = ${id}::bigint
					and o.size < ${MAX_INLINE_BYTEA_BYTES}
					and not exists (
						select 1 from git_pack_encoding e
						where e.repo_id = o.repo_id and e.oid = o.oid
					)`
			const stamp = async (): Promise<void> => {
				await pg`update repos set last_repack_at = ${startedAt.timestamp} where id = ${id}::bigint`
			}
			if (pending.length === 0) {
				await stamp()
				return { deltas: 0, wholes: 0 }
			}
			const pendingByOid = new Map(pending.map((p) => [p.oid, p]))

			// D15 repair: a stale pending object is a hole the FK cascades punched out
			// of the tier. This pass walks THROUGH covered trees (recursion only) so
			// holes re-delta against their surviving anchors instead of falling to the
			// phase-2 whole sweep forever.
			const repair = pending.some((p) => p.stale)

			// Existing policy state, loaded once: each encoded oid's base (to find a
			// predecessor's anchor) and each anchor's current segment fill.
			const encoded = new Map<string, EncodingShape>()
			const segmentFill = new Map<string, number>()
			const existing = await pg<{ oid: string; base_oid: string | null }[]>`
				select encode(oid, 'hex') as oid, encode(base_oid, 'hex') as base_oid
				from git_pack_encoding where repo_id = ${id}::bigint`
			for (const row of existing) {
				encoded.set(row.oid, { baseOid: row.base_oid })
				if (row.base_oid !== null) {
					segmentFill.set(row.base_oid, (segmentFill.get(row.base_oid) ?? 0) + 1)
				}
			}

			// Content reads are on-demand and cached for the pass: the diff walk and the
			// encoder revisit the same trees, and the pass's working set is bounded by
			// the repo's tree bytes (an offline job's budget, not a request's).
			const contentCache = new Map<string, Buffer>()
			const content = async (oid: string): Promise<Buffer> => {
				const cached = contentCache.get(oid)
				if (cached) return cached
				const [row] = await pg<{ content: Buffer }[]>`
					select content from git_object
					where repo_id = ${id}::bigint and oid = ${Buffer.from(oid, "hex")}`
				if (!row) throw new Error(`pggit repack: object ${oid} vanished mid-pass`)
				contentCache.set(oid, row.content)
				return row.content
			}

			// Output accumulator → batched COPY inserts.
			let wholes = 0
			let deltas = 0
			let batch: CopyValue[][] = []
			const flush = async (): Promise<void> => {
				if (batch.length === 0) return
				const rows = batch
				batch = []
				await pg.begin(async (tx) => {
					await copyInsert(
						tx,
						"git_pack_encoding",
						["repo_id", "oid", "base_oid", "data_size", "data"],
						rows,
					)
				})
			}
			const emit = async (
				oid: string,
				baseOid: string | null,
				dataSize: number,
				data: Buffer,
			): Promise<void> => {
				batch.push([
					{ t: "int8", v: id },
					{ t: "bytea", v: Buffer.from(oid, "hex") },
					baseOid === null
						? { t: "bytea", v: null }
						: { t: "bytea", v: Buffer.from(baseOid, "hex") },
					{ t: "int4", v: dataSize },
					{ t: "bytea", v: data },
				])
				encoded.set(oid, { baseOid })
				pendingByOid.delete(oid)
				if (baseOid === null) wholes++
				else {
					deltas++
					segmentFill.set(baseOid, (segmentFill.get(baseOid) ?? 0) + 1)
				}
				if (batch.length >= WRITE_BATCH) await flush()
			}
			const emitWhole = async (oid: string, raw: Buffer): Promise<void> => {
				await emit(oid, null, raw.length, deflateSync(raw))
			}

			// ── Phase 1: tree lineages, via the commit graph ─────────────────────
			// Walk commits oldest-first (deterministic topo order) and, for each commit
			// whose ROOT tree is pending, diff it against its first parent's root: every
			// changed tree pairs with its same-path predecessor. Encoding happens inside
			// the walk, so a predecessor's row always exists before its dependent's.
			for (const { treeOid, parentTreeOid } of await commitDiffOrder(id)) {
				await encodeTreePair(treeOid, parentTreeOid)
			}

			// A changed tree pairs with its predecessor and deltas against the segment
			// anchor the predecessor's row names — or opens a new segment when that
			// anchor is full or the delta loses to the whole form.
			async function encodeTreePair(
				treeOid: string,
				parentTreeOid: string | null,
			): Promise<void> {
				if (treeOid === parentTreeOid) return
				// A covered tree prunes the walk — every descendant was covered with it —
				// EXCEPT in repair mode, where a hole may hide below it (D15): then the
				// walk descends through covered trees but still never re-emits them.
				if (!repair && !pendingByOid.has(treeOid)) return
				const current = indexTreeEntries(await content(treeOid))

				// Recurse into changed subtrees FIRST, pairing by entry NAME (git's
				// structural unit): same directory name on both sides, different oid.
				// POST-ORDER — children's rows land before their root's — so any crash
				// prefix is subtree-closed and the covered-tree prune above stays safe
				// across an interrupted pass: a covered tree really does imply covered
				// descendants, whatever flush boundary a crash landed on. (Emitting the
				// root first made the opposite briefly true on disk, and a resumed pass
				// would prune at the covered root and orphan its pending children to
				// phase-2 whole encodings, permanently — D15's stamp cannot see a
				// crashed pass, which never stamped.) Anchor choices are unaffected:
				// a delta's anchor comes from its PREDECESSOR's stored row (an earlier
				// commit's walk), never from this commit's own emit order.
				if (parentTreeOid !== null) {
					const previous = indexTreeEntries(await content(parentTreeOid))
					for (const pair of pairTreeEntries(previous, current)) {
						if (
							pair.state === "paired" &&
							isTreeEntryMode(pair.before.mode) &&
							isTreeEntryMode(pair.after.mode) &&
							pair.before.oid !== pair.after.oid
						) {
							await encodeTreePair(pair.after.oid, pair.before.oid)
						}
					}
				}

				if (pendingByOid.has(treeOid)) {
					const raw = current.content
					const predecessor = parentTreeOid ? encoded.get(parentTreeOid) : undefined
					if (predecessor !== undefined && parentTreeOid !== null) {
						const anchor = predecessor.baseOid ?? parentTreeOid
						if ((segmentFill.get(anchor) ?? 0) < ANCHOR_EVERY - 1) {
							const delta = encodeDelta(await content(anchor), raw)
							const deflated = deflateSync(delta)
							const whole = deflateSync(raw)
							// git's own rule: keep a delta only when it beats the whole form —
							// and never one under 4 bytes (DELTA_SIZE_MIN): a stored delta is
							// served VERBATIM as a REF_DELTA, and git's patch-delta rejects
							// sub-minimum programs, so an empty-target delta would be
							// client-fatal on the wire.
							if (delta.length >= DELTA_SIZE_MIN && deflated.length < whole.length) {
								await emit(treeOid, anchor, delta.length, deflated)
							} else {
								await emit(treeOid, null, raw.length, whole)
							}
						} else {
							await emitWhole(treeOid, raw) // segment full — this version anchors
						}
					} else {
						await emitWhole(treeOid, raw) // no predecessor — first version anchors
					}
				}
			}

			// ── Phase 2: coverage sweep — everything still pending ships whole ───
			// Non-tree objects, trees with no same-path predecessor (new directories,
			// non-first-parent lineages), and GC-repaired holes. Batched by bytes.
			let sweep: Pending[] = []
			let sweepBytes = 0
			const flushSweep = async (): Promise<void> => {
				if (sweep.length === 0) return
				// `in ${pg(list)}` — porsager's value-list expansion; a bare `= any(${list})`
				// serializes the Buffer[] as one value, not an array.
				const rows = await pg<{ oid: string; content: Buffer }[]>`
					select encode(oid, 'hex') as oid, content from git_object
					where repo_id = ${id}::bigint
						and oid in ${pg(sweep.map((p) => Buffer.from(p.oid, "hex")))}`
				for (const row of rows) await emitWhole(row.oid, row.content)
				sweep = []
				sweepBytes = 0
			}
			for (const p of [...pendingByOid.values()]) {
				sweep.push(p)
				sweepBytes += p.size
				if (sweepBytes >= READ_BATCH_BYTES || sweep.length >= READ_BATCH_OIDS) {
					await flushSweep()
				}
			}
			await flushSweep()
			await flush()

			// Success only: a failed pass leaves the stamp alone, so the next pass
			// still sees everything this one owed as stale and repairs it.
			await stamp()
			return { deltas, wholes }
		},
	}

	/**
	 * The commit walk, precomputed: every commit's root tree beside its FIRST
	 * parent's root tree (null for a root commit or a parent GC has removed), in
	 * deterministic oldest-first topological order (Kahn; ties broken by oid).
	 * Parent ORDER is first-class in `git_commit.parents`; the walk reads it
	 * directly from the derived commit rows.
	 */
	async function commitDiffOrder(
		id: ReposId,
	): Promise<{ treeOid: string; parentTreeOid: string | null }[]> {
		const commits = await pg<{ oid: string; tree: string; parents: string[] }[]>`
			select encode(c.oid, 'hex') as oid, encode(c.tree_oid, 'hex') as tree,
				(select coalesce(array_agg(encode(p.h, 'hex') order by p.ord), '{}')
					from unnest(c.parents) with ordinality as p(h, ord)) as parents
			from git_commit c where c.repo_id = ${id}::bigint`
		const parsed = new Map(
			commits.map((c) => [c.oid, { parents: c.parents, tree: c.tree }] as const),
		)

		// Kahn over the parent relation, restricted to parents that still exist (a
		// force-push + GC can leave a reachable commit whose parent is gone — that
		// commit simply diffs against nothing).
		const indegree = new Map<string, number>()
		const children = new Map<string, string[]>()
		for (const [oid, p] of parsed) {
			const present = p.parents.filter((parent) => parsed.has(parent))
			indegree.set(oid, present.length)
			for (const parent of present) {
				const slot = children.get(parent)
				if (slot) slot.push(oid)
				else children.set(parent, [oid])
			}
		}
		const ready = [...indegree.entries()]
			.filter(([, n]) => n === 0)
			.map(([oid]) => oid)
			.sort()
		const order: { treeOid: string; parentTreeOid: string | null }[] = []
		while (ready.length > 0) {
			const oid = ready.shift() as string
			const p = parsed.get(oid)
			if (!p) throw new Error(`pggit repack: no commit row for queued oid ${oid}`)
			const firstParent = p.parents.find((parent) => parsed.has(parent))
			const parent = firstParent === undefined ? undefined : parsed.get(firstParent)
			if (firstParent !== undefined && parent === undefined) {
				throw new Error(`pggit repack: no commit row for parent ${firstParent}`)
			}
			order.push({
				parentTreeOid: parent === undefined ? null : parent.tree,
				treeOid: p.tree,
			})
			const next: string[] = []
			for (const child of children.get(oid) ?? []) {
				const childIndegree = indegree.get(child)
				if (childIndegree === undefined) {
					throw new Error(`pggit repack: no indegree for child ${child}`)
				}
				const n = childIndegree - 1
				indegree.set(child, n)
				if (n === 0) next.push(child)
			}
			// Newly-ready commits join in sorted position to keep the order stable.
			if (next.length > 0) {
				ready.push(...next)
				ready.sort()
			}
		}
		if (order.length !== parsed.size) {
			throw new Error(
				`pggit repack: ${parsed.size - order.length} commits form a parent cycle`,
			)
		}
		return order
	}
}

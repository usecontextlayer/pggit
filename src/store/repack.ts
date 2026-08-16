import { deflateSync } from "node:zlib"
import type { Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import { type CopyValue, copyInsert } from "@/database/copy-insert"
import type { ReposId } from "@/database/models/public/Repos"
import { commitParents, commitTreeOid, treeEntries } from "@/object/object"
import { encodeDelta } from "@/pack/delta"
import { PACK_OBJ_TYPE } from "@/pack/object-header"
import { createRepoResolver } from "@/store/repo-resolver"

/**
 * Per-repo offline repack — the producer of the DERIVED pack-encoding tier
 * (`git_pack_encoding`, migration 0008; the design and its provenance:
 * docs/2026-08-15-delta-pack-design.md). The sibling of `store/gc.ts` in every
 * structural respect: built over a porsager client at the wire→DB boundary,
 * invoked per repo by the background drain, never on the push/fetch hot path.
 *
 * What one pass produces, and the invariants the e2e suite pins:
 *
 * - **Coverage.** Every `git_object` row (under {@link MAX_ENCODABLE_BYTES}) ends
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
 *   (serve falls back to raw); this pass only ever ADDS rows. Repairing GC damage
 *   needs no special path: GC's own sweep (D7) deletes a reclaimed object's
 *   encoding and any delta whose base it removed, so those objects simply
 *   re-enter the pending set here and are re-encoded whole.
 *
 * Scheduling: the drain gives repack its own `repos.last_repack_at` watermark
 * (same pattern as `last_gc_at`), serialized per repo AFTER GC so it encodes
 * survivors, not garbage.
 */

/** Anchor cadence: a segment holds one whole anchor plus at most K−1 deltas
 * against it. K=32 sits at the measured size optimum (≈√N) on the motivating
 * repo — see docs/2026-08-15-delta-pack-design.md D2 before changing it. */
export const ANCHOR_EVERY = 32

/**
 * Objects at/over this size get NO encoding row: the porsager driver decodes a
 * `bytea` result as `\x`+hex (double the bytes), so reading a value this large
 * back out of the encoding table would hit the same V8 string cap the object
 * store's chunked reader exists for (object-store.ts BIG_OBJECT_BYTES) — and the
 * serve path already handles encoding-less objects via that chunked fallback.
 */
const MAX_ENCODABLE_BYTES = 200_000_000

/** Encoding rows per COPY round-trip when writing a pass's output. */
const WRITE_BATCH = 1000

/** Content bytes fetched per round-trip when reading pending objects. */
const READ_BATCH_BYTES = 16_000_000

/** What one repack pass wrote. `deltas` counts encodings that reference a base;
 * `wholes` counts self-contained encodings (anchors, non-tree objects, and trees
 * whose delta lost to their whole form). A pass over an already-covered repo
 * returns all zeros. */
export type RepackResult = { wholes: number; deltas: number }

export type Repack = ReturnType<typeof createRepack>

/** A pending object: present in the inventory, no encoding row yet. */
type Pending = { oid: string; type: number; size: number }

/** An existing (or this-pass) encoding, as much of it as the policy reads. */
type EncodingShape = { baseOid: string | null }

/**
 * Build the repack over a porsager client (the same boundary the object store and
 * GC take). `repack(repo)` brings a single repo's encoding tier to coverage,
 * offline; it never blocks or alters the raw serve path.
 */
export function createRepack(pg: Sql) {
	const db = initKysely<Database>(pg)
	const repos = createRepoResolver(db)

	return {
		async repack(repo: string): Promise<RepackResult> {
			// A name never written has nothing to encode.
			const id = await repos.resolveRepoId(repo)
			if (id === null) return { deltas: 0, wholes: 0 }

			// The pending set: inventory minus encodings. Objects past the driver-safe
			// cap are excluded by design (see MAX_ENCODABLE_BYTES).
			const pending = await pg<Pending[]>`
				select encode(o.oid, 'hex') as oid, o.type, o.size
				from git_object o
				where o.repo_id = ${id}::bigint
					and o.size < ${MAX_ENCODABLE_BYTES}
					and not exists (
						select 1 from git_pack_encoding e
						where e.repo_id = o.repo_id and e.oid = o.oid
					)`
			if (pending.length === 0) return { deltas: 0, wholes: 0 }
			const pendingByOid = new Map(pending.map((p) => [p.oid, p]))

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
				if (!pendingByOid.has(treeOid)) return
				const raw = await content(treeOid)

				const predecessor = parentTreeOid ? encoded.get(parentTreeOid) : undefined
				if (predecessor !== undefined && parentTreeOid !== null) {
					const anchor = predecessor.baseOid ?? parentTreeOid
					if ((segmentFill.get(anchor) ?? 0) < ANCHOR_EVERY - 1) {
						const delta = encodeDelta(await content(anchor), raw)
						const deflated = deflateSync(delta)
						const whole = deflateSync(raw)
						// git's own rule: keep a delta only when it beats the whole form.
						if (deflated.length < whole.length) {
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

				// Recurse into changed subtrees, pairing by entry NAME (git's structural
				// unit): same directory name on both sides, different oid.
				if (parentTreeOid === null) return
				const before = new Map(
					treeEntries(await content(parentTreeOid))
						.filter((e) => e.mode === "40000")
						.map((e) => [e.name, e.oid]),
				)
				for (const entry of treeEntries(raw)) {
					if (entry.mode !== "40000") continue
					const prior = before.get(entry.name)
					if (prior !== undefined && prior !== entry.oid) {
						await encodeTreePair(entry.oid, prior)
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
				if (sweepBytes >= READ_BATCH_BYTES) await flushSweep()
			}
			await flushSweep()
			await flush()

			return { deltas, wholes }
		},
	}

	/**
	 * The commit walk, precomputed: every commit's root tree beside its FIRST
	 * parent's root tree (null for a root commit or a parent GC has removed), in
	 * deterministic oldest-first topological order (Kahn; ties broken by oid).
	 * Parent ORDER lives only in commit content — `git_edge` kind-2 rows are a
	 * set — so the walk parses the commits themselves (small, header-only reads).
	 */
	async function commitDiffOrder(
		id: ReposId,
	): Promise<{ treeOid: string; parentTreeOid: string | null }[]> {
		const commits = await pg<{ oid: string; content: Buffer }[]>`
			select encode(oid, 'hex') as oid, content from git_object
			where repo_id = ${id}::bigint and type = ${PACK_OBJ_TYPE.COMMIT}`
		const byOid = new Map(commits.map((c) => [c.oid, c]))
		const parsed = new Map<string, { tree: string; parents: string[] }>()
		for (const c of commits) {
			parsed.set(c.oid, {
				parents: commitParents(c.content),
				tree: commitTreeOid(c.content),
			})
		}

		// Kahn over the parent relation, restricted to parents that still exist (a
		// force-push + GC can leave a reachable commit whose parent is gone — that
		// commit simply diffs against nothing).
		const indegree = new Map<string, number>()
		const children = new Map<string, string[]>()
		for (const [oid, p] of parsed) {
			const present = p.parents.filter((parent) => byOid.has(parent))
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
			if (!p) continue
			const firstParent = p.parents.find((parent) => byOid.has(parent))
			order.push({
				parentTreeOid: firstParent ? (parsed.get(firstParent)?.tree ?? null) : null,
				treeOid: p.tree,
			})
			const next: string[] = []
			for (const child of children.get(oid) ?? []) {
				const n = (indegree.get(child) ?? 1) - 1
				indegree.set(child, n)
				if (n === 0) next.push(child)
			}
			// Newly-ready commits join in sorted position to keep the order stable.
			if (next.length > 0) {
				ready.push(...next)
				ready.sort()
			}
		}
		return order
	}
}

import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { sql } from "kysely"
import type { Sql } from "postgres"
import { type Database, initKysely } from "@/database"
import { type CopyValue, copyInsert } from "@/database/copy-insert"
import type { ReposId } from "@/database/models/public/Repos"
import { OBJECT_TYPE_CODE, objectTypeFromCode } from "@/database/object-type-codes"
import { count, withPhase } from "@/instrument"
import { computeGenerations } from "@/object/commit-graph"
import { deriveCommitRow, deriveTagRow, validateObject } from "@/object/derive"
import { computeOid, type GitObjectType } from "@/object/object"
import { encodeDelta } from "@/pack/delta"
import { encodeObjectHeader, PACK_OBJ_TYPE, type PackObjType } from "@/pack/object-header"
import { readPack } from "@/pack/read-pack"
import { type PackInputObject, packHeader, writePack } from "@/pack/write-pack"
import { WantNotFoundError } from "@/protocol/errors"
import { ancestry, originClosure, routeServeSet } from "@/store/reachability"
import { createRepoResolver, type RepoResolver } from "@/store/repo-resolver"

/** Objects fetched per round-trip when streaming content into a served pack. */
const PACK_BATCH = 1000

/**
 * A stored object at/over this size is read in size-bounded chunks, never in one
 * round-trip. The porsager driver decodes a `bytea` RESULT from its text form
 * (`\x` + hex, DOUBLE the byte length), so a value over ~256MiB would build a JS
 * string past V8's max length and throw on the SERVE path — the read-side mirror of
 * the ingest string-cap that binary COPY fixed (a07/blb01). Kept well under the cap
 * so the doubled hex of a single chunk stays safely below it.
 */
const BIG_OBJECT_BYTES = 200_000_000
const READ_CHUNK_BYTES = 100_000_000

/** Split `items` into consecutive batches of at most `size`. */
function batches<T>(items: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
	return out
}

export type StoredObject = {
	type: GitObjectType
	content: Buffer
}

export type ObjectStore = ReturnType<typeof createObjectStore>

/**
 * Postgres-backed git object store. Each immutable object is one row in the
 * per-repo, HASH-partitioned `git_object` (raw 20-byte `bytea` OID, pack type
 * code, raw inflated body lz4-TOASTed Postgres-side) — packs are a transport
 * encoding produced on serve and consumed on ingest, never stored. So a fetch is
 * a primary-key point-read, not a whole-pack re-inflate.
 *
 * The store is the wire→DB boundary: callers speak hex OIDs and the wire repo
 * name; OIDs are coerced hex↔raw here, and the repo name is resolved to its
 * bigint surrogate (memoized) here.
 */
export function createObjectStore(pg: Sql, repoResolver?: RepoResolver) {
	const db = initKysely<Database>(pg)
	const repos = repoResolver ?? createRepoResolver(db)

	const store = {
		/**
		 * Build the served pack for a fetch: the want-closure minus the have-closure,
		 * re-adding the explicit wants (promisor lazy-fetch roots — a partial clone may
		 * want a blob reachable from a tree it already has, so it must not be
		 * subtracted). The object count is known from the closure before any content is
		 * read; content then streams in keyset batches into the pack encoder, so only
		 * one batch of inflated content is ever held (never the whole repo).
		 */
		async buildPack(
			repoId: string,
			wants: string[],
			haves: string[],
			omitBlobs: boolean,
			includeTag = false,
			thinPack = false,
		): Promise<Buffer> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null || wants.length === 0) return writePack([])

			const route = await withPhase("closure", async () => {
				// The one routed entry (spine chunk 2/R4): the router type-dispatches
				// wants, peels tag chains, sends have-ful commit fetches through the
				// frontier, and keeps have-less requests on the full closure. An exact
				// blob want is served even under a blob filter — the promisor rule —
				// because the router adds it unconditionally, never by subtraction.
				const routed = await routeServeSet(db, id, wants, haves, omitBlobs)
				// A want whose closure is incomplete cannot be served (git rejects it
				// too) — fail loud rather than ship a short pack. Missing WANTS lead the
				// list (the error's capped message shows the head, and git's own ERR
				// names the want); the rest sorted, so the message is deterministic.
				if (routed.missing.size > 0) {
					const missingWants = wants.filter((w) => routed.missing.has(w))
					const lead = new Set(missingWants)
					const rest = [...routed.missing].filter((o) => !lead.has(o)).sort()
					throw new WantNotFoundError([...missingWants, ...rest])
				}
				if (includeTag) await augmentWithTags(id, routed.served)
				return routed
			})
			const served = [...route.served]

			return withPhase("pack-encode", async () => {
				const hash = createHash("sha1")
				const parts: Buffer[] = []
				const push = (chunk: Buffer) => {
					hash.update(chunk)
					parts.push(chunk)
				}
				push(packHeader(served.length))
				// Which deltas may ship AS deltas (D8′): base in this pack, or — under a
				// negotiated thin-pack — provably client-held (`clientHas`). Otherwise
				// the object falls back to its whole form.
				const servedSet = route.served
				const { clientHas, warmBases } = route
				// Emit non-deltas FIRST: a delta's base is always a whole encoding
				// (depth ≤ 1, D2), so this ordering guarantees every REF_DELTA's base
				// precedes it in the stream — legal either way in a self-contained pack,
				// but a stream whose deltas all dangle until the end forces worst-case
				// client buffering (the closure's discovery order is newest-first, which
				// is exactly that pathological order).
				const deltaOids = new Set<string>()
				for (const batch of batches(served, PACK_BATCH)) {
					const rows = await pg<{ oid: string }[]>`
						select encode(oid, 'hex') as oid from git_pack_encoding
						where repo_id = ${id}::bigint and base_oid is not null
							and oid in ${pg(batch.map((h) => Buffer.from(h, "hex")))}`
					for (const r of rows) deltaOids.add(r.oid)
				}
				// Warm-delta candidates (R9) sit in the delta segment too — ordering
				// only; whether each actually ships as a delta is decided at emit.
				if (thinPack) {
					for (const t of warmBases.keys()) if (servedSet.has(t)) deltaOids.add(t)
				}
				// Warm-delta base bodies: boundary trees, NOT in the served set — read
				// once per serve (they are the same handful the frontier just diffed).
				const warmBaseCache = new Map<string, Buffer | null>()
				const readWarmBase = async (oid: string): Promise<Buffer | null> => {
					const hit = warmBaseCache.get(oid)
					if (hit !== undefined) return hit
					const [row] = await pg<{ content: Buffer }[]>`
						select content from git_object
						where repo_id = ${id}::bigint and oid = ${Buffer.from(oid, "hex")}`
					const content = row?.content ?? null
					warmBaseCache.set(oid, content)
					return content
				}
				const emitOrder = [
					...served.filter((o) => !deltaOids.has(o)),
					...served.filter((o) => deltaOids.has(o)),
				]
				let emitted = 0
				for (const batch of batches(emitOrder, PACK_BATCH)) {
					// The derived encoding beside the object's type (delta-pack design D1):
					// a stored encoding is served as a verbatim byte copy — no deflate, no
					// delta resolution; an object without one takes the raw path below.
					type ServeRow = {
						oid: string
						type: number
						base_oid: string | null
						data_size: number | null
						data: Buffer | null
					}
					const rows = await pg<ServeRow[]>`
						select encode(o.oid, 'hex') as oid, o.type,
							encode(e.base_oid, 'hex') as base_oid, e.data_size, e.data
						from git_object o
							left join git_pack_encoding e
								on e.repo_id = o.repo_id and e.oid = o.oid
						where o.repo_id = ${id}::bigint
							and o.oid in ${pg(batch.map((h) => Buffer.from(h, "hex")))}`
					const byOid = new Map(rows.map((r) => [r.oid, r]))

					// D8′: a delta's base must be PROVABLY resolvable by the client — in
					// this pack, or (under negotiated thin-pack) in `clientHas`, whose
					// membership is proof by construction: a boundary tree reachable from
					// a stated have named it.
					const storedDeltaUsable = (r: ServeRow): boolean =>
						r.data !== null &&
						r.data_size !== null &&
						r.base_oid !== null &&
						(servedSet.has(r.base_oid) || (thinPack && clientHas.has(r.base_oid)))
					const storedWholeUsable = (r: ServeRow): boolean =>
						r.data !== null && r.data_size !== null && r.base_oid === null
					// Emission priority per object: stored delta (byte copy, zero compute)
					// → warm delta (R9: computed now against the client-held boundary tree
					// — this OUTRANKS a stored whole, because a freshly-pushed tree's
					// stored form IS a whole and shipping it whole is exactly the 3–11×
					// warm-fetch gap this slice closes) → stored whole (byte copy) →
					// computed whole.
					const wantsContent = (h: string, r: ServeRow): boolean => {
						if (storedDeltaUsable(r)) return false
						if (thinPack && warmBases.has(h)) return true
						return !storedWholeUsable(r)
					}

					// Raw-path subset, read through the existing size-guarded query (CASE →
					// NULL keeps a >256MiB blob off the driver's hex path; chunked below).
					const fallback = batch.filter((h) => {
						const r = byOid.get(h)
						return r !== undefined && wantsContent(h, r)
					})
					const contentByOid = new Map<string, Buffer>()
					if (fallback.length > 0) {
						const raw = await db
							.selectFrom("git_object")
							.select(["oid"])
							.select(sql<number>`octet_length(content)`.as("size"))
							.select(
								sql<Buffer | null>`case when octet_length(content) < ${BIG_OBJECT_BYTES} then content end`.as(
									"content",
								),
							)
							.where("repo_id", "=", id)
							.where(
								"oid",
								"in",
								fallback.map((h) => Buffer.from(h, "hex")),
							)
							.execute()
						for (const r of raw) {
							contentByOid.set(
								r.oid.toString("hex"),
								r.content ?? (await readContentChunked(id, r.oid, r.size)),
							)
						}
					}

					// Emit in served order (deterministic packs; the undeltified path used
					// row order, which was only accidentally stable).
					for (const h of batch) {
						const r = byOid.get(h)
						if (!r) {
							// The closure said present moments ago — vanishing mid-serve is a
							// hard fault (a mid-clone repo deletion), never a short pack.
							throw new Error(`pggit: object ${h} vanished while packing`)
						}
						if (storedDeltaUsable(r) && r.data !== null && r.data_size !== null) {
							push(encodeObjectHeader(PACK_OBJ_TYPE.REF_DELTA, r.data_size))
							push(Buffer.from(r.base_oid as string, "hex"))
							push(r.data)
							count("deltasServed")
						} else if (!wantsContent(h, r) && r.data !== null && r.data_size !== null) {
							// Stored whole, no better option: verbatim byte copy.
							push(encodeObjectHeader(r.type as PackObjType, r.data_size))
							push(r.data)
						} else {
							const content = contentByOid.get(h)
							if (!content) throw new Error(`pggit: no content read for ${h}`)
							// The serve-time warm delta (R9): a tree the tier cannot cover
							// FOR THIS CLIENT — freshly pushed (stored whole), or its stored
							// anchor unprovable — deltas against its same-path boundary
							// predecessor, client-held by construction, using the SAME
							// oracle-tested encoder repack uses. Kept only when it beats the
							// whole form (git's rule).
							const warmBase = thinPack ? warmBases.get(h) : undefined
							const baseContent =
								warmBase === undefined ? null : await readWarmBase(warmBase)
							const wholeDeflated = deflateSync(content)
							const delta =
								baseContent === null ? null : encodeDelta(baseContent, content)
							const deltaDeflated = delta === null ? null : deflateSync(delta)
							if (
								delta !== null &&
								deltaDeflated !== null &&
								warmBase !== undefined &&
								deltaDeflated.length < wholeDeflated.length
							) {
								push(encodeObjectHeader(PACK_OBJ_TYPE.REF_DELTA, delta.length))
								push(Buffer.from(warmBase, "hex"))
								push(deltaDeflated)
								count("deltasServed")
								count("warmDeltasServed")
							} else if (
								storedWholeUsable(r) &&
								r.data !== null &&
								r.data_size !== null
							) {
								push(encodeObjectHeader(r.type as PackObjType, r.data_size))
								push(r.data)
							} else {
								push(encodeObjectHeader(r.type as PackObjType, content.length))
								push(wholeDeflated)
							}
						}
						emitted++
					}
				}
				// The header count was fixed up front; a mismatch is a corrupt pack the
				// client would reject cryptically — fail here, loudly, instead (D8).
				if (emitted !== served.length) {
					throw new Error(
						`pggit: pack emitted ${emitted} objects, header promised ${served.length}`,
					)
				}
				const pack = Buffer.concat([...parts, hash.digest()])
				count("objectsServed", served.length)
				count("packBytes", pack.length)
				return pack
			})
		},

		/** The subset of `haves` this repo actually has — the negotiation common set,
		 * in one indexed lookup rather than a per-have probe. */
		async commonHaves(repoId: string, haves: string[]): Promise<string[]> {
			if (haves.length === 0) return []
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return []
			// Batched: the have list is CLIENT-sized and unvalidated, one bind per oid,
			// and the wire caps a statement at 65,534 binds — this was the store's last
			// unbatched client-sized value list, and it 500'd exactly at the wall
			// (pg-corrupt--fetch-haves-value-list).
			const present = new Set<string>()
			for (const batch of batches(haves, PACK_BATCH)) {
				const rows = await db
					.selectFrom("git_object")
					.select("oid")
					.where("repo_id", "=", id)
					.where(
						"oid",
						"in",
						batch.map((h) => Buffer.from(h, "hex")),
					)
					.execute()
				for (const r of rows) present.add(r.oid.toString("hex"))
			}
			// Preserve the client's `have` order (the ACK lines echo it) — the `in`
			// query returns rows in arbitrary order.
			return haves.filter((h) => present.has(h))
		},
		async getObject(repoId: string, oid: string): Promise<StoredObject | null> {
			count("getObjectCalls")
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return null

			const row = await db
				.selectFrom("git_object")
				.select(["type"])
				.select(sql<number>`octet_length(content)`.as("size"))
				.select(
					sql<Buffer | null>`case when octet_length(content) < ${BIG_OBJECT_BYTES} then content end`.as(
						"content",
					),
				)
				.where("repo_id", "=", id)
				.where("oid", "=", Buffer.from(oid, "hex"))
				.executeTakeFirst()
			if (!row) return null

			// A >256MiB object comes back with content NULL (the CASE guard); read it chunked
			// so its bytes never transit the porsager driver as one over-cap hex string.
			const content =
				row.content ?? (await readContentChunked(id, Buffer.from(oid, "hex"), row.size))
			count("objectBytesRead", content.length)
			return { content, type: objectTypeFromCode(row.type) }
		},

		async hasObject(repoId: string, oid: string): Promise<boolean> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return false
			const row = await db
				.selectFrom("git_object")
				.select("oid")
				.where("repo_id", "=", id)
				.where("oid", "=", Buffer.from(oid, "hex"))
				.executeTakeFirst()
			return row !== undefined
		},

		/**
		 * Ingest a received pack: parse it — resolving in-pack deltas, and thin-pack
		 * REF_DELTA bases against objects already in this repo — then insert every
		 * resolved object as a row.
		 */
		async ingestPack(repoId: string, packBytes: Buffer): Promise<{ oids: string[] }> {
			const id = await repos.ensureRepoId(repoId)
			const parsed = await readPack(packBytes, (oid) => store.getObject(repoId, oid))
			const oids = await insertObjects(
				id,
				parsed.map((p) => ({ content: p.content, type: p.type })),
			)
			return { oids }
		},

		/**
		 * Is `ancestor` in `descendant`'s history (or equal to it)? The
		 * fast-forward policy check for receive-pack's deny-non-FF (a ref update
		 * may only ADVANCE — see handleReceivePack): delegates to the same
		 * ancestry walk that powers negotiation (`ancestry` over `git_commit`
		 * parents + `git_tag` targets — the tag step is harmless for branch
		 * tips), seeded at the descendant and self-inclusive, so a no-op update
		 * (old == new) counts as an ancestor.
		 */
		async isAncestor(
			repoId: string,
			ancestor: string,
			descendant: string,
		): Promise<boolean> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return false
			return await ancestry(db, id, descendant, [Buffer.from(ancestor, "hex")])
		},

		/**
		 * Connectivity check (spec §5.2): is every object reachable from `oid` present?
		 * A push whose new tip fails this references an object the pack neither carried
		 * nor delta-resolved, and must be rejected. Delegates to the one reachability
		 * engine shared with clone/fetch, so connectivity and serving can never
		 * disagree on what is reachable. With a `boundary` (the PRE-PUSH ref tips,
		 * R5) the walk is `originClosure` with the tips as its STOP-SET — only the
		 * NEW region is verified: objects under a tip GC's pinned snapshot saw are
		 * live and cannot vanish mid-check, and a tip advanced after that snapshot
		 * is covered by the grace window (D13), the same defense it has today.
		 * Anything NOT under a tip (a denied push's stored-but-unverified orphans)
		 * is walked, not trusted. Without a boundary (first push, operator calls)
		 * the stop-set is empty and the walk is the full closure.
		 */
		async isConnected(
			repoId: string,
			oid: string,
			boundary: string[] = [],
		): Promise<boolean> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return false
			// The boundary is a STOP-SET, not a have-set: connectivity needs "every
			// object in the NEW region above the pre-push tips is present", so the
			// walk stops AT a boundary tip and never descends below it. Routing
			// this through the serve frontier instead would mark_uninteresting the
			// boundary's whole history — one round-trip per commit per command,
			// measured at ~4000 × 3000 sequential queries on a many-branch push of
			// a deep repo (the fetch-haves probe's 900 s wall).
			const walk = await originClosure(db, id, [oid], new Set(boundary))
			return walk.missing.size === 0
		},

		/** Seed objects directly (the differential harness + perf bench path): insert
		 * each as a row, idempotently. Equivalent to `ingestPack` minus the pack codec. */
		async putPack(
			repoId: string,
			objects: PackInputObject[],
		): Promise<{ oids: string[] }> {
			const id = await repos.ensureRepoId(repoId)
			const oids = await insertObjects(id, objects)
			return { oids }
		},

		/**
		 * git's `ok_to_give_up`: ready once every want reaches a common have by commit/
		 * tag ancestry (the haves form a cut below all wants, so the delta is well-
		 * defined). One ancestry CTE (commit parents + tag targets) per want replaces
		 * `reachesCommon`'s per-object BFS. Generation-number pruning is a deferred
		 * §6.4 lever.
		 */
		async readyToGiveUp(
			repoId: string,
			wants: string[],
			common: string[],
		): Promise<boolean> {
			if (common.length === 0) return false
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return false
			const commonBufs = common.map((h) => Buffer.from(h, "hex"))
			for (const want of wants) {
				if (!(await ancestry(db, id, want, commonBufs))) return false
			}
			return true
		},
	}

	/** Insert objects as rows + their derived commit/tag rows, idempotent
	 * (re-sent objects are skipped). Each object row and its complete derived set go
	 * in ONE transaction from ONE derivation (§10.1) — so no commit/tag object ever
	 * exists without its `git_commit`/`git_tag` row (spine chunk 1: "every stored
	 * commit has a row" is an invariant, not a hope).
	 * Derivation validates at the boundary and throws on malformed content (§5.1),
	 * aborting the ingest before any row lands. Returns every object's hex OID, in
	 * input order. */
	async function insertObjects(
		id: Awaited<ReturnType<typeof repos.ensureRepoId>>,
		objects: PackInputObject[],
	): Promise<string[]> {
		const entries = objects.map((obj) => {
			validateObject(obj.type, obj.content)
			const hex = computeOid(obj.type, obj.content)
			const oid = Buffer.from(hex, "hex")
			return {
				commit: obj.type === "commit" ? deriveCommitRow(obj.content) : null,
				hex,
				row: {
					content: obj.content,
					oid,
					repo_id: id,
					size: obj.content.length,
					type: OBJECT_TYPE_CODE[obj.type],
				},
				tag: obj.type === "tag" ? deriveTagRow(obj.content) : null,
			}
		})
		if (entries.length === 0) return []

		// Generations resolve in ONE topological pass over the ingest batch: a git
		// pack lists commits newest-first, so per-row computation in pack order would
		// derive NULL for every commit of a first push — and absorbing-NULL would
		// freeze that forever. In-pack parents resolve locally; parents already in
		// `git_commit` resolve by read; anything else is absent (denied-push residue)
		// and derives absorbing NULL (spine chunk 1).
		const commitByHex = new Map(
			entries.flatMap((e) => (e.commit ? [[e.hex, e.commit] as const] : [])),
		)
		const batchParents = new Map(
			[...commitByHex].map(([hex, c]) => [hex, c.parents] as const),
		)
		const externalParents = [
			...new Set([...commitByHex.values()].flatMap((c) => c.parents)),
		].filter((p) => !batchParents.has(p))
		const priorGenerations = new Map<string, number | null>()
		for (const batch of batches(externalParents, PACK_BATCH)) {
			const rows = await pg<{ oid: string; generation: number | null }[]>`
				select encode(oid, 'hex') as oid, generation from git_commit
				where repo_id = ${id}::bigint
					and oid in ${pg(batch.map((h) => Buffer.from(h, "hex")))}`
			for (const r of rows) priorGenerations.set(r.oid, r.generation)
		}
		const generations = computeGenerations(batchParents, priorGenerations)
		const tagByHex = new Map(
			entries.flatMap((e) => (e.tag ? [[e.hex, e.tag] as const] : [])),
		)

		const objectRows: CopyValue[][] = entries.map((e) => [
			{ t: "int8", v: e.row.repo_id },
			{ t: "bytea", v: e.row.oid },
			{ t: "int2", v: e.row.type },
			{ t: "int4", v: e.row.size },
			{ t: "bytea", v: e.row.content },
		])
		// One transaction (the object⟺derived-rows invariant, §10.1) via COPY into
		// staging: no bind-parameter ceiling and content streams as raw bytes (see
		// copyInsert), so neither object count nor blob size has a hard wall.
		// Commit/tag rows go AFTER the object rows (their FK needs them) —
		// value-list INSERTs, not COPY: `parents bytea[]` has no binary-COPY encoder
		// and a push carries few of either. A `bytea[]` cannot be bound directly
		// (the driver serializes Buffer[] as one bytea), so parents travel as hex
		// text and decode server-side, order pinned by WITH ORDINALITY.
		await pg.begin(async (tx) => {
			await copyInsert(
				tx,
				"git_object",
				["repo_id", "oid", "type", "size", "content"],
				objectRows,
			)
			for (const chunk of batches([...commitByHex], PACK_BATCH)) {
				await tx`
					insert into git_commit (repo_id, oid, tree_oid, parents, commit_time, generation)
					select ${id}::bigint, decode(u.oid, 'hex'), decode(u.tree, 'hex'),
						(select coalesce(array_agg(decode(p.h, 'hex') order by p.ord), '{}'::bytea[])
							from unnest(string_to_array(nullif(u.parents, ''), ' ')) with ordinality as p(h, ord)),
						u.commit_time, u.generation
					from unnest(
						${chunk.map(([hex]) => hex)}::text[],
						${chunk.map(([, c]) => c.treeOid)}::text[],
						${chunk.map(([, c]) => c.parents.join(" "))}::text[],
						${chunk.map(([, c]) => c.commitTime)}::bigint[],
						${chunk.map(([hex]) => generations.get(hex) ?? null)}::int[]
					) as u(oid, tree, parents, commit_time, generation)
					on conflict do nothing`
			}
			for (const chunk of batches([...tagByHex], PACK_BATCH)) {
				await tx`
					insert into git_tag (repo_id, oid, target_oid, target_type)
					select ${id}::bigint, decode(u.oid, 'hex'), decode(u.target, 'hex'), u.target_type
					from unnest(
						${chunk.map(([hex]) => hex)}::text[],
						${chunk.map(([, t]) => t.targetOid)}::text[],
						${chunk.map(([, t]) => OBJECT_TYPE_CODE[t.targetType])}::int[]
					) as u(oid, target, target_type)
					on conflict do nothing`
			}
		})
		// Stamp the repo's GC-activity watermark AFTER the ingest commits — never inside
		// the txn, where `clock_timestamp()` would be read BEFORE the commit. These objects
		// are reclaim candidates (a force-commit orphans the prior snapshot the instant the
		// ref moves), so the self-scheduling drain must judge this repo eligible
		// (gc-scheduler.ts §2). Stamping post-commit guarantees `last_pushed_at` is never
		// earlier than the commit of the orphan it announces, so a drain reading
		// `t0 = clock_timestamp()` after these objects' commit can't settle
		// `last_gc_at >= last_pushed_at` and lose that garbage — the same no-lost-garbage
		// rule refs-store's post-commit `stampPushed` follows. A tiny single-row HOT update
		// on the churn-tuned `repos` (0004) — reached only on a non-empty ingest (the empty
		// case returned above).
		await pg`update repos set last_pushed_at = clock_timestamp() where id = ${id}::bigint`
		return entries.map((e) => e.hex)
	}

	/**
	 * Read a single object's `content` in size-bounded chunks via `substring`, so a
	 * blob larger than V8's max string length never reaches the porsager driver as one
	 * over-cap `\x`+hex string — the serve-side mirror of the binary COPY ingest. Used
	 * only for objects at/over BIG_OBJECT_BYTES (smaller content comes back inline).
	 */
	async function readContentChunked(
		id: ReposId,
		oid: Buffer,
		size: number,
	): Promise<Buffer> {
		const parts: Buffer[] = []
		for (let off = 0; off < size; off += READ_CHUNK_BYTES) {
			const len = Math.min(READ_CHUNK_BYTES, size - off)
			const row = await db
				.selectFrom("git_object")
				.select(sql<Buffer>`substring(content from ${off + 1} for ${len})`.as("chunk"))
				.where("repo_id", "=", id)
				.where("oid", "=", oid)
				.executeTakeFirstOrThrow()
			parts.push(row.chunk)
		}
		return Buffer.concat(parts)
	}

	/**
	 * include-tag augmentation (§6.5): annotated tags whose peeled target is in the
	 * served set get their tag OBJECTS added — transitively over `git_tag`, so a
	 * tag-of-tag chain ships every tag object in it (each must be present for the
	 * client's fsck). Annotated tags are few, so we fetch them all and filter by
	 * served membership app-side rather than feeding the whole served set into SQL.
	 * Mutates `served`. Peeled targets are already in `served` (they qualified the
	 * tag), so re-adding the chain's terminal commit is a no-op.
	 */
	async function augmentWithTags(id: ReposId, served: Set<string>): Promise<void> {
		const tagRefs = await db
			.selectFrom("git_ref")
			.select(["oid", "peeled_oid"])
			.where("repo_id", "=", id)
			.where("oid", "is not", null)
			.where("peeled_oid", "is not", null)
			.execute()
		const qualifying = tagRefs
			.filter((r) => r.peeled_oid !== null && served.has(r.peeled_oid.toString("hex")))
			.map((r) => (r.oid as Buffer).toString("hex"))
		if (qualifying.length === 0) return

		const seed = sql.join(qualifying.map((r) => sql`(${Buffer.from(r, "hex")}::bytea)`))
		const chain = await sql<{ oid: Buffer }>`
			with recursive tags(oid) as (
				select oid from (values ${seed}) as roots(oid)
				union
				select t.target_oid from git_tag t
					join tags g on t.oid = g.oid
					where t.repo_id = ${id}::bigint
			)
			select oid from tags
		`.execute(db)
		for (const r of chain.rows) served.add(r.oid.toString("hex"))
	}

	return store
}

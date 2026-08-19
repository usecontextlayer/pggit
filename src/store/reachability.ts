import type { Kysely } from "kysely"
import { sql } from "kysely"
import TinyQueue from "tinyqueue"
import type { Database } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"
import { GITLINK_MODE, isTreeEntryMode, treeEntries } from "@/object/object"
import { type IndexedTree, indexTreeEntries } from "@/object/tree-diff"
import { PACK_OBJ_TYPE } from "@/pack/object-header"
import { throwMissingDerivedRow } from "@/store/derived-row"
import {
	loadEpoch,
	oidAtPosition,
	oidsOfUnion,
	remapPositions,
} from "@/store/reach-epoch"

/** Oids looked up per round-trip. Kysely's `in`-expansion spends one bind per
 * oid; the wire caps a statement at 65,534 binds. */
const LOOKUP_BATCH = 1000

/** Split `items` into consecutive batches of at most `size`. */
function batches<T>(items: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
	return out
}

/** A loaded `git_commit` row. `gen`/`time` ride along for the frontier — tiny
 * columns, one query shape for every walk. */
type CommitRow = { gen: number | null; time: number; parents: string[]; tree: string }

/** Batched PK reads over the derived commit rows — THE `git_commit` read every
 * walk shares (parents ordered via WITH ORDINALITY; aggregation order over a
 * bare unnest is not guaranteed, and parent order is the whole point). */
async function loadCommitRows(
	db: Kysely<Database>,
	id: ReposId,
	oids: Iterable<string>,
): Promise<Map<string, CommitRow>> {
	const out = new Map<string, CommitRow>()
	for (const batch of batches([...oids], LOOKUP_BATCH)) {
		const rows = await sql<{
			oid: string
			tree: string
			parents: string[]
			gen: number | null
			time: string
		}>`
			select encode(c.oid, 'hex') as oid, encode(c.tree_oid, 'hex') as tree,
				(select coalesce(array_agg(encode(p.h, 'hex') order by p.ord), '{}')
					from unnest(c.parents) with ordinality as p(h, ord)) as parents,
				c.generation as gen, c.commit_time::text as time
			from git_commit c
			where c.repo_id = ${id}::bigint
				and c.oid in (${sql.join(batch.map((h) => sql`${Buffer.from(h, "hex")}`))})
		`.execute(db)
		for (const r of rows.rows) {
			out.set(r.oid, {
				gen: r.gen,
				parents: r.parents,
				time: Number(r.time),
				tree: r.tree,
			})
		}
	}
	return out
}

/** Batched PK reads over the derived tag rows: oid → target oid. */
async function loadTagTargets(
	db: Kysely<Database>,
	id: ReposId,
	oids: Iterable<string>,
): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	for (const batch of batches([...oids], LOOKUP_BATCH)) {
		const rows = await sql<{ oid: string; target: string }>`
			select encode(t.oid, 'hex') as oid, encode(t.target_oid, 'hex') as target
			from git_tag t
			where t.repo_id = ${id}::bigint
				and t.oid in (${sql.join(batch.map((h) => sql`${Buffer.from(h, "hex")}`))})
		`.execute(db)
		for (const r of rows.rows) out.set(r.oid, r.target)
	}
	return out
}

/** The walks' `git_object` probe: type + content (trees ONLY — a `case` guard
 * keeps blob bodies off the wire; presence is all a blob contributes). Type
 * judgment stays with the CALLER: an oid that arrives here can be a typed-edge
 * violation (a tree naming a commit — reject cleanly) or a commit/tag whose
 * derived row is missing (the derived-row invariant is broken — crash loud), and only
 * the walk knows which edge brought it. */
async function loadObjectMeta(
	db: Kysely<Database>,
	id: ReposId,
	oids: Iterable<string>,
): Promise<Map<string, { type: number; content: Buffer | null }>> {
	const out = new Map<string, { type: number; content: Buffer | null }>()
	for (const batch of batches([...oids], LOOKUP_BATCH)) {
		const rows = await sql<{ oid: string; type: number; content: Buffer | null }>`
			select encode(o.oid, 'hex') as oid, o.type,
				case when o.type = ${PACK_OBJ_TYPE.TREE} then o.content end as content
			from git_object o
			where o.repo_id = ${id}::bigint
				and o.oid in (${sql.join(batch.map((h) => sql`${Buffer.from(h, "hex")}`))})
		`.execute(db)
		for (const r of rows.rows) out.set(r.oid, { content: r.content, type: r.type })
	}
	return out
}

/** What an edge DECLARED the object to be: a commit's parent is a commit, its
 * root (and a 40000 tree entry) is a tree, any other non-gitlink entry a blob.
 * `null` = no expectation (roots, tag targets — any type is legal). The check
 * catches the under-walk class: a mistyped edge would otherwise make the walk
 * treat a subtree as a leaf and silently skip its descendants. */
type EdgeExpectation = "commit" | "tree" | "blob"

/** Judge a git_object-probed oid against its edges' expectations (the SET of
 * expectations its referencing edges made — satisfying ANY is enough, so a
 * valid directory edge keeps an object alive even when a second, mistyped
 * edge also names it). Returns:
 * - "corruption": a COMMIT/TAG type here normally means the derived row is
 *   MISSING — the derived-row invariant is broken, crash loud, NEVER a sweepable
 *   "missing" (a healthy commit resolves via its row before this probe).
 * - "violation": the one exception — when ONLY tree/blob edges named the oid,
 *   the OBJECT may be healthy and the EDGE malformed; likewise a TREE/BLOB
 *   type matching none of its expectations ("commit" is never satisfiable
 *   here).
 * - "ok" otherwise. */
function judgeProbedType(
	expects: ReadonlySet<EdgeExpectation> | undefined,
	type: number,
): "ok" | "violation" | "corruption" {
	if (type === PACK_OBJ_TYPE.COMMIT || type === PACK_OBJ_TYPE.TAG) {
		return expects !== undefined && expects.size > 0 && !expects.has("commit")
			? "violation"
			: "corruption"
	}
	if (expects === undefined || expects.size === 0) return "ok"
	const actual = type === PACK_OBJ_TYPE.TREE ? "tree" : "blob"
	return expects.has(actual) ? "ok" : "violation"
}

/** A boundary (stop-set) oid's deferred check: the walk never probes a stop
 * oid, so its edge expectations are verified in one batched type probe at the
 * end. At a boundary a "commit" expectation IS satisfiable by a commit. */
function boundarySatisfies(expects: ReadonlySet<EdgeExpectation>, type: number): boolean {
	if (type === PACK_OBJ_TYPE.COMMIT) return expects.has("commit")
	if (type === PACK_OBJ_TYPE.TREE) return expects.has("tree")
	if (type === PACK_OBJ_TYPE.BLOB) return expects.has("blob")
	return false // a TAG satisfies no edge expectation (edges never declare tags)
}

/** The router's `git_object` probe: stored type by oid, no invariant judgment
 * (the router legitimately types commits and tags). */
async function loadObjectTypes(
	db: Kysely<Database>,
	id: ReposId,
	oids: Iterable<string>,
): Promise<Map<string, number>> {
	const out = new Map<string, number>()
	for (const batch of batches([...oids], LOOKUP_BATCH)) {
		const rows = await sql<{ oid: string; type: number }>`
			select encode(oid, 'hex') as oid, type from git_object
			where repo_id = ${id}::bigint
				and oid in (${sql.join(batch.map((h) => sql`${Buffer.from(h, "hex")}`))})
		`.execute(db)
		for (const r of rows.rows) out.set(r.oid, r.type)
	}
	return out
}

type PeeledTagChain =
	| { state: "complete"; chain: string[]; terminal: string }
	| { state: "missing"; chain: string[]; oid: string }

/** Peel one known tag through the canonical derived-row loaders. Missing tag
 * rows are corruption; an absent target is an ordinary incomplete chain. */
async function peelTagChain(
	db: Kysely<Database>,
	id: ReposId,
	tagOid: string,
	typed: Map<string, number>,
): Promise<PeeledTagChain> {
	const chain: string[] = []
	let current = tagOid
	for (;;) {
		chain.push(current)
		const target = (await loadTagTargets(db, id, [current])).get(current)
		if (target === undefined) throwMissingDerivedRow(current, PACK_OBJ_TYPE.TAG)

		let targetType = typed.get(target)
		if (targetType === undefined) {
			targetType = (await loadObjectTypes(db, id, [target])).get(target)
			if (targetType === undefined) return { chain, oid: target, state: "missing" }
			typed.set(target, targetType)
		}
		if (targetType !== PACK_OBJ_TYPE.TAG) {
			return { chain, state: "complete", terminal: target }
		}
		current = target
	}
}

/**
 * The ONE reachability module — shared by clone, connectivity,
 * and GC's live set, so they can never disagree about what is reachable. Walks
 * read the commit/tag rows and tree content (`git_object` is the raw-content
 * authority, D1). Batched primary-key point-reads are the whole query surface,
 * keeping traversal cost independent of planner statistics.
 *
 * Four walks share the loaders above: `fullClosure` (everything reachable),
 * `originClosure` (the same walk carrying the epoch producer's per-origin
 * masks), `frontier` (wants minus haves, git's
 * mark_uninteresting), and `ancestry` (commit/tag ancestry as one recursive
 * CTE). The want-type router (`routeServeSet`) and the bitmap fast path
 * (`epochServe`) live INSIDE this module — type dispatch and epoch guards
 * never leak to call sites.
 */

type ClosureResult = { present: Set<string>; missing: Set<string> }

/** What a level's oids are already known to be, from HOW they were reached: a
 * commit's parents are commits, a commit's root tree and a tree's entries are
 * trees/blobs — only roots and tag targets can be anything. Sorting oids by
 * origin spares the dominant tree/blob volume the commit/tag row lookups. */
type Frontier = { commits: string[]; objects: string[]; unknown: string[] }

/**
 * Everything reachable from `roots` — level-synchronous BFS in JS. Per level:
 * commit rows for known-commit + unknown oids, tag rows for the unknown
 * remainder, then one `git_object` read for the rest that fetches CONTENT ONLY
 * for trees (a `case` guard keeps blob bodies off the wire; presence is all a
 * blob contributes). One tree parse yields both subtrees and blobs. Returns the
 * closure partitioned into present / missing.
 *
 * A commit or tag OBJECT whose derived row is absent is a LOUD error, never a
 * parse-the-body fallback — "every stored commit has its row" is the
 * invariant, and reading through its violation would hide real corruption.
 */
export async function fullClosure(
	db: Kysely<Database>,
	id: ReposId,
	roots: string[],
	omitBlobs: boolean,
): Promise<ClosureResult> {
	const present = new Set<string>()
	const missing = new Set<string>()
	const visited = new Set<string>(roots)
	const expected = new Map<string, Set<EdgeExpectation>>()
	let frontier: Frontier = { commits: [], objects: [], unknown: [...new Set(roots)] }

	const expect = (oid: string, kind: EdgeExpectation): void => {
		const set = expected.get(oid)
		if (set) set.add(kind)
		else expected.set(oid, new Set([kind]))
	}
	const enqueue = (
		next: Frontier,
		bucket: keyof Frontier,
		oid: string,
		kind?: EdgeExpectation,
	): void => {
		// Expectations accumulate even for already-visited oids: a second edge
		// naming the same object can only add ways to SATISFY (any-match), and an
		// oid probed before a later mistyped edge arrives is simply judged by the
		// edges seen so far — stricter never unsound (see judgeProbedType).
		if (kind !== undefined) expect(oid, kind)
		if (visited.has(oid)) return
		visited.add(oid)
		next[bucket].push(oid)
	}

	while (
		frontier.commits.length + frontier.objects.length + frontier.unknown.length >
		0
	) {
		const next: Frontier = { commits: [], objects: [], unknown: [] }

		// 1. Commit rows: known commits (parents) plus whatever the unknowns hold.
		const commitProbe = [...frontier.commits, ...frontier.unknown]
		const commitRows = await loadCommitRows(db, id, commitProbe)
		for (const [oid, r] of commitRows) {
			present.add(oid)
			enqueue(next, "objects", r.tree, "tree")
			for (const par of r.parents) enqueue(next, "commits", par, "commit")
		}

		// 2. Tag rows, for unknowns that were not commits.
		const tagProbe = frontier.unknown.filter((o) => !commitRows.has(o))
		const tagRows = await loadTagTargets(db, id, tagProbe)
		for (const [oid, target] of tagRows) {
			present.add(oid)
			enqueue(next, "unknown", target)
		}

		// 3. The rest — trees, blobs, and absentees.
		const objectProbe = [
			...frontier.objects,
			...frontier.commits.filter((o) => !commitRows.has(o)),
			...tagProbe.filter((o) => !tagRows.has(o)),
		]
		const metas = await loadObjectMeta(db, id, objectProbe)
		for (const [oid, m] of metas) {
			// A typed-edge violation (commit.tree → blob, 40000 entry → blob, a
			// parent that is no commit) is a MALFORMED GRAPH, judged like an
			// absent object on this SERVE path: the want is refused — never an
			// under-walk that silently skips descendants. A commit/tag with no
			// derived row stays a LOUD corruption crash.
			const verdict = judgeProbedType(expected.get(oid), m.type)
			if (verdict === "corruption") throwMissingDerivedRow(oid, m.type)
			if (verdict === "violation") {
				missing.add(oid)
				continue
			}
			present.add(oid)
			if (m.type === PACK_OBJ_TYPE.TREE) {
				if (m.content === null) {
					throw new Error(`pggit reachability: tree ${oid} returned no content`)
				}
				for (const e of treeEntries(m.content)) {
					if (isTreeEntryMode(e.mode)) enqueue(next, "objects", e.oid, "tree")
					else if (e.mode !== GITLINK_MODE && !omitBlobs) {
						enqueue(next, "objects", e.oid, "blob")
					}
				}
			}
		}
		for (const oid of objectProbe) if (!metas.has(oid)) missing.add(oid)

		frontier = next
	}
	return { missing, present }
}

/** Per-origin membership over a multi-source walk. `masks` maps each PRESENT
 * reachable oid to a bitset over `origins` indices (`1n << i`) of which origins
 * reach it; `hits` maps each `stopAt` member the walk reached to the same
 * bitset — recorded, never expanded. This is the epoch producer's walk (chunk
 * 5b): with an empty `stopAt` it is `fullClosure` carrying per-tip masks (the
 * first epoch / the rewind rebuild); with the prior epoch's tips as `stopAt`
 * it is the steady-state delta walk — and an origin that IS a stop member
 * short-circuits to a pure hit, which is the spec's "unmoved tips remap only"
 * rule falling out of one walk instead of a special case. */
export type OriginWalk = {
	masks: Map<string, bigint>
	hits: Map<string, bigint>
	missing: Set<string>
	/** Oids named by a MISTYPED edge (typed-edge policy). Under "reject" they
	 * are also in `missing`; under "retain" they stay in `masks` — an existing
	 * object validly reachable must never become sweepable because a second,
	 * malformed edge also names it — but their presence withholds the epoch. */
	violations: Set<string>
}

/**
 * Multi-source closure with per-origin masks — `fullClosure`'s level-BFS with
 * a bigint mask per oid. An oid re-expands only when it GAINS origin bits, so
 * a region shared by T tips is re-read at most T times and a single-origin
 * walk (the common one-branch repo) never re-expands. Blobs are always
 * included: the epoch universe is the FULL live set (GC's setting). Same loud
 * chunk-1 invariants as `fullClosure`. An absent oid lands in `missing` and is
 * scrubbed from `masks` — masks name only objects that exist, because their
 * positions become epoch bits that serves will read content for.
 */
export async function originClosure(
	db: Kysely<Database>,
	id: ReposId,
	origins: string[],
	stopAt: ReadonlySet<string>,
	// How a typed-edge violation is judged. "reject" (connectivity): like an
	// absent object — the push must fail. "retain" (GC): the object stays in
	// the live masks and expands by its ACTUAL type — an existing object must
	// never be swept over a malformed EDGE — while the violation still
	// withholds the epoch (gc.ts).
	onViolation: "reject" | "retain",
): Promise<OriginWalk> {
	const masks = new Map<string, bigint>()
	const hits = new Map<string, bigint>()
	const missing = new Set<string>()
	const violations = new Set<string>()
	const expected = new Map<string, Set<EdgeExpectation>>()
	// Expectations on STOP oids: the walk never probes them, so they are
	// verified in one batched type probe after the walk (path-independence —
	// a mistyped edge must not escape scrutiny by pointing at a boundary tip).
	const stopExpected = new Map<string, Set<EdgeExpectation>>()
	const expect = (
		map: Map<string, Set<EdgeExpectation>>,
		oid: string,
		kind: EdgeExpectation,
	): void => {
		const set = map.get(oid)
		if (set) set.add(kind)
		else map.set(oid, new Set([kind]))
	}

	type MaskLevel = {
		commits: Map<string, bigint>
		objects: Map<string, bigint>
		unknown: Map<string, bigint>
	}
	const newLevel = (): MaskLevel => ({
		commits: new Map(),
		objects: new Map(),
		unknown: new Map(),
	})
	let level = newLevel()

	const enqueue = (
		next: MaskLevel,
		bucket: keyof MaskLevel,
		oid: string,
		bits: bigint,
		kind?: EdgeExpectation,
	): void => {
		if (stopAt.has(oid)) {
			if (kind !== undefined) expect(stopExpected, oid, kind)
			hits.set(oid, (hits.get(oid) ?? 0n) | bits)
			return
		}
		if (kind !== undefined) expect(expected, oid, kind)
		const have = masks.get(oid) ?? 0n
		const news = bits & ~have
		if (news === 0n) return
		masks.set(oid, have | news)
		const pending = next[bucket].get(oid) ?? 0n
		next[bucket].set(oid, pending | news)
	}

	origins.forEach((o, i) => {
		enqueue(level, "unknown", o, 1n << BigInt(i))
	})

	/** Merge per-oid bits of several pending maps (an oid can enter one level
	 * through two buckets — e.g. as a parent and as a tag target). */
	const merge = (...maps: Map<string, bigint>[]): Map<string, bigint> => {
		const out = new Map<string, bigint>()
		for (const m of maps) {
			for (const [oid, bits] of m) out.set(oid, (out.get(oid) ?? 0n) | bits)
		}
		return out
	}

	while (level.commits.size + level.objects.size + level.unknown.size > 0) {
		const next = newLevel()

		// 1. Commit rows: known commits (parents) plus whatever the unknowns hold.
		const commitProbe = merge(level.commits, level.unknown)
		const commitRows = await loadCommitRows(db, id, commitProbe.keys())
		for (const [oid, r] of commitRows) {
			const bits = commitProbe.get(oid) as bigint
			enqueue(next, "objects", r.tree, bits, "tree")
			for (const par of r.parents) enqueue(next, "commits", par, bits, "commit")
		}

		// 2. Tag rows, for unknowns that were not commits.
		const tagProbe = new Map<string, bigint>()
		for (const [oid, bits] of level.unknown) {
			if (!commitRows.has(oid)) tagProbe.set(oid, bits)
		}
		const tagRows = await loadTagTargets(db, id, tagProbe.keys())
		for (const [oid, target] of tagRows) {
			enqueue(next, "unknown", target, tagProbe.get(oid) as bigint)
		}

		// 3. The rest — trees, blobs, and absentees.
		const objectProbe = merge(
			new Map([...commitProbe].filter(([o]) => !commitRows.has(o) && !tagProbe.has(o))),
			new Map([...tagProbe].filter(([o]) => !tagRows.has(o))),
			level.objects,
		)
		const metas = await loadObjectMeta(db, id, objectProbe.keys())
		for (const [oid, m] of metas) {
			// Typed-edge violations: the graph is malformed. "reject" fails
			// connectivity like an absent object; "retain" keeps the object live
			// (a valid edge elsewhere must keep it un-sweepable) and expands it
			// by its ACTUAL type — either way the violation is recorded and the
			// epoch withheld. A commit/tag with no derived row stays a LOUD
			// corruption crash, never a sweepable "missing".
			const verdict = judgeProbedType(expected.get(oid), m.type)
			if (verdict === "corruption") throwMissingDerivedRow(oid, m.type)
			if (verdict === "violation") {
				violations.add(oid)
				if (onViolation === "reject") {
					missing.add(oid)
					masks.delete(oid)
					continue
				}
			}
			if (m.type === PACK_OBJ_TYPE.TREE) {
				if (m.content === null) {
					throw new Error(`pggit reachability: tree ${oid} returned no content`)
				}
				const bits = objectProbe.get(oid) as bigint
				for (const e of treeEntries(m.content)) {
					if (e.mode !== GITLINK_MODE) {
						enqueue(
							next,
							"objects",
							e.oid,
							bits,
							isTreeEntryMode(e.mode) ? "tree" : "blob",
						)
					}
				}
			}
		}
		for (const oid of objectProbe.keys()) {
			if (!metas.has(oid)) {
				missing.add(oid)
				masks.delete(oid)
			}
		}

		level = next
	}

	// Deferred boundary checks: a stop oid's edge expectations, verified in one
	// batched type probe (the walk never expanded these). An absent stop oid is
	// genuinely missing for the wanting side.
	if (stopExpected.size > 0) {
		const types = await loadObjectTypes(db, id, stopExpected.keys())
		for (const [oid, expects] of stopExpected) {
			const type = types.get(oid)
			if (type === undefined) {
				missing.add(oid)
				continue
			}
			if (!boundarySatisfies(expects, type)) {
				violations.add(oid)
				if (onViolation === "reject") missing.add(oid)
			}
		}
	}
	return { hits, masks, missing, violations }
}

/** Does `want`'s commit/tag ancestry (`git_commit.parents` + `git_tag` targets)
 * reach any oid in `common`? The ancestry shape that underpins `readyToGiveUp`
 * and the fast-forward check. Each recursion step is a PK probe into the
 * commit/tag rows — the ancestry relation itself, no edge set. */
export async function ancestry(
	db: Kysely<Database>,
	id: ReposId,
	want: string,
	commonBufs: Buffer[],
): Promise<boolean> {
	if (commonBufs.length === 0) return false
	const commons = sql.join(commonBufs.map((b) => sql`(${b}::bytea)`))
	const result = await sql<{
		reached: boolean
		corrupt_oid: string | null
		corrupt_type: number | null
	}>`
		with recursive anc(oid) as (
			select ${Buffer.from(want, "hex")}::bytea
			union
			select step.oid from anc a
				cross join lateral (
					select unnest(c.parents) as oid from git_commit c
						where c.repo_id = ${id}::bigint and c.oid = a.oid
					union all
					select t.target_oid from git_tag t
						where t.repo_id = ${id}::bigint and t.oid = a.oid
				) as step
		), corrupt as (
			select a.oid, o.type from anc a
				join git_object o on o.repo_id = ${id}::bigint and o.oid = a.oid
				left join git_commit c on c.repo_id = o.repo_id and c.oid = o.oid
				left join git_tag t on t.repo_id = o.repo_id and t.oid = o.oid
			where (o.type = ${PACK_OBJ_TYPE.COMMIT} and c.oid is null)
				or (o.type = ${PACK_OBJ_TYPE.TAG} and t.oid is null)
			order by a.oid
			limit 1
		)
		select exists (
			select 1 from anc join (values ${commons}) as common(oid) on common.oid = anc.oid
		) as reached,
		(select encode(oid, 'hex') from corrupt) as corrupt_oid,
		(select type from corrupt) as corrupt_type
	`.execute(db)
	const [row] = result.rows
	if (!row) throw new Error("pggit reachability: ancestry query returned no row")
	if (row.corrupt_oid !== null && row.corrupt_type !== null) {
		throwMissingDerivedRow(row.corrupt_oid, row.corrupt_type)
	}
	return row.reached
}

// ───────────────────────────────── the frontier ─────────────────────────────────

/** INTERESTING = reachable from a want; UNINTERESTING = reachable from a have.
 * Both can hold; uninteresting wins (git's mark_uninteresting).
 * `uninterestingBits` carries PROVENANCE — a bitset over the haves (`1n << i`)
 * whose descent marked this commit — so the bitmap fast path can
 * tell which epoch tips justified each exclusion. 0n ⇔ not uninteresting. */
type Mark = { interesting: boolean; uninterestingBits: bigint }

/** What a routed serve resolves to. `served` is the exact object set to pack;
 * `missing` is every absent object the walk needed (non-empty ⇒ the want's
 * closure is incomplete — refuse, or reject the push, caller's call);
 * `clientHas` is every oid PROVABLY held by the client — observed on the
 * boundary side of a diff — the only legal thin-pack bases (D8′). */
export type ServeSet = {
	served: Set<string>
	missing: Set<string>
	clientHas: Set<string>
	/** Served TREE → its same-path boundary predecessor (∈ `clientHas`): the
	 * serve-time warm-delta pair (R9). First-parent side wins on a merge. Blobs
	 * are deliberately absent (R20: no blob deltas in the first pass). */
	warmBases: Map<string, string>
	/** The haves the want-side walk REACHED (marked interesting): each is in
	 * every want's closure, so its own closure may be added to the serve set
	 * without over-serving — the bitmap fast path's OR set. */
	boundaryHits: Set<string>
	/** True iff every exclusion the walk made is justified by a have in
	 * `boundaryHits`. False means some pruning leaned on a have the wants never
	 * reached (a fork below a boundary tip) — `boundaryHits`' closures then do
	 * NOT reconstruct the wants' closure, and a bitmap serve must fall back. */
	boundaryExact: boolean
}

type EpochServeAttempt = { state: "fallback" } | { state: "served"; result: ServeSet }

/** Queue entry priority: NULL generation ≡ infinity pops first; then generation
 * descending; `commit_time` descending breaks ties and orders NULL regions
 * (git's pre-generation heuristic — can only ever OVER-send, never under). */
function frontierBefore(
	a: { gen: number | null; time: number },
	b: { gen: number | null; time: number },
): number {
	if (a.gen === null && b.gen === null) return b.time - a.time
	if (a.gen === null) return -1
	if (b.gen === null) return 1
	if (a.gen !== b.gen) return b.gen - a.gen
	return b.time - a.time
}

/**
 * git's `mark_uninteresting` walk over the commit rows — NEVER a stop-at CTE
 * (a UNION CTE computes a monotone least fixed point; "reachable-from-wants
 * MINUS reachable-from-haves" is non-monotone, and stopping AT a have descends
 * past merge bases into an unbounded over-send). A JS priority queue pops in
 * descending generation, so in the finite region the strict
 * `gen(parent) < gen(child)` invariant makes every UNINTERESTING mark
 * arrive before its commit is popped — exact, no date slop. Per new commit, its
 * root tree is diffed n-way against its parents' roots: boundary-parent sides
 * accumulate into `clientHas` and prune; interesting-parent sides only prune
 * (their objects are served through their own commits).
 *
 * `wants`/`haves` must be COMMIT oids with rows — `routeServeSet` peels and
 * routes everything else. Absent parents land in `missing` and act as
 * boundaries (nothing to serve or diff below an object the repo lacks).
 */
export async function frontier(
	db: Kysely<Database>,
	id: ReposId,
	wants: string[],
	haves: string[],
	omitBlobs: boolean,
): Promise<ServeSet> {
	const served = new Set<string>()
	const missing = new Set<string>()
	const clientHas = new Set<string>()
	const warmBases = new Map<string, string>()
	const rows = new Map<string, CommitRow | null>() // null ⇒ no row (absent)
	const marks = new Map<string, Mark>()
	const newCommits: string[] = []
	// Provenance: each have owns one bit; `meetBits` accumulates the bits of
	// every have whose descent touched an INTERESTING commit — i.e. every have
	// that justified an exclusion (see ServeSet.boundaryExact).
	const haveBit = new Map<string, bigint>()
	haves.forEach((h, i) => {
		haveBit.set(h, (haveBit.get(h) ?? 0n) | (1n << BigInt(i)))
	})
	let meetBits = 0n

	const loadRows = async (oids: string[]): Promise<void> => {
		const need = [...new Set(oids)].filter((o) => !rows.has(o))
		const got = await loadCommitRows(db, id, need)
		for (const o of need) rows.set(o, got.get(o) ?? null)
	}

	type QueueEntry = { oid: string; gen: number | null; time: number }
	const queue = new TinyQueue<QueueEntry>([], frontierBefore)
	const inQueue = new Set<string>()
	let interestingInQueue = 0

	const isInterestingOnly = (m: Mark): boolean =>
		m.interesting && m.uninterestingBits === 0n

	const markOf = (oid: string): Mark => {
		let m = marks.get(oid)
		if (!m) {
			m = { interesting: false, uninterestingBits: 0n }
			marks.set(oid, m)
		}
		return m
	}

	/** Mark + enqueue (row must already be loaded). An absent commit is recorded
	 * missing (want side) and never enqueued — it is its own boundary. For the
	 * uninteresting kind, `bits` names the haves whose descent this mark is;
	 * bits landing on (or already under) an interesting commit are a MEET and
	 * feed `meetBits`. */
	const mark = (oid: string, kind: "interesting" | "uninteresting", bits = 0n): void => {
		const row = rows.get(oid)
		if (row === null || row === undefined) {
			if (kind === "interesting") missing.add(oid)
			return
		}
		const m = markOf(oid)
		const wasInterestingOnly = isInterestingOnly(m)
		if (kind === "interesting") {
			if (m.interesting) return
			m.interesting = true
			meetBits |= m.uninterestingBits
		} else {
			const news = bits & ~m.uninterestingBits
			if (news === 0n) return
			m.uninterestingBits |= news
			if (m.interesting) meetBits |= news
		}
		if (inQueue.has(oid)) {
			if (wasInterestingOnly && !isInterestingOnly(m)) interestingInQueue--
			return
		}
		queue.push({ gen: row.gen, oid, time: row.time })
		inQueue.add(oid)
		if (isInterestingOnly(m)) interestingInQueue++
	}

	await loadRows([...wants, ...haves])
	for (const h of haves) mark(h, "uninteresting", haveBit.get(h) as bigint)
	for (const w of wants) mark(w, "interesting")

	while (queue.length > 0 && interestingInQueue > 0) {
		const entry = queue.pop() as QueueEntry
		inQueue.delete(entry.oid)
		const m = markOf(entry.oid)
		if (isInterestingOnly(m)) interestingInQueue--
		const row = rows.get(entry.oid) as CommitRow
		await loadRows(row.parents)
		if (m.uninterestingBits !== 0n) {
			for (const p of row.parents) mark(p, "uninteresting", m.uninterestingBits)
		} else {
			newCommits.push(entry.oid)
			served.add(entry.oid)
			for (const p of row.parents) mark(p, "interesting")
		}
	}

	// ── Phase 2: trees + blobs per new commit, n-way against parents' roots. ──
	const treeCache = new Map<string, IndexedTree | null>()
	const readTree = async (oid: string): Promise<IndexedTree | null> => {
		const hit = treeCache.get(oid)
		if (hit !== undefined) return hit
		const [row] = (
			await sql<{ content: Buffer }>`
				select content from git_object
				where repo_id = ${id}::bigint and oid = ${Buffer.from(oid, "hex")}
					and type = ${PACK_OBJ_TYPE.TREE}
			`.execute(db)
		).rows
		const tree = row === undefined ? null : indexTreeEntries(row.content)
		treeCache.set(oid, tree)
		if (tree === null) missing.add(oid)
		return tree
	}
	const blobCandidates = new Set<string>()

	/** Serve everything under a tree (a root commit's tree, or a wholly-new
	 * subtree with no same-name predecessor on any side). */
	const serveWholeTree = async (treeOid: string): Promise<void> => {
		if (served.has(treeOid)) return
		served.add(treeOid)
		const tree = await readTree(treeOid)
		if (tree === null) return
		for (const e of tree.entries) {
			if (isTreeEntryMode(e.mode)) await serveWholeTree(e.oid)
			else if (e.mode !== GITLINK_MODE && !omitBlobs) blobCandidates.add(e.oid)
		}
	}

	/** Diff one new tree against boundary-side and interesting-side same-path
	 * trees. Boundary entries feed `clientHas`; either side prunes. */
	const diffForServe = async (
		treeOid: string,
		boundaryTrees: string[],
		interestingTrees: string[],
	): Promise<void> => {
		for (const b of boundaryTrees) clientHas.add(b)
		if (boundaryTrees.includes(treeOid) || interestingTrees.includes(treeOid)) return
		if (served.has(treeOid)) return
		if (boundaryTrees.length === 0 && interestingTrees.length === 0) {
			await serveWholeTree(treeOid)
			return
		}
		served.add(treeOid)
		// The warm-delta pair (R9): this tree's same-path boundary predecessor is
		// client-held BY CONSTRUCTION (it is in clientHas via this very diff), so a
		// thin-pack serve may delta against it at serve time.
		const warmBase = boundaryTrees[0]
		if (warmBase !== undefined) warmBases.set(treeOid, warmBase)
		const tree = await readTree(treeOid)
		if (tree === null) return

		type OldSide = {
			boundary: boolean
			entries: IndexedTree["byName"]
		}
		const oldSides: OldSide[] = []
		for (const [boundary, list] of [
			[true, boundaryTrees],
			[false, interestingTrees],
		] as const) {
			for (const oldOid of list) {
				const oldTree = await readTree(oldOid)
				if (oldTree === null) continue
				for (const e of oldTree.entries) {
					// "Any oid seen on the old side" of a BOUNDARY diff is provably
					// client-held — a boundary tree reachable from a stated have named it.
					if (boundary && e.mode !== GITLINK_MODE) clientHas.add(e.oid)
				}
				oldSides.push({ boundary, entries: oldTree.byName })
			}
		}

		for (const e of tree.entries) {
			if (e.mode === GITLINK_MODE) continue
			const sameOid = oldSides.some((s) => s.entries.get(e.name)?.oid === e.oid)
			if (sameOid) continue
			if (isTreeEntryMode(e.mode)) {
				const boundarySub: string[] = []
				const interestingSub: string[] = []
				for (const s of oldSides) {
					const old = s.entries.get(e.name)
					if (old !== undefined && isTreeEntryMode(old.mode)) {
						;(s.boundary ? boundarySub : interestingSub).push(old.oid)
					}
				}
				await diffForServe(e.oid, boundarySub, interestingSub)
			} else if (!omitBlobs && !served.has(e.oid)) {
				blobCandidates.add(e.oid)
			}
		}
	}

	for (const c of newCommits) {
		const row = rows.get(c) as CommitRow
		const boundaryTrees: string[] = []
		const interestingTrees: string[] = []
		for (const p of row.parents) {
			const prow = rows.get(p)
			if (prow === null || prow === undefined) continue
			const pm = marks.get(p)
			if (pm !== undefined && isInterestingOnly(pm) && served.has(p)) {
				interestingTrees.push(prow.tree)
			} else {
				boundaryTrees.push(prow.tree)
			}
		}
		await diffForServe(row.tree, boundaryTrees, interestingTrees)
	}

	// ── Blob presence, batched (also the connectivity probe for blobs). ──
	const probe = [...blobCandidates].filter((b) => !served.has(b))
	for (const batch of batches(probe, LOOKUP_BATCH)) {
		const got = await sql<{ oid: string }>`
			select encode(oid, 'hex') as oid from git_object
			where repo_id = ${id}::bigint
				and oid in (${sql.join(batch.map((h) => sql`${Buffer.from(h, "hex")}`))})
		`.execute(db)
		const present = new Set(got.rows.map((r) => r.oid))
		for (const b of batch) {
			if (present.has(b)) served.add(b)
			else missing.add(b)
		}
	}

	const boundaryHits = new Set<string>()
	let hitBits = 0n
	for (const [h, bit] of haveBit) {
		if (marks.get(h)?.interesting) {
			boundaryHits.add(h)
			hitBits |= bit
		}
	}
	return {
		boundaryExact: (meetBits & ~hitBits) === 0n,
		boundaryHits,
		clientHas,
		missing,
		served,
		warmBases,
	}
}

/**
 * The bitmap fast path (R23) — answers a no-have, unfiltered request
 * from the stored epoch, or returns `fallback` when it cannot answer EXACTLY
 * (no epoch; a want that is neither an epoch tip nor a commit; a bitmap row
 * already cascaded away mid-rewind; or a walk whose exclusions leaned on a tip
 * the wants never reached — `boundaryExact` false, the fork-below-a-tip case).
 *
 * A want that IS an epoch tip is its bitmap, verbatim. Wants pushed since the
 * last drain are commits: `frontier(rest, boundary = epoch tip commits)` walks
 * exactly the since-drain delta, and each boundary tip the walk REACHED
 * contributes its closure by bitmap OR — a tag tip hit at its PEELED commit
 * contributes its bitmap MINUS its own chain (the tag objects are not
 * reachable from a commit want). The result is the wants' exact closure with
 * ZERO tree reads below the boundary.
 *
 * The returned ServeSet's `clientHas`/`warmBases` are deliberately EMPTY: the
 * frontier ran against FAKE haves (epoch tips), but this client stated none —
 * a thin delta against a "boundary" base here would corrupt the clone.
 */
async function epochServe(
	db: Kysely<Database>,
	id: ReposId,
	wants: string[],
): Promise<EpochServeAttempt> {
	const loadedEpoch = await loadEpoch(db, id)
	if (loadedEpoch.state !== "ready") return { state: "fallback" }
	const { epoch } = loadedEpoch
	const tipSet = new Set(epoch.tips)
	const tipBitmaps = [...epoch.bitmaps].filter(([tip]) => tipSet.has(tip))
	const uniqueWants = [...new Set(wants)]
	const tipWants = uniqueWants.filter((w) => tipSet.has(w))
	const rest = uniqueWants.filter((w) => !tipSet.has(w))
	const tipWantSet = new Set(tipWants)
	const orBits = tipBitmaps.filter(([tip]) => tipWantSet.has(tip)).map(([, bits]) => bits)

	if (rest.length === 0) {
		return {
			result: {
				boundaryExact: true,
				boundaryHits: new Set(),
				clientHas: new Set(),
				missing: new Set(),
				served: new Set(oidsOfUnion(orBits, epoch.oids)),
				warmBases: new Map(),
			},
			state: "served",
		}
	}

	// Non-tip wants must be commits (anything else — tree, blob, a tag object
	// pushed since the drain — is the router's slow path's business).
	const typed = await loadObjectTypes(db, id, [...rest, ...epoch.tips])
	if (!rest.every((w) => typed.get(w) === PACK_OBJ_TYPE.COMMIT)) {
		return { state: "fallback" }
	}

	// Boundary commits: each epoch tip peeled to its commit; a tag tip's chain
	// is recorded so a hit at the peeled commit can subtract it. Tips that peel
	// to a non-commit carry no subtraction semantics (git's rule) — and cannot
	// be reached by a commit walk — so they are simply not boundaries.
	const boundaryOf = new Map<string, { chain: Set<string>; bits: Uint8Array }>()
	for (const [tip, bits] of tipBitmaps) {
		const peeled =
			typed.get(tip) === PACK_OBJ_TYPE.TAG
				? await peelTagChain(db, id, tip, typed)
				: { chain: [], state: "complete" as const, terminal: tip }
		if (peeled.state === "missing") continue
		const current = peeled.terminal
		const chain = new Set(peeled.chain)
		if (typed.get(current) !== PACK_OBJ_TYPE.COMMIT) continue
		// A commit tip beats a tag tip peeling to the same commit (no chain to
		// subtract); first tag tip wins among equals — their peeled closures agree.
		if (current === tip || !boundaryOf.has(current)) {
			boundaryOf.set(current, { bits, chain })
		}
	}

	const fr = await frontier(db, id, rest, [...boundaryOf.keys()], false)
	if (!fr.boundaryExact) return { state: "fallback" }

	const served = new Set(fr.served)
	for (const hex of oidsOfUnion(orBits, epoch.oids)) served.add(hex)
	for (const [commit, bound] of boundaryOf) {
		if (!fr.boundaryHits.has(commit)) continue
		if (bound.chain.size === 0) {
			for (const hex of oidsOfUnion([bound.bits], epoch.oids)) served.add(hex)
		} else {
			for (const pos of remapPositions(bound.bits, epoch.oids, epoch.oids, bound.chain)) {
				served.add(oidAtPosition(epoch.oids, pos))
			}
		}
	}

	return {
		result: {
			boundaryExact: true,
			boundaryHits: new Set(),
			clientHas: new Set(),
			missing: fr.missing,
			served,
			warmBases: new Map(),
		},
		state: "served",
	}
}

/**
 * The want-type router (R4) — the ONE entry the serve and connectivity paths
 * call; type dispatch lives HERE, never at call sites. Wants partition by
 * STORED type before any walk: commit/tag → frontier (tag chains ship whole,
 * then route their peeled target), tree → `fullClosure` from that tree, blob →
 * the blob itself — the promisor rule verbatim (a partial-clone lazy
 * `want <blob>` is never subtracted and never an empty pack). Haves peel to
 * commits; non-commit haves carry no subtraction semantics and are dropped,
 * matching git. A have-less request (cold clone) uses the epoch fast path when
 * its shape is exact, then falls back to `fullClosure`; frontier diffing buys
 * nothing without a boundary.
 */
export async function routeServeSet(
	db: Kysely<Database>,
	id: ReposId,
	wants: string[],
	haves: string[],
	omitBlobs: boolean,
): Promise<ServeSet> {
	if (haves.length === 0) {
		// The bitmap fast path: a no-have, unfiltered fetch over an
		// epoch-covered repo is answered from stored bitmaps — zero tree reads on
		// a fully-drained repo. `blob:none` bypasses it (the epoch's bits carry
		// no type information to subtract blobs by), and any shape the epoch
		// cannot answer EXACTLY returns `fallback` and falls through to the walk.
		if (!omitBlobs) {
			const fast = await epochServe(db, id, wants)
			if (fast.state === "served") return fast.result
		}
		const { present, missing } = await fullClosure(db, id, wants, omitBlobs)
		return {
			boundaryExact: true,
			boundaryHits: new Set(),
			clientHas: new Set(),
			missing,
			served: present,
			warmBases: new Map(),
		}
	}

	// Type both sides in one batched sweep.
	const typed = await loadObjectTypes(db, id, new Set([...wants, ...haves]))

	const served = new Set<string>()
	const missing = new Set<string>()

	/** Follow a tag chain, serving each tag object; returns the terminal non-tag
	 * (or null when the chain dangles — recorded missing). */
	const peelServing = async (tagOid: string, serve: boolean): Promise<string | null> => {
		const peeled = await peelTagChain(db, id, tagOid, typed)
		if (serve) for (const oid of peeled.chain) served.add(oid)
		if (peeled.state === "complete") return peeled.terminal
		missing.add(peeled.oid)
		return null
	}

	const commitWants: string[] = []
	const treeWants: string[] = []
	for (const w of wants) {
		const t = typed.get(w)
		if (t === undefined) {
			missing.add(w)
		} else if (t === PACK_OBJ_TYPE.COMMIT) {
			commitWants.push(w)
		} else if (t === PACK_OBJ_TYPE.TAG) {
			const terminal = await peelServing(w, true)
			if (terminal === null) continue
			const tt = typed.get(terminal)
			if (tt === PACK_OBJ_TYPE.COMMIT) commitWants.push(terminal)
			else if (tt === PACK_OBJ_TYPE.TREE) treeWants.push(terminal)
			else served.add(terminal)
		} else if (t === PACK_OBJ_TYPE.TREE) {
			treeWants.push(w)
		} else {
			served.add(w) // an exact blob want: itself, never subtracted (promisor)
		}
	}

	const commitHaves: string[] = []
	for (const h of haves) {
		const t = typed.get(h)
		if (t === PACK_OBJ_TYPE.COMMIT) commitHaves.push(h)
		else if (t === PACK_OBJ_TYPE.TAG) {
			const terminal = await peelServing(h, false)
			if (terminal !== null && typed.get(terminal) === PACK_OBJ_TYPE.COMMIT) {
				commitHaves.push(terminal)
			}
		}
	}

	const result =
		commitWants.length > 0
			? await frontier(db, id, commitWants, commitHaves, omitBlobs)
			: {
					boundaryExact: true,
					boundaryHits: new Set<string>(),
					clientHas: new Set<string>(),
					missing: new Set<string>(),
					served: new Set<string>(),
					warmBases: new Map<string, string>(),
				}
	for (const o of served) result.served.add(o)
	for (const o of missing) result.missing.add(o)
	if (treeWants.length > 0) {
		const sub = await fullClosure(db, id, treeWants, omitBlobs)
		for (const o of sub.present) result.served.add(o)
		for (const o of sub.missing) result.missing.add(o)
	}
	return result
}

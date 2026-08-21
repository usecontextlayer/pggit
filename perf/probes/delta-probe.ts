/**
 * Diagnostic probe for delta-tier cost and quality, measured on BOTH sides.
 *
 * Runs against a REAL repository (`--repo=<path>`) or a generated stand-in with the
 * shape that makes tree-delta compression matter — a flat, append-only directory gaining one
 * run-uuid subdir per commit. On the same object set it measures:
 *
 *   A. git's own numbers: raw bytes by type, what individually-deflating them costs
 *      (the no-tier baseline), and what `git gc` packs them into.
 *   B. the POSTGRES side: what `git_object` (+ its TOAST) actually costs on disk,
 *      and what the trees alone cost through the same lz4 column.
 *   C. the CLONE side: a real `git clone` over loopback against the in-process
 *      server, decomposed into Postgres-read time vs zlib-deflate time.
 *   C2. the clone AFTER a real repack — the stored tier's cold-clone path end to end.
 *   D. delta topology sweeps with the REAL encoder (src/pack/delta.ts), scored
 *      with the structural base heuristic (same path, previous commit).
 *
 * One-shot and diagnostic, like the rest of `perf/`: not a gate, not a fixture.
 * The source repo is COPIED before anything runs, so a customer mirror stays
 * byte-for-byte pristine.
 *
 *   npx tsx perf/probes/delta-probe.ts --repo=../customers/.../komal-96afa2eb
 *   npx tsx perf/probes/delta-probe.ts --runs=1476
 */

import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { nonemptyStringArg, parseArgs, pgUrlArg, positiveIntegerArg } from "@perf/args"
import {
	requiredCollector,
	requiredPhase,
	requiredPositiveCounter,
} from "@perf/collector-evidence"
import { table } from "@perf/probes/_table"
import { z } from "zod"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import type { Oid } from "@/oid"
import { applyDelta, encodeDelta } from "@/pack/delta"
import { serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import {
	deterministicFiller,
	FAST_IMPORT_COMMITTER,
	runDirName,
} from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	assertGitReachableObjects,
	canonicalStoreRefsOf,
	cloneIndependentMirror,
	gitLogRawBasePairs,
	loadAllReachableObjects,
	packFileBytes,
	parseLsRemoteRefs,
	repackEligibleObjects,
	seedGitRefs,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"

const REPO_ID = "workspace/slate/probe"
type ProbeSource = { kind: "generated" } | { kind: "repository"; path: string }

const args = parseArgs(
	z
		.object({
			docs: positiveIntegerArg.default(145),
			pg: pgUrlArg,
			repo: nonemptyStringArg.optional(),
			runs: positiveIntegerArg.default(1476),
		})
		.strict()
		.transform(
			({
				repo,
				...values
			}): {
				docs: number
				pg: string
				runs: number
				source: ProbeSource
			} => ({
				...values,
				source:
					repo === undefined ? { kind: "generated" } : { kind: "repository", path: repo },
			}),
		),
)
const SOURCE = args.source
const RUNS = args.runs
const DOC_COUNT = args.docs
const PG_URL = args.pg

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(2)} MB`
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}s`

// ---------------------------------------------------------------------------
// The generated shape (used only when --repo is absent)
// ---------------------------------------------------------------------------

function buildStream(): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (content: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return m
	}

	const seeded: string[] = []
	for (let i = 0; i < DOC_COUNT; i++) {
		const m = blob(`# doc ${i}\n\n${deterministicFiller(`doc-${i}-v0`, 2000)}\n`)
		seeded.push(`M 100644 :${m} docs/planner-updates/doc-${i}.md`)
	}
	const agents = blob(`# agents\n${deterministicFiller("agents", 500)}\n`)
	seeded.push(`M 100644 :${agents} .agents/AGENTS.md`)

	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 7\nseed c0\n${seeded.join("\n")}\n`,
	)

	for (let i = 0; i < RUNS; i++) {
		const dir = runDirName(i)
		const record = blob(
			`{"run":"${dir}","status":"ok","payload":"${deterministicFiller(`rec-${i}`, 1200)}"}\n`,
		)
		const stderr = blob(`${deterministicFiller(`err-${i}`, 400)}\n`)
		const changes = [
			`M 100644 :${record} .engine/runs/planner-updates/${dir}/record.json`,
			`M 100644 :${stderr} .engine/runs/planner-updates/${dir}/stderr`,
		]
		if (i % 13 === 0) {
			const d = i % DOC_COUNT
			const m = blob(`# doc ${d}\n\n${deterministicFiller(`doc-${d}-v${i}`, 2000)}\n`)
			changes.push(`M 100644 :${m} docs/planner-updates/doc-${d}.md`)
		}
		const cm = next()
		const msg = `run ${i}`
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${prev}\n${changes.join("\n")}\n`,
		)
		prev = cm
	}
	return out.join("")
}

// ---------------------------------------------------------------------------
// D. Delta feasibility — driven by the REAL encoder (src/pack/delta.ts), the same
// one the repack tier ships. This probe predates it and briefly carried its own;
// keeping a second encoder would mean maintaining two.
// ---------------------------------------------------------------------------

/**
 * Base pairs from ONE `git log --raw` pass: for every commit, each changed path's
 * (old oid → new oid). That is precisely the "same path, one commit earlier"
 * heuristic — no window, no sorting, no size search. `-t` includes tree entries,
 * so the intermediate directories that dominate this shape are covered; the root
 * tree is paired separately from each commit's own `%T`.
 */
// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const scratch = createScratchArena()
	const mkdir = (tag: string): string => scratch.make(`delta-probe-${tag}`)

	// --- the repo under test ------------------------------------------------
	const src = join(mkdir("src"), "repo")
	if (SOURCE.kind === "repository") {
		console.log(`# delta-probe — real repo: ${SOURCE.path}\n`)
		await cloneIndependentMirror(SOURCE.path, src)
	} else {
		console.log(`# delta-probe — generated shape: ${RUNS} runs, ${DOC_COUNT} docs\n`)
		mkdirSync(src)
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
	}
	const commitsRaw = (
		await spawnGit(["rev-list", "--count", "--all"], { cwd: src })
	).stdout.trim()
	const commits = Number(commitsRaw)
	if (!Number.isSafeInteger(commits) || commits < 1) {
		throw new Error(`delta-probe requires a nonempty commit history, got ${commitsRaw}`)
	}

	// --- A. git's own numbers ----------------------------------------------
	const objects = await loadAllReachableObjects(src)
	if (objects.length === 0) throw new Error("delta-probe found no reachable objects")
	const eligibleObjects = objects.filter(
		(object) => object.content.length < MAX_INLINE_BYTEA_BYTES,
	).length
	if (eligibleObjects === 0) throw new Error("delta-probe has no repack-eligible objects")
	const expectedOids = objects.map((object) => object.oid)
	const byType = new Map<string, { count: number; raw: number; deflated: number }>()
	const deflatedOf = new Map<Oid, number>()
	for (const o of objects) {
		const d = deflateSync(o.content).length
		deflatedOf.set(o.oid, d)
		const slot = byType.get(o.type) ?? { count: 0, deflated: 0, raw: 0 }
		slot.count++
		slot.raw += o.content.length
		slot.deflated += d
		byType.set(o.type, slot)
	}
	console.log(
		`## A. object weight — ${objects.length} reachable objects, ${commits} commits\n`,
	)
	const objectRows: (string | number)[][] = []
	let rawTotal = 0
	let deflatedTotal = 0
	for (const [type, s] of [...byType.entries()].sort((a, b) => b[1].raw - a[1].raw)) {
		rawTotal += s.raw
		deflatedTotal += s.deflated
		objectRows.push([type, s.count, mb(s.raw), mb(s.deflated)])
	}
	console.log(
		table(
			["type", "count", "raw", "individually deflated (no-tier baseline)"],
			objectRows,
		),
	)
	console.log(
		`| **total** | **${objects.length}** | **${mb(rawTotal)}** | **${mb(deflatedTotal)}** |`,
	)

	const gcDir = join(mkdir("gc"), "repo")
	cpSync(src, gcDir, { recursive: true })
	const gcStart = Date.now()
	await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: gcDir })
	const gcMs = Date.now() - gcStart
	const sizePack = await packFileBytes(gcDir)
	if (sizePack === 0) throw new Error("git gc produced a zero-byte pack")
	console.log(
		`\n\`git gc --aggressive\`: **${mb(sizePack)}** in ${secs(gcMs)} → ` +
			`**${(deflatedTotal / sizePack).toFixed(1)}×** smaller than what pggit serves`,
	)

	// --- B / C: a real pggit schema ----------------------------------------
	console.log(`\n## B. the Postgres side\n`)
	const db = await createIsolatedSchema(PG_URL)
	let server: Awaited<ReturnType<typeof serveOnPort>> | undefined
	let server2: Awaited<ReturnType<typeof serveOnPort>> | undefined
	try {
		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const ingestStart = Date.now()
		await store.putPack(REPO_ID, objects)
		const ingestMs = Date.now() - ingestStart

		await seedGitRefs(REPO_ID, src, refs)
		const expectedCommits = objects.filter((object) => object.type === "commit").length
		const expectedTags = objects.filter((object) => object.type === "tag").length
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "exact", objects: [] },
			objects,
			refs: await canonicalStoreRefsOf(src),
		})
		console.log(`ingested ${objects.length} objects in ${secs(ingestMs)}`)

		const [sizes] = await db.sql<{ total: string; heap: string; indexes: string }[]>`
			select
				sum(pg_total_relation_size(inhrelid))::text as total,
				sum(pg_relation_size(inhrelid))::text as heap,
				sum(pg_indexes_size(inhrelid))::text as indexes
			from pg_inherits where inhparent = 'git_object'::regclass`
		if (sizes === undefined) throw new Error("git_object size query returned no row")
		const total = Number(sizes.total)
		const heap = Number(sizes.heap)
		const idx = Number(sizes.indexes)
		console.log(
			`\n\`git_object\` on disk: **${mb(total)}** ` +
				`(heap ${mb(heap)}, indexes ${mb(idx)}, TOAST ${mb(total - heap - idx)})`,
		)
		console.log(
			`raw content ingested: ${mb(rawTotal)} → stored at **${(total / rawTotal).toFixed(2)}×** of raw`,
		)

		// The topology surface (spine chunk 1): one `git_commit` row per commit,
		// linear in history — the quadratic `git_edge` table this section once
		// measured is dropped (S2), which IS the storage headline.
		const [topoSizes] = await db.sql<{ total: string }[]>`
			select (
				(select coalesce(sum(pg_total_relation_size(inhrelid)), 0)
					from pg_inherits where inhparent = 'git_commit'::regclass)
				+ (select coalesce(sum(pg_total_relation_size(inhrelid)), 0)
					from pg_inherits where inhparent = 'git_tag'::regclass)
			)::text as total`
		if (topoSizes === undefined) throw new Error("topology size query returned no row")
		console.log(
			`\ntopology rows (\`git_commit\` + \`git_tag\`) on disk: ` +
				`**${mb(Number(topoSizes.total))}** — ${expectedCommits} commit rows, ` +
				`${expectedTags} tag rows (linear in history; the quadratic git_edge table is gone, S2)`,
		)

		await db.sql`create table probe_trees (content bytea compression lz4)`
		await db.sql`insert into probe_trees select content from git_object where type = 2`
		const [treeSize] = await db.sql<{ n: string }[]>`
			select pg_total_relation_size('probe_trees')::text as n`
		const treeRaw = byType.get("tree")?.raw
		if (treeRaw === undefined || treeRaw <= 0) {
			throw new Error("delta-probe requires nonzero reachable tree bytes")
		}
		if (treeSize === undefined) throw new Error("tree-size query returned no row")
		const storedTreeBytes = Number(treeSize.n)
		console.log(
			`trees alone: ${mb(treeRaw)} raw → **${mb(storedTreeBytes)}** stored ` +
				`(lz4 leaves ${((storedTreeBytes / treeRaw) * 100).toFixed(0)}%)`,
		)

		// --- C. the clone side ------------------------------------------------
		console.log(`\n## C. the clone side\n`)
		const app = createGitApp(createGitDeps(db.sql), { instrument: true })
		server = await serveOnPort(app, 0)
		const canonicalRefs = parseLsRemoteRefs(
			(await spawnGit(["ls-remote", src])).stdout,
			"canonical source",
		)
		const servedRefs = parseLsRemoteRefs(
			(await spawnGit(["ls-remote", `http://127.0.0.1:${server.port}/${REPO_ID}`]))
				.stdout,
			"pggit",
		)
		if (JSON.stringify(servedRefs) !== JSON.stringify(canonicalRefs)) {
			throw new Error(
				`served refs differ from source: expected ${canonicalRefs.length}, got ${servedRefs.length}`,
			)
		}
		resetCollected()
		const dest = join(mkdir("clone"), "c")
		const cpuBefore = process.cpuUsage()
		const cloneStart = Date.now()
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			`http://127.0.0.1:${server.port}/${REPO_ID}`,
			dest,
		])
		const cloneMs = Date.now() - cloneStart
		const cpu = process.cpuUsage(cpuBefore)
		await server.close()
		server = undefined
		await assertGitReachableObjects(dest, expectedOids, "unrepacked clone")

		const fetchRun = requiredCollector([...collectedRuns()], "fetch", "unrepacked clone")
		const closureMs = requiredPhase(fetchRun, "closure", "unrepacked clone")
		const encodeMs = requiredPhase(fetchRun, "pack-encode", "unrepacked clone")
		const packBytes = requiredPositiveCounter(fetchRun, "packBytes", "unrepacked clone")
		const objectsServed = requiredPositiveCounter(
			fetchRun,
			"objectsServed",
			"unrepacked clone",
		)
		if (objectsServed !== objects.length) {
			throw new Error(
				`unrepacked clone served ${objectsServed} objects for a ${objects.length}-object source`,
			)
		}

		const deflateStart = Date.now()
		for (const o of objects) deflateSync(o.content)
		const deflateOnlyMs = Date.now() - deflateStart

		console.log(`clone wall **${secs(cloneMs)}**, pack **${mb(packBytes)}**`)
		console.log(
			`server CPU during clone: ${(cpu.user / 1000).toFixed(0)}ms user + ${(cpu.system / 1000).toFixed(0)}ms sys`,
		)
		console.log(
			`server phases: closure ${closureMs.toFixed(0)}ms, pack-encode ${encodeMs.toFixed(0)}ms`,
		)
		console.log(
			`deflate alone over the same objects: **${deflateOnlyMs}ms** = ` +
				`${((deflateOnlyMs / encodeMs) * 100).toFixed(0)}% of pack-encode ` +
				`(the remainder is the Postgres read)`,
		)

		// --- C2. the clone side, AFTER repack --------------------------------
		// Run the real repack over the same schema, then a second real clone.
		console.log(`\n## C2. the clone after repack (stored tier)\n`)
		const repackStart = Date.now()
		const repackResult = await createRepack(db.sql).repack(REPO_ID)
		if (repackResult.wholes + repackResult.deltas !== eligibleObjects) {
			throw new Error(
				`repack covered ${repackResult.wholes + repackResult.deltas}/${eligibleObjects} eligible objects`,
			)
		}
		if (repackResult.deltas === 0) {
			throw new Error("delta-probe fixture produced no stored deltas")
		}
		const [encodingCensus] = await db.sql<{ rows: string; deltas: string }[]>`
			select count(*)::text as rows,
				count(*) filter (where base_oid is not null)::text as deltas
			from git_pack_encoding`
		if (encodingCensus === undefined) throw new Error("encoding census returned no row")
		if (
			Number(encodingCensus.rows) !== eligibleObjects ||
			Number(encodingCensus.deltas) !== repackResult.deltas
		) {
			throw new Error(
				`encoding census mismatch: expected ${eligibleObjects}/${repackResult.deltas}, got ${encodingCensus.rows}/${encodingCensus.deltas}`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "exact", objects: repackEligibleObjects(objects) },
			objects,
			refs: await canonicalStoreRefsOf(src),
		})
		console.log(
			`repack: ${repackResult.wholes} wholes + ${repackResult.deltas} deltas in ${secs(Date.now() - repackStart)}`,
		)
		server2 = await serveOnPort(
			createGitApp(createGitDeps(db.sql), { instrument: true }),
			0,
		)
		resetCollected()
		const dest2 = join(mkdir("clone2"), "c")
		const cpuBefore2 = process.cpuUsage()
		const clone2Start = Date.now()
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			`http://127.0.0.1:${server2.port}/${REPO_ID}`,
			dest2,
		])
		const clone2Ms = Date.now() - clone2Start
		const cpu2 = process.cpuUsage(cpuBefore2)
		await server2.close()
		server2 = undefined
		const fetchRun2 = requiredCollector([...collectedRuns()], "fetch", "repacked clone")
		const packBytes2 = requiredPositiveCounter(fetchRun2, "packBytes", "repacked clone")
		const deltasServed = requiredPositiveCounter(
			fetchRun2,
			"deltasServed",
			"repacked clone",
		)
		const objectsServed2 = requiredPositiveCounter(
			fetchRun2,
			"objectsServed",
			"repacked clone",
		)
		if (objectsServed2 !== objects.length) {
			throw new Error(
				`repacked clone served ${objectsServed2} objects for a ${objects.length}-object source`,
			)
		}
		await assertGitReachableObjects(dest2, expectedOids, "repacked clone")
		console.log(
			`clone wall **${secs(clone2Ms)}** (was ${secs(cloneMs)}), ` +
				`pack **${mb(packBytes2)}** (was ${mb(packBytes)}) — ` +
				`**${(packBytes / packBytes2).toFixed(1)}×** smaller, ` +
				`${deltasServed} entries served as deltas, fsck-clean`,
		)
		console.log(
			`server CPU during clone: ${(cpu2.user / 1000).toFixed(0)}ms user (was ${(cpu.user / 1000).toFixed(0)}ms)`,
		)

		// --- D. delta feasibility --------------------------------------------
		console.log(`\n## D. does a CHEAP base heuristic match git?\n`)
		const byOid = new Map(objects.map((o) => [o.oid, o]))
		const pairs = await gitLogRawBasePairs(src)
		const treePairs = new Map<Oid, Oid>()
		for (const [targetOid, baseOid] of pairs) {
			const target = byOid.get(targetOid)
			const base = byOid.get(baseOid)
			if (target?.type === "tree" && base?.type === "tree") {
				treePairs.set(targetOid, baseOid)
			}
		}
		if (treePairs.size === 0) {
			throw new Error("delta-probe fixture produced no reachable tree base/target pairs")
		}
		const deflatedBytes = (oid: Oid): number => {
			const bytes = deflatedOf.get(oid)
			if (bytes === undefined)
				throw new Error(`missing deflated-byte measurement for ${oid}`)
			return bytes
		}

		// The combination that matters is (structural base) × (forward chaining) × (depth
		// cap) — NOT any one of them alone. A cap forces every (cap+1)-th version of a
		// growing tree to be stored WHOLE, and on this shape a whole tree is enormous, so
		// the cap's cost here is nothing like the cost of capping git (whose window search
		// can point many deltas at ONE base, a star rather than a chain, and so pays far
		// less for shallow depth). Sweep it rather than assume.
		const encodeStart = Date.now()
		let verified = 0
		const rows: (string | number)[][] = []
		for (const cap of [1, 2, 3, 4, 8, 16, Number.POSITIVE_INFINITY]) {
			let deltaBytes = 0
			let wholeBytes = 0
			let deltified = 0
			const depthOf = new Map<Oid, number>()

			// Oldest-first: a base's representation must be final before its dependents are
			// considered, or a target recorded at depth 1 silently deepens later.
			for (const o of objects) {
				if (o.type !== "tree") continue
				depthOf.set(o.oid, 0)
			}
			for (const [targetOid, baseOid] of treePairs) {
				const target = byOid.get(targetOid)
				const base = byOid.get(baseOid)
				if (!target || !base)
					throw new Error(`tree pair vanished: ${baseOid} -> ${targetOid}`)
				const baseDepth = depthOf.get(baseOid)
				if (baseDepth === undefined) {
					throw new Error(`tree base ${baseOid} has no representation depth`)
				}
				const candidate = baseDepth + 1
				if (candidate > cap) continue // stays whole, depth 0
				const whole = deflatedBytes(targetOid)
				const delta = encodeDelta(base.content, target.content)
				if (!applyDelta(base.content, delta).equals(target.content)) {
					throw new Error(`encodeDelta round-trip FAILED for tree ${targetOid}`)
				}
				verified++
				const encoded = deflateSync(delta).length
				if (encoded >= whole) continue // delta lost; stays whole
				deltaBytes += encoded
				deltified++
				depthOf.set(targetOid, candidate)
			}
			for (const o of objects) {
				if (o.type === "tree") {
					const depth = depthOf.get(o.oid)
					if (depth === undefined)
						throw new Error(`tree ${o.oid} has no representation depth`)
					if (depth > 0) continue
				}
				wholeBytes += deflatedBytes(o.oid)
			}
			if (deltified === 0) {
				throw new Error(`depth-cap ${cap} produced no deltas`)
			}
			const total = deltaBytes + wholeBytes
			rows.push([
				cap === Number.POSITIVE_INFINITY ? "uncapped" : cap,
				mb(total),
				`${(deflatedTotal / total).toFixed(1)}×`,
				deltified,
			])
		}
		if (verified === 0) throw new Error("delta feasibility sweep verified no programs")
		console.log(
			`${verified} deltas encoded and round-tripped through this repo's own \`applyDelta\` — all exact`,
		)
		console.log(`encode+verify sweep: ${secs(Date.now() - encodeStart)}\n`)
		console.log(
			table(["depth cap", "served size", "vs no tier", "trees deltified"], rows),
		)
		console.log(
			`\nfor reference — no tier **${mb(deflatedTotal)}**, ` +
				`\`git gc --aggressive\` (window search, not same-path) **${mb(sizePack)}**`,
		)
		// --- E. depth is not the same knob as base DISTANCE ------------------
		// The sweep above chains each version to its immediate predecessor, so a cap of D
		// forces every (D+1)-th version to be stored WHOLE — and whole trees are the
		// expensive thing. git does not pay that, because its window lets MANY versions
		// delta against ONE base: a star, depth 1, with the base further back. Anchoring
		// every K-th version and pointing the K-1 between it at that anchor keeps depth at
		// 1 while storing only 1/K whole trees. Depth and base distance are separable, and
		// conflating them is what made the cap look expensive.
		console.log(`\n## E. star topology — depth 1, anchor every K versions\n`)
		const lineageNext = new Map<Oid, Oid[]>()
		for (const [target, base] of treePairs) {
			const children = lineageNext.get(base) ?? []
			children.push(target)
			lineageNext.set(base, children)
		}
		const lineageHeads = [...new Set(treePairs.values())].filter(
			(base) => !treePairs.has(base),
		)
		if (lineageHeads.length === 0) {
			throw new Error("every tree lineage is cyclic; star-topology sweep has no anchor")
		}
		const anchorRows: (string | number)[][] = []
		for (const K of [4, 8, 16, 32, 64, 128]) {
			let bytes = 0
			const deltaOf = new Set<Oid>()
			const visitedTargets = new Set<Oid>()
			const pending = lineageHeads.map((oid) => ({ anchor: oid, distance: 0, oid }))
			while (pending.length > 0) {
				const current = pending.pop()
				if (current === undefined) throw new Error("star traversal lost pending entry")
				for (const childOid of lineageNext.get(current.oid) ?? []) {
					visitedTargets.add(childOid)
					const child = byOid.get(childOid)
					const anchor = byOid.get(current.anchor)
					if (child?.type !== "tree" || anchor?.type !== "tree") {
						throw new Error(
							`tree lineage object vanished: ${current.anchor} -> ${childOid}`,
						)
					}
					const distance = current.distance + 1
					if (distance % K === 0) {
						pending.push({ anchor: childOid, distance: 0, oid: childOid })
						continue
					}
					const delta = encodeDelta(anchor.content, child.content)
					if (!applyDelta(anchor.content, delta).equals(child.content)) {
						throw new Error(`star encodeDelta round-trip FAILED for ${childOid}`)
					}
					const encoded = deflateSync(delta).length
					if (encoded < deflatedBytes(childOid)) {
						bytes += encoded
						deltaOf.add(childOid)
					}
					pending.push({ anchor: current.anchor, distance, oid: childOid })
				}
			}
			if (visitedTargets.size !== treePairs.size) {
				throw new Error(
					`star traversal covered ${visitedTargets.size}/${treePairs.size} eligible tree pairs`,
				)
			}
			if (deltaOf.size === 0) throw new Error(`anchor interval ${K} produced no deltas`)
			for (const o of objects) if (!deltaOf.has(o.oid)) bytes += deflatedBytes(o.oid)
			anchorRows.push([
				K,
				1,
				mb(bytes),
				`${(deflatedTotal / bytes).toFixed(1)}×`,
				deltaOf.size,
			])
		}
		console.log(
			table(
				["anchor every K", "max depth", "served size", "vs no tier", "trees deltified"],
				anchorRows,
			),
		)
	} finally {
		await server?.close()
		await server2?.close()
		await db.drop()
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

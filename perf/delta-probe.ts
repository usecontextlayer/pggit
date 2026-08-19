/**
 * Diagnostic probe for the undeltified-serve-path defect, measured on BOTH sides.
 *
 * Runs against a REAL repository (`--repo=<path>`) or a generated stand-in with the
 * shape that makes the defect bite — a flat, append-only directory gaining one
 * run-uuid subdir per commit. On the same object set it measures:
 *
 *   A. git's own numbers: raw bytes by type, what individually-deflating them costs
 *      (= exactly what pggit puts on the wire), and what `git gc` packs them into.
 *   B. the POSTGRES side: what `git_object` (+ its TOAST) actually costs on disk,
 *      and what the trees alone cost through the same lz4 column.
 *   C. the CLONE side: a real `git clone` over loopback against the in-process
 *      server, decomposed into Postgres-read time vs zlib-deflate time.
 *   C2. the clone AFTER a real repack — the implemented pipeline end to end.
 *   D. delta topology sweeps with the REAL encoder (src/pack/delta.ts), scored
 *      with the structural base heuristic (same path, previous commit).
 *
 * One-shot and diagnostic, like the rest of `perf/`: not a gate, not a fixture.
 * The source repo is COPIED before anything runs, so a customer mirror stays
 * byte-for-byte pristine.
 *
 *   npx tsx perf/delta-probe.ts --repo=../customers/.../komal-96afa2eb
 *   npx tsx perf/delta-probe.ts --runs=1476
 */
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { applyDelta, encodeDelta } from "@/pack/delta"
import { serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const REPO_ID = "workspace/slate/probe"
/** Cap the bytes in one COPY round-trip; late-history trees are ~90 KB each. */
const INGEST_BYTES = 16_000_000

function flag(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}

const REPO = flag("repo", "")
const RUNS = Number(flag("runs", "1476"))
const DOC_COUNT = Number(flag("docs", "145"))
const PG_URL = flag("pg", "postgres://postgres:postgres@localhost:6489/postgres")

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(2)} MB`
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}s`

// ---------------------------------------------------------------------------
// The generated shape (used only when --repo is absent)
// ---------------------------------------------------------------------------

function runDirName(i: number): string {
	const h = createHash("sha1").update(`run-${i}`).digest("hex")
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function filler(salt: string, len: number): string {
	let out = ""
	while (out.length < len) {
		out += createHash("sha1").update(`${salt}-${out.length}`).digest("hex")
	}
	return out.slice(0, len)
}

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
		const m = blob(`# doc ${i}\n\n${filler(`doc-${i}-v0`, 2000)}\n`)
		seeded.push(`M 100644 :${m} docs/planner-updates/doc-${i}.md`)
	}
	const agents = blob(`# agents\n${filler("agents", 500)}\n`)
	seeded.push(`M 100644 :${agents} .agents/AGENTS.md`)

	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 7\nseed c0\n${seeded.join("\n")}\n`,
	)

	for (let i = 0; i < RUNS; i++) {
		const dir = runDirName(i)
		const record = blob(
			`{"run":"${dir}","status":"ok","payload":"${filler(`rec-${i}`, 1200)}"}\n`,
		)
		const stderr = blob(`${filler(`err-${i}`, 400)}\n`)
		const changes = [
			`M 100644 :${record} .engine/runs/planner-updates/${dir}/record.json`,
			`M 100644 :${stderr} .engine/runs/planner-updates/${dir}/stderr`,
		]
		if (i % 13 === 0) {
			const d = i % DOC_COUNT
			const m = blob(`# doc ${d}\n\n${filler(`doc-${d}-v${i}`, 2000)}\n`)
			changes.push(`M 100644 :${m} docs/planner-updates/doc-${d}.md`)
		}
		const cm = next()
		const msg = `run ${i}`
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${prev}\n${changes.join("\n")}\n`,
		)
		prev = cm
	}
	return out.join("")
}

// ---------------------------------------------------------------------------
// Reading a repo's REACHABLE objects in one `git cat-file` (never a spawn each)
// ---------------------------------------------------------------------------

type Obj = { oid: string; type: string; content: Buffer }

async function reachableObjects(dir: string): Promise<Obj[]> {
	// Reachable-from-refs is what a clone transfers, so it is what to measure —
	// `--batch-all-objects` would also count orphans a clone never sees.
	const list = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
	const oids = list.stdout
		.split("\n")
		.map((l) => l.slice(0, 40))
		.filter((o) => /^[0-9a-f]{40}$/.test(o))
	const unique = [...new Set(oids)]

	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${unique.join("\n")}\n`,
	})
	const buf = res.stdoutBytes
	const objs: Obj[] = []
	let pos = 0
	while (pos < buf.length) {
		const nl = buf.indexOf(0x0a, pos)
		if (nl < 0) break
		const [oid, type, sizeStr] = buf.subarray(pos, nl).toString("latin1").split(" ")
		if (!oid || !type || !sizeStr) break
		const size = Number(sizeStr)
		const start = nl + 1
		objs.push({ content: buf.subarray(start, start + size), oid, type })
		pos = start + size + 1
	}
	return objs
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
async function basePairs(dir: string): Promise<Map<string, string>> {
	const out = await spawnGit(
		[
			"log",
			"--reverse",
			"--raw",
			"-r",
			"-t",
			"--no-renames",
			"--abbrev=40",
			"--format=@%H %T %P",
			"--all",
		],
		{ cwd: dir },
	)
	const pairs = new Map<string, string>()
	const commitTree = new Map<string, string>()
	let parents: string[] = []
	for (const line of out.stdout.split("\n")) {
		if (line.startsWith("@")) {
			const [hash, tree, ...rest] = line.slice(1).split(" ")
			if (!hash || !tree) continue
			commitTree.set(hash, tree)
			parents = rest.filter(Boolean)
			// Root tree's base is the first parent's root tree.
			const parentTree = parents[0] ? commitTree.get(parents[0]) : undefined
			if (parentTree && parentTree !== tree && !pairs.has(tree))
				pairs.set(tree, parentTree)
			continue
		}
		if (!line.startsWith(":")) continue
		const tab = line.indexOf("\t")
		if (tab < 0) continue
		const fields = line.slice(1, tab).split(" ")
		const oldOid = fields[2]
		const newOid = fields[3]
		if (!oldOid || !newOid) continue
		if (/^0+$/.test(oldOid) || oldOid === newOid) continue
		if (!pairs.has(newOid)) pairs.set(newOid, oldOid)
	}
	return pairs
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const scratch: string[] = []
	const mkdir = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-delta-probe-${tag}-`))
		scratch.push(d)
		return d
	}

	// --- the repo under test ------------------------------------------------
	const src = join(mkdir("src"), "repo")
	if (REPO) {
		console.log(`# delta-probe — real repo: ${REPO}\n`)
		// Copy before touching anything: the customer mirror stays pristine.
		cpSync(REPO, src, { recursive: true })
	} else {
		console.log(`# delta-probe — generated shape: ${RUNS} runs, ${DOC_COUNT} docs\n`)
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
	}
	const commits = (
		await spawnGit(["rev-list", "--count", "--all"], { cwd: src })
	).stdout.trim()

	// --- A. git's own numbers ----------------------------------------------
	const objects = await reachableObjects(src)
	const byType = new Map<string, { count: number; raw: number; deflated: number }>()
	const deflatedOf = new Map<string, number>()
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
	console.log("| type | count | raw | individually deflated (what pggit serves) |")
	console.log("|---|---|---|---|")
	let rawTotal = 0
	let deflatedTotal = 0
	for (const [type, s] of [...byType.entries()].sort((a, b) => b[1].raw - a[1].raw)) {
		rawTotal += s.raw
		deflatedTotal += s.deflated
		console.log(`| ${type} | ${s.count} | ${mb(s.raw)} | ${mb(s.deflated)} |`)
	}
	console.log(
		`| **total** | **${objects.length}** | **${mb(rawTotal)}** | **${mb(deflatedTotal)}** |`,
	)

	const gcDir = join(mkdir("gc"), "repo")
	cpSync(src, gcDir, { recursive: true })
	const gcStart = Date.now()
	await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: gcDir })
	const gcMs = Date.now() - gcStart
	const sizePack =
		Number(
			(await spawnGit(["count-objects", "-v"], { cwd: gcDir })).stdout.match(
				/size-pack: (\d+)/,
			)?.[1] ?? 0,
		) * 1024
	console.log(
		`\n\`git gc --aggressive\`: **${mb(sizePack)}** in ${secs(gcMs)} → ` +
			`**${(deflatedTotal / sizePack).toFixed(1)}×** smaller than what pggit serves`,
	)

	// --- B / C: a real pggit schema ----------------------------------------
	console.log(`\n## B. the Postgres side\n`)
	const db = await createIsolatedSchema(PG_URL)
	try {
		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const ingestStart = Date.now()
		let batch: Obj[] = []
		let batchBytes = 0
		const flush = async (): Promise<void> => {
			if (batch.length === 0) return
			await store.putPack(
				REPO_ID,
				batch.map((o) => ({
					content: o.content,
					type: o.type as "blob" | "commit" | "tag" | "tree",
				})),
			)
			batch = []
			batchBytes = 0
		}
		for (const o of objects) {
			batch.push(o)
			batchBytes += o.content.length
			if (batchBytes >= INGEST_BYTES) await flush()
		}
		await flush()
		const ingestMs = Date.now() - ingestStart

		for (const line of (await spawnGit(["show-ref", "--heads"], { cwd: src })).stdout
			.trim()
			.split("\n")) {
			const [oid, name] = line.split(" ")
			if (oid && name) await refs.setRef(REPO_ID, name, oid)
		}
		const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()
		await refs.setSymref(REPO_ID, "HEAD", head)
		console.log(`ingested ${objects.length} objects in ${secs(ingestMs)}`)

		const [sizes] = await db.sql<{ total: string; heap: string; indexes: string }[]>`
			select
				sum(pg_total_relation_size(inhrelid))::text as total,
				sum(pg_relation_size(inhrelid))::text as heap,
				sum(pg_indexes_size(inhrelid))::text as indexes
			from pg_inherits where inhparent = 'git_object'::regclass`
		const total = Number(sizes?.total ?? 0)
		const heap = Number(sizes?.heap ?? 0)
		const idx = Number(sizes?.indexes ?? 0)
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
		const [topoRows] = await db.sql<{ commits: string; tags: string }[]>`
			select (select count(*) from git_commit)::text as commits,
				(select count(*) from git_tag)::text as tags`
		console.log(
			`\ntopology rows (\`git_commit\` + \`git_tag\`) on disk: ` +
				`**${mb(Number(topoSizes?.total ?? 0))}** — ${topoRows?.commits} commit rows, ` +
				`${topoRows?.tags} tag rows (linear in history; the quadratic git_edge table is gone, S2)`,
		)

		await db.sql`create table probe_trees (content bytea compression lz4)`
		await db.sql`insert into probe_trees select content from git_object where type = 2`
		const [treeSize] = await db.sql<{ n: string }[]>`
			select pg_total_relation_size('probe_trees')::text as n`
		const treeRaw = byType.get("tree")?.raw ?? 0
		if (treeRaw > 0) {
			console.log(
				`trees alone: ${mb(treeRaw)} raw → **${mb(Number(treeSize?.n ?? 0))}** stored ` +
					`(lz4 leaves ${((Number(treeSize?.n ?? 0) / treeRaw) * 100).toFixed(0)}%)`,
			)
		}

		// --- C. the clone side ------------------------------------------------
		console.log(`\n## C. the clone side\n`)
		const app = createGitApp(createGitDeps(db.sql), { instrument: true })
		const server = await serveOnPort(app, 0)
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

		const fetchRun = collectedRuns().find((r) => r.label === "fetch")
		const closureMs = fetchRun?.phaseMs.get("closure") ?? 0
		const encodeMs = fetchRun?.phaseMs.get("pack-encode") ?? 0
		const packBytes = fetchRun?.counters.get("packBytes") ?? 0

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
				`${((deflateOnlyMs / Math.max(encodeMs, 1)) * 100).toFixed(0)}% of pack-encode ` +
				`(the remainder is the Postgres read)`,
		)

		// --- C2. the clone side, AFTER repack --------------------------------
		// The implemented pipeline end to end: run the real repack over the same
		// schema, then a second real clone. This is the number the whole track
		// exists to change; everything above is its baseline.
		console.log(`\n## C2. the clone after repack (the implemented fix)\n`)
		const repackStart = Date.now()
		const repackResult = await createRepack(db.sql).repack(REPO_ID)
		console.log(
			`repack: ${repackResult.wholes} wholes + ${repackResult.deltas} deltas in ${secs(Date.now() - repackStart)}`,
		)
		const server2 = await serveOnPort(
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
		const fetchRun2 = collectedRuns().find((r) => r.label === "fetch")
		const packBytes2 = fetchRun2?.counters.get("packBytes") ?? 0
		const deltasServed = fetchRun2?.counters.get("deltasServed") ?? 0
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest2 })
		console.log(
			`clone wall **${secs(clone2Ms)}** (was ${secs(cloneMs)}), ` +
				`pack **${mb(packBytes2)}** (was ${mb(packBytes)}) — ` +
				`**${(packBytes / Math.max(packBytes2, 1)).toFixed(1)}×** smaller, ` +
				`${deltasServed} entries served as deltas, fsck-clean`,
		)
		console.log(
			`server CPU during clone: ${(cpu2.user / 1000).toFixed(0)}ms user (was ${(cpu.user / 1000).toFixed(0)}ms)`,
		)

		// --- D. delta feasibility --------------------------------------------
		console.log(`\n## D. does a CHEAP base heuristic match git?\n`)
		const byOid = new Map(objects.map((o) => [o.oid, o]))
		const pairs = await basePairs(src)

		// The combination that matters is (structural base) × (forward chaining) × (depth
		// cap) — NOT any one of them alone. A cap forces every (cap+1)-th version of a
		// growing tree to be stored WHOLE, and on this shape a whole tree is enormous, so
		// the cap's cost here is nothing like the cost of capping git (whose window search
		// can point many deltas at ONE base, a star rather than a chain, and so pays far
		// less for shallow depth). Sweep it rather than assume.
		const encodeStart = Date.now()
		let verified = 0
		const rows: string[] = []
		for (const cap of [1, 2, 3, 4, 8, 16, Number.POSITIVE_INFINITY]) {
			let deltaBytes = 0
			let wholeBytes = 0
			let deltified = 0
			const depthOf = new Map<string, number>()

			// Oldest-first: a base's representation must be final before its dependents are
			// considered, or a target recorded at depth 1 silently deepens later.
			for (const o of objects) {
				if (o.type !== "tree") continue
				depthOf.set(o.oid, 0)
			}
			for (const [targetOid, baseOid] of pairs) {
				const target = byOid.get(targetOid)
				const base = byOid.get(baseOid)
				if (!target || !base || target.type !== "tree" || base.type !== "tree") continue
				const candidate = (depthOf.get(baseOid) ?? 0) + 1
				if (candidate > cap) continue // stays whole, depth 0
				const whole = deflatedOf.get(targetOid) as number
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
				if (o.type === "tree" && (depthOf.get(o.oid) ?? 0) > 0) continue
				wholeBytes += deflatedOf.get(o.oid) as number
			}
			const total = deltaBytes + wholeBytes
			rows.push(
				`| ${cap === Number.POSITIVE_INFINITY ? "uncapped" : cap} | ${mb(total)} | ` +
					`${(deflatedTotal / total).toFixed(1)}× | ${deltified} |`,
			)
		}
		console.log(
			`${verified} deltas encoded and round-tripped through this repo's own \`applyDelta\` — all exact`,
		)
		console.log(`encode+verify sweep: ${secs(Date.now() - encodeStart)}\n`)
		console.log("| depth cap | served size | vs today | trees deltified |")
		console.log("|---|---|---|---|")
		for (const r of rows) console.log(r)
		console.log(
			`\nfor reference — pggit today **${mb(deflatedTotal)}**, ` +
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
		const lineageNext = new Map<string, string>()
		for (const [target, base] of pairs) lineageNext.set(base, target)
		const lineageHeads = [...pairs.values()].filter((b) => !pairs.has(b))
		const anchorRows: string[] = []
		for (const K of [4, 8, 16, 32, 64, 128]) {
			let bytes = 0
			const deltaOf = new Set<string>()
			for (const head of new Set(lineageHeads)) {
				let anchor = head
				let cursor: string | undefined = head
				let i = 0
				while (cursor) {
					const obj = byOid.get(cursor)
					if (obj?.type === "tree") {
						if (i % K === 0) {
							anchor = cursor
						} else {
							const base = byOid.get(anchor)
							if (base?.type === "tree") {
								const delta = encodeDelta(base.content, obj.content)
								if (!applyDelta(base.content, delta).equals(obj.content)) {
									throw new Error(`star encodeDelta round-trip FAILED for ${cursor}`)
								}
								const encoded = deflateSync(delta).length
								if (encoded < (deflatedOf.get(cursor) as number)) {
									bytes += encoded
									deltaOf.add(cursor)
								}
							}
						}
						i++
					}
					cursor = lineageNext.get(cursor)
				}
			}
			for (const o of objects)
				if (!deltaOf.has(o.oid)) bytes += deflatedOf.get(o.oid) as number
			anchorRows.push(
				`| ${K} | 1 | ${mb(bytes)} | ${(deflatedTotal / bytes).toFixed(1)}× | ${deltaOf.size} |`,
			)
		}
		console.log(
			"| anchor every K | max depth | served size | vs today | trees deltified |",
		)
		console.log("|---|---|---|---|---|")
		for (const r of anchorRows) console.log(r)
	} finally {
		await db.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

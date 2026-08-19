/**
 * pgres — DOES THE ENCODING TIER'S DECLARED STORAGE PROFILE ACTUALLY EXIST?
 *
 * Settles design Concern C4 ("inline `STORAGE EXTERNAL` on the partitioned parent
 * propagates to leaf partitions — UNVERIFIED EXPECTATION; check before release")
 * and audits the leaf reloptions against the profile migration 0008's own comment
 * claims it copies ("the delete-aware profile the GC sweep already gave
 * git_object/git_edge (0005)").
 *
 * Two independent judges:
 *  (a) CATALOG — `pg_attribute.attstorage` / `attcompression` on the `data` column
 *      of the parent and of every leaf; `pg_class.reloptions` on the encoding
 *      leaves vs the git_object leaves they claim to mirror, and on both TOAST
 *      relations.
 *  (b) OBSERVED PLACEMENT — seed two repos at opposite ends of the size
 *      distribution (narrow trees → sub-TOAST-threshold rows; 3000-entry trees →
 *      100 KB+ anchor rows), repack each, and read the heap/TOAST byte split from
 *      `pg_relation_size`. A column that is genuinely EXTERNAL puts every oversize
 *      value out of line UNCOMPRESSED; a column that silently fell back to
 *      EXTENDED would compress it first (already-deflated bytes → wasted CPU and a
 *      different byte split).
 *
 * ROUTING NOTE (why this one lens sibling is an e2e test and not a perf harness):
 * every verdict here is a DISCRETE catalog fact over a hermetically-built fixture —
 * a storage class, a reloptions set, whether the out-of-line payload was compressed
 * on its way to TOAST. The byte numbers are read as evidence for those facts, not
 * as a threshold on cost. The rest of the `pgres--*` lens (churn bloat, GC pass
 * overhead, snapshot hold, pool contention, WAL per repack) prices resources and
 * lives in `perf/breakage/`.
 *
 * The source probe EXITED non-zero when: any leaf's `data` column is not
 * `attstorage='e'` (C4 falsified), or observed TOAST bytes for the wide-tree repo
 * are smaller than the stored deflated bytes they must hold out of line (a second
 * compression pass). It REPORTED the reloptions drift rather than bounding it ("a
 * policy question, not a hard bound") — but 0008's own comment is the claim that
 * the profile was copied, so the correct behaviour is parity and that is what is
 * asserted here. `autovacuum_vacuum_cost_delay=0` was the key 0005 gave
 * git_object and 0008 originally did not give the encoding leaves; 0008 carries
 * it now, and this pins it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "storage-profile"
/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const RUNS_DIR = ".engine/runs/planner-updates"

// ── fixture plumbing (inlined from the probe; e2e tests carry their own helpers) ──

function hash32(s: string): string {
	// tiny deterministic hex generator (no crypto import churn in hot loops)
	let h1 = 0x811c9dc5
	let h2 = 0x01000193
	for (let i = 0; i < s.length; i++) {
		h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0
		h2 = Math.imul(h2 + s.charCodeAt(i), 2654435761) >>> 0
	}
	return (
		(h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")
	)
}

/** Deterministic, poorly-compressible hex filler. */
function filler(salt: string, len: number): string {
	let out = ""
	let i = 0
	while (out.length < len) out += hash32(`${salt}-${i++}`)
	return out.slice(0, len)
}

function runDirName(salt: string, i: number): string {
	const h = `${hash32(`${salt}-run-${i}`)}${hash32(`${salt}-run2-${i}`)}${hash32(`${salt}-run3-${i}`)}${hash32(`${salt}-run4-${i}`)}`
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** A fast-import stream fragment: `count` append-only run commits onto `from`. */
function runCommits(opts: {
	salt: string
	count: number
	from?: string
	blobChars: number
	markStart: number
}): string {
	const out: string[] = []
	let mark = opts.markStart
	const next = () => ++mark
	const blob = (content: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return m
	}
	let from = opts.from
	for (let i = 0; i < opts.count; i++) {
		const dir = runDirName(opts.salt, i)
		const record = blob(
			`{"run":"${dir}","payload":"${filler(`${opts.salt}-rec-${i}`, opts.blobChars)}"}\n`,
		)
		const stderr = blob(`${filler(`${opts.salt}-err-${i}`, 120)}\n`)
		const cm = next()
		const msg = `${opts.salt} run ${i}`
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\n` +
				(from ? `from ${from}\n` : "") +
				`M 100644 :${record} ${RUNS_DIR}/${dir}/record.json\n` +
				`M 100644 :${stderr} ${RUNS_DIR}/${dir}/stderr\n`,
		)
		from = `:${cm}`
	}
	return out.join("")
}

/** A fast-import stream whose runs directory is WIDE — `width` entries seeded up
 * front, then `commits` appends — so the runs tree object is 100 KB+ and its whole
 * ("anchor") encoding is far past any TOAST threshold. */
function wideStream(width: number, commits: number, blobChars: number): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (c: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(c)}\n${c}\n`)
		return m
	}
	const seeded: string[] = []
	for (let i = 0; i < width; i++) {
		const m = blob(`${filler(`wide-${i}`, blobChars)}\n`)
		const h = filler(`name-${i}`, 32)
		seeded.push(
			`M 100644 :${m} ${RUNS_DIR}/${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}/record.json`,
		)
	}
	const seed = next()
	out.push(
		`commit refs/heads/main\nmark :${seed}\ncommitter ${COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	out.push(
		runCommits({
			blobChars,
			count: commits,
			from: `:${seed}`,
			markStart: mark,
			salt: "wide",
		}),
	)
	return out.join("")
}

type Obj = { oid: string; type: string; content: Buffer }

/** Every object reachable from `tip`, via ONE `cat-file --batch` (never a spawn each). */
async function reachableObjects(dir: string, tip: string): Promise<Obj[]> {
	const list = await spawnGit(["rev-list", "--objects", tip], { cwd: dir })
	const oids = [
		...new Set(
			list.stdout
				.split("\n")
				.map((l) => l.slice(0, 40))
				.filter((o) => /^[0-9a-f]{40}$/.test(o)),
		),
	]
	if (oids.length === 0) return []
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
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

type Measured = { heap: number; toast: number; idx: number; data: number; rows: number }

describe("encoding tier storage profile — C4 propagation + the 0008 reloptions claim", () => {
	let db: IsolatedDb
	const scratch: string[] = []
	let narrow: Measured
	let wide: Measured

	/** `git_pack_encoding`'s exact on-disk split, summed across its 16 hash leaves. */
	async function encodingStorage(): Promise<{
		heap: number
		idx: number
		toast: number
	}> {
		const [r] = await db.sql<{ heap: string; idx: string; toast: string }[]>`
			select
				coalesce(sum(pg_relation_size(c.oid)), 0)::text as heap,
				coalesce(sum(pg_indexes_size(c.oid)), 0)::text as idx,
				coalesce(sum(coalesce(pg_total_relation_size(c.reltoastrelid), 0)), 0)::text as toast
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = ${db.schema}
				and c.relkind = 'r' and c.relname like 'git_pack_encoding%'`
		return {
			heap: Number(r?.heap ?? 0),
			idx: Number(r?.idx ?? 0),
			toast: Number(r?.toast ?? 0),
		}
	}

	/** Rows currently in the encoding tier, and the deflated bytes they hold. */
	async function encodingCensus(): Promise<{ rows: number; dataBytes: number }> {
		const [r] = await db.sql<{ rows: string; bytes: string }[]>`
			select count(*)::text as rows,
				coalesce(sum(octet_length(data)), 0)::text as bytes
			from git_pack_encoding`
		return { dataBytes: Number(r?.bytes ?? 0), rows: Number(r?.rows ?? 0) }
	}

	/** The `data` column's storage class on the parent and every leaf partition. */
	async function dataColumnStorage(): Promise<
		{ relname: string; relkind: string; attstorage: string; attcompression: string }[]
	> {
		return await db.sql<
			{ relname: string; relkind: string; attstorage: string; attcompression: string }[]
		>`
			select c.relname, c.relkind::text as relkind, a.attstorage::text as attstorage,
				coalesce(nullif(a.attcompression::text, ''), '(default)') as attcompression
			from pg_attribute a
				join pg_class c on c.oid = a.attrelid
				join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = ${db.schema}
				and c.relname like 'git_pack_encoding%'
				and a.attname = 'data'
			order by c.relkind desc, c.relname`
	}

	/** Seed one repo through the public store, repack it, and measure the tier. */
	async function build(repo: string, stream: string): Promise<Measured> {
		const root = mkdtempSync(join(tmpdir(), `pggit-${repo}-`))
		scratch.push(root)
		const dir = join(root, "repo")
		mkdirSync(dir, { recursive: true })
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		await spawnGit(["fast-import", "--quiet", "--force"], { cwd: dir, input: stream })
		const tip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dir })
		).stdout.trim()

		const store = createObjectStore(db.sql)
		let batch: Obj[] = []
		let bytes = 0
		const flush = async (): Promise<void> => {
			if (batch.length === 0) return
			await store.putPack(
				repo,
				batch.map((o) => ({
					content: o.content,
					type: o.type as "blob" | "commit" | "tag" | "tree",
				})),
			)
			batch = []
			bytes = 0
		}
		for (const o of await reachableObjects(dir, tip)) {
			batch.push(o)
			bytes += o.content.length
			if (bytes >= 12_000_000 || batch.length >= 5000) await flush()
		}
		await flush()
		await createRefStore(db.sql).setRef(repo, "refs/heads/main", tip)
		await createRepack(db.sql).repack(repo)

		const storage = await encodingStorage()
		const census = await encodingCensus()
		return {
			data: census.dataBytes,
			heap: storage.heap,
			idx: storage.idx,
			rows: census.rows,
			toast: storage.toast,
		}
	}

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		// Both ends of the size distribution, in ONE schema: the wide repo's own
		// contribution to the cumulative byte counters is read by difference.
		narrow = await build(
			`${REPO}-narrow`,
			runCommits({ blobChars: 120, count: 120, markStart: 0, salt: "narrow" }),
		)
		// 300 commits ⇒ ~9 anchors at ANCHOR_EVERY=32, each a ~100KB+ whole of the
		// 3000-entry tree — comfortably past the 1MB oversize gate below (80 commits
		// landed ~2 anchors ≈ 560KB, under its own precondition).
		wide = await build(`${REPO}-wide`, wideStream(3000, 300, 400))
	}, 300_000)

	afterAll(async () => {
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("propagates inline STORAGE EXTERNAL from the partitioned parent to every leaf (C4)", async () => {
		const cols = await dataColumnStorage()
		const parent = cols.find((c) => c.relkind === "p")
		const leaves = cols.filter((c) => c.relkind === "r")
		expect(parent?.attstorage).toBe("e") // 'e' = EXTERNAL: out of line, UNCOMPRESSED
		expect(leaves.length).toBeGreaterThan(0)
		expect(
			leaves.filter((l) => l.attstorage !== "e").map((l) => l.relname),
			`leaf partitions whose data column is NOT EXTERNAL (attcompression seen: ${[
				...new Set(leaves.map((l) => l.attcompression)),
			].join(",")})`,
		).toEqual([])
	})

	it("gives the encoding leaves the delete-aware autovacuum profile 0008 claims to copy from git_object", async () => {
		const opts = await db.sql<{ relname: string; reloptions: string[] | null }[]>`
			select c.relname, c.reloptions
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = ${db.schema}
				and c.relname in ('git_pack_encoding_p0', 'git_object_p0', 'git_edge_p0')`
		const byName = new Map(opts.map((o) => [o.relname, new Set(o.reloptions ?? [])]))
		const enc = byName.get("git_pack_encoding_p0") ?? new Set<string>()
		const obj = byName.get("git_object_p0") ?? new Set<string>()
		const missing = [...obj].filter((k) => !enc.has(k))

		// The global default the missing key would have overridden — the reason the drift
		// bites: unset means the reclaim is throttled at the instance's cost_delay.
		const [gd] = await db.sql<{ setting: string }[]>`
			select setting from pg_settings where name = 'autovacuum_vacuum_cost_delay'`

		expect(obj.size).toBeGreaterThan(0) // the comparator itself must exist
		expect(
			missing,
			`reloptions on git_object_p0 but MISSING on git_pack_encoding_p0 (instance autovacuum_vacuum_cost_delay = ${gd?.setting}ms applies where unset); keys only on the encoding leaf: ${
				[...enc].filter((k) => !obj.has(k)).join(", ") || "(none)"
			}`,
		).toEqual([])
	})

	it("gives the encoding leaf's TOAST relation git_object's TOAST profile (where the `toast.*` keys land)", async () => {
		const toastOpts = await db.sql<{ owner: string; reloptions: string[] | null }[]>`
			select c.relname as owner, t.reloptions
			from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				join pg_class t on t.oid = c.reltoastrelid
			where n.nspname = ${db.schema}
				and c.relname in ('git_pack_encoding_p0', 'git_object_p0')`
		const byName = new Map(toastOpts.map((o) => [o.owner, new Set(o.reloptions ?? [])]))
		const tEnc = byName.get("git_pack_encoding_p0") ?? new Set<string>()
		const tObj = byName.get("git_object_p0") ?? new Set<string>()
		expect(
			[...tObj].filter((k) => !tEnc.has(k)),
			"reloptions on git_object_p0's TOAST relation but missing on git_pack_encoding_p0's",
		).toEqual([])
	})

	it("stores the out-of-line payload UNCOMPRESSED — EXTERNAL is in effect end to end", async () => {
		// Per-repo bytes by difference: the schema-level counters are cumulative.
		const wideData = wide.data - narrow.data
		const wideToast = wide.toast - narrow.toast
		const wideHeap = wide.heap - narrow.heap

		// The size distribution is evidence that the tier really does hold 100 KB+
		// values (a distribution, not a row-content assertion).
		const [d] = await db.sql<
			{ p50: string; p99: string; maxv: string; over2k: string }[]
		>`
			select
				percentile_disc(0.5) within group (order by octet_length(data))::text as p50,
				percentile_disc(0.99) within group (order by octet_length(data))::text as p99,
				max(octet_length(data))::text as maxv,
				count(*) filter (where octet_length(data) > 2000)::text as over2k
			from git_pack_encoding`
		const [big] = await db.sql<{ bytes: string; n: string }[]>`
			select coalesce(sum(octet_length(data)), 0)::text as bytes, count(*)::text as n
			from git_pack_encoding where octet_length(data) > 2000`
		const bigBytes = Number(big?.bytes ?? 0)

		const evidence =
			`narrow: ${narrow.rows} rows, ${narrow.data}B deflated, heap ${narrow.heap}B / TOAST ${narrow.toast}B / idx ${narrow.idx}B · ` +
			`wide: ${wide.rows - narrow.rows} rows, ${wideData}B deflated, heap ${wideHeap}B / TOAST ${wideToast}B · ` +
			`sizes p50=${d?.p50}B p99=${d?.p99}B max=${d?.maxv}B rows>2KB=${d?.over2k}`

		// The fixture precondition the source probe used as its FAIL gate: without a
		// megabyte of oversize rows the placement check would be vacuous.
		expect(
			bigBytes,
			`oversize payload too small to judge placement — ${evidence}`,
		).toBeGreaterThan(1_000_000)
		// EXTERNAL means out-of-line and UNCOMPRESSED: the TOAST relation must hold at
		// least the raw deflated bytes of everything it took out of line. Materially
		// SMALLER than the >2KB payload it holds ⇒ a second (pglz) pass ran.
		expect(
			wide.toast,
			`TOAST is materially smaller than the out-of-line payload (${bigBytes}B across ${big?.n} rows) — the column is being compressed. ${evidence}`,
		).toBeGreaterThanOrEqual(bigBytes * 0.9)
	})

	it("survives a GC pass with the storage profile untouched", async () => {
		const fingerprint = (
			cols: { relname: string; attstorage: string; attcompression: string }[],
		): string[] => cols.map((c) => `${c.relname}:${c.attstorage}:${c.attcompression}`)
		const before = fingerprint(await dataColumnStorage())
		await createGc(db.sql).gc(`${REPO}-wide`, { graceSeconds: 3600 })
		expect(fingerprint(await dataColumnStorage())).toEqual(before)
	})
})

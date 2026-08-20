/**
 * pgres — DOES THE ENCODING TIER'S DECLARED STORAGE PROFILE ACTUALLY EXIST?
 *
 * Turns design Concern C4's original unverified `STORAGE EXTERNAL` propagation
 * expectation into a live contract and audits the leaf reloptions against the
 * delete-aware profile migration 0008 copies from `git_object` (0005).
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
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import {
	appendLifecycleLineage,
	createAppendOnlyRepo,
	FAST_IMPORT_COMMITTER,
	RUNS_DIR,
	runDirName,
} from "@/testing/append-only-repo"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "storage-profile"

type Measured = { heap: number; toast: number; idx: number; data: number; rows: number }

describe("encoding tier storage profile — C4 propagation + the 0008 reloptions claim", () => {
	let db: IsolatedDb
	const scratch: string[] = []
	let narrow: Measured
	let wide: Measured

	function scratchDir(tag: string): string {
		const dir = mkdtempSync(join(tmpdir(), `pggit-${tag}-`))
		scratch.push(dir)
		return dir
	}

	/** Seed one wide tree, then use the canonical lifecycle appender for its lineage. */
	async function createWideRepo(width: number, commits: number): Promise<string> {
		const dir = scratchDir("storage-profile-wide")
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		const blobs: string[] = []
		const entries: string[] = []
		for (let i = 0; i < width; i++) {
			const content = `${i}\n`
			const mark = i + 1
			blobs.push(`blob\nmark :${mark}\ndata ${Buffer.byteLength(content)}\n${content}`)
			entries.push(`M 100644 :${mark} ${RUNS_DIR}/${runDirName(i)}/record.json`)
		}
		const commitMark = width + 1
		await spawnGit(["fast-import", "--quiet"], {
			cwd: dir,
			input:
				`${blobs.join("")}commit refs/heads/main\nmark :${commitMark}\n` +
				`committer ${FAST_IMPORT_COMMITTER}\ndata 4\nseed\n${entries.join("\n")}\n`,
		})
		const seed = (await spawnGit(["rev-parse", "main"], { cwd: dir })).stdout.trim()
		await appendLifecycleLineage(dir, "main", seed, "wide", commits)
		return dir
	}

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
		if (r === undefined) throw new Error("encoding storage aggregate returned no row")
		return {
			heap: Number(r.heap),
			idx: Number(r.idx),
			toast: Number(r.toast),
		}
	}

	/** Rows currently in the encoding tier, and the deflated bytes they hold. */
	async function encodingCensus(): Promise<{ rows: number; dataBytes: number }> {
		const [r] = await db.sql<{ rows: string; bytes: string }[]>`
			select count(*)::text as rows,
				coalesce(sum(octet_length(data)), 0)::text as bytes
			from git_pack_encoding`
		if (r === undefined) throw new Error("encoding census aggregate returned no row")
		return { dataBytes: Number(r.bytes), rows: Number(r.rows) }
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

	/** Seed one repo through the canonical store fixture, repack it, and measure. */
	async function build(repo: string, dir: string): Promise<Measured> {
		await seedRepoIntoStore(repo, dir, {
			objects: createObjectStore(db.sql),
			refs: createRefStore(db.sql),
		})
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
		const narrowDir = await createAppendOnlyRepo({ runs: 120 })
		scratch.push(narrowDir)
		narrow = await build(`${REPO}-narrow`, narrowDir)
		// 300 commits ⇒ ~9 anchors at ANCHOR_EVERY=32, each a ~100KB+ whole of the
		// 3000-entry tree — comfortably past the 1MB oversize gate below (80 commits
		// landed ~2 anchors ≈ 560KB, under its own precondition).
		wide = await build(`${REPO}-wide`, await createWideRepo(3000, 300))
	}, 300_000)

	afterAll(async () => {
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("propagates inline STORAGE EXTERNAL from the partitioned parent to every leaf (C4)", async () => {
		const cols = await dataColumnStorage()
		const parent = cols.find((c) => c.relkind === "p")
		const leaves = cols.filter((c) => c.relkind === "r")
		if (parent === undefined) throw new Error("catalog omitted git_pack_encoding parent")
		expect(parent.attstorage).toBe("e") // 'e' = EXTERNAL: out of line, UNCOMPRESSED
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
				and c.relname in ('git_pack_encoding_p0', 'git_object_p0', 'git_commit_p0')`
		const byName = new Map(opts.map((o) => [o.relname, new Set(o.reloptions ?? [])]))
		const enc = byName.get("git_pack_encoding_p0")
		const obj = byName.get("git_object_p0")
		const commit = byName.get("git_commit_p0")
		if (enc === undefined || obj === undefined || commit === undefined) {
			throw new Error("expected reloptions rows for object, encoding, and commit leaves")
		}
		const missing = [...obj].filter((k) => !enc.has(k))
		// The 0009 tables cascade-churn on every GC pass too; their leaves carry the
		// same delete-aware profile (the spine doc's "0005/0008 profile" rule).
		const missingOnCommit = [...obj].filter((k) => !commit.has(k))

		// The global default the missing key would have overridden — the reason the drift
		// bites: unset means the reclaim is throttled at the instance's cost_delay.
		const [gd] = await db.sql<{ setting: string }[]>`
			select setting from pg_settings where name = 'autovacuum_vacuum_cost_delay'`
		if (gd === undefined) {
			throw new Error("pg_settings omitted autovacuum_vacuum_cost_delay")
		}

		expect(obj.size).toBeGreaterThan(0) // the comparator itself must exist
		expect(
			missing,
			`reloptions on git_object_p0 but MISSING on git_pack_encoding_p0 (instance autovacuum_vacuum_cost_delay = ${gd.setting}ms applies where unset); keys only on the encoding leaf: ${
				[...enc].filter((k) => !obj.has(k)).join(", ") || "(none)"
			}`,
		).toEqual([])
		expect(
			missingOnCommit,
			"reloptions on git_object_p0 but MISSING on git_commit_p0 (0009 must carry the delete-aware profile)",
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
		const tEnc = byName.get("git_pack_encoding_p0")
		const tObj = byName.get("git_object_p0")
		if (tEnc === undefined || tObj === undefined) {
			throw new Error("expected TOAST reloptions rows for object and encoding leaves")
		}
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
		if (d === undefined || big === undefined) {
			throw new Error("encoding size aggregate returned no row")
		}
		const bigBytes = Number(big.bytes)

		const evidence =
			`narrow: ${narrow.rows} rows, ${narrow.data}B deflated, heap ${narrow.heap}B / TOAST ${narrow.toast}B / idx ${narrow.idx}B · ` +
			`wide: ${wide.rows - narrow.rows} rows, ${wideData}B deflated, heap ${wideHeap}B / TOAST ${wideToast}B · ` +
			`sizes p50=${d.p50}B p99=${d.p99}B max=${d.maxv}B rows>2KB=${d.over2k}`

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
			`TOAST is materially smaller than the out-of-line payload (${bigBytes}B across ${big.n} rows) — the column is being compressed. ${evidence}`,
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

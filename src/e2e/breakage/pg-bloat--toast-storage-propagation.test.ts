/**
 * pg-bloat--toast-storage-propagation — settles design-doc Concern **C4**.
 *
 * `0008_pack_encoding.ts` declares `data bytea storage external` INLINE on the
 * HASH-partitioned PARENT `git_pack_encoding`, asserting (from the 0001 precedent
 * that inline COMPRESSION propagates) that the attribute reaches all 16 leaf
 * partitions. The design doc records this as an UNVERIFIED EXPECTATION and asks
 * for the one-line catalog check before release. This file is that check, plus
 * a behavioural proof that does not trust the catalog alone, plus the cost
 * accounting for whichever way it lands.
 *
 * WHAT IT ASSERTS
 *   1. `pg_attribute.attstorage` / `attcompression` for `git_pack_encoding.data`
 *      and `git_object.content` on the parent AND every leaf partition.
 *   2. A controlled A/B: two locally-created hash-partitioned tables, one with
 *      inline `storage external` on the parent and one without, fed the SAME
 *      highly-compressible payload. `pg_column_size` separates them absolutely —
 *      a compressed value is orders of magnitude smaller than its plaintext.
 *   3. The same probe against the REAL `git_pack_encoding` leaf (a synthetic
 *      compressible row, inserted and removed) — the decisive test, because it
 *      asks the shipped table rather than a replica of its DDL.
 *   4. What the real repack's output actually costs: `octet_length` vs
 *      `pg_column_size` per encoding row, how many rows go out-of-line into
 *      TOAST, and whether a second compression pass over already-deflated bytes
 *      would recover anything.
 *
 * The source repro EXITED NON-ZERO when any leaf partition's
 * `git_pack_encoding.data` was not `attstorage = 'e'` (external) — i.e. the
 * migration's asserted propagation did not happen and every encoding row is
 * paying a second compression pass over already-deflated bytes. Here that
 * criterion is inverted into the assertion of CORRECT behaviour: every leaf IS
 * external, and nothing compresses the tier's bytes a second time.
 *
 * Fixture: the append-only shape (one run directory per commit) at the repro's
 * scale — 300 run commits over 20 docs.
 */
import { rmSync } from "node:fs"
import { deflateSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

const REPO = "workspace/slate/toast-probe"
const RUNS = 300
const DOCS = 20

type AttrRow = {
	relname: string
	attname: string
	attstorage: string
	attcompression: string
}

describe("TOAST storage propagation on the partitioned encoding tier (C4)", () => {
	let db: IsolatedDb
	let src = ""
	let repacked = { deltas: 0, wholes: 0 }

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		src = await createAppendOnlyRepo({ docs: DOCS, runs: RUNS })
		await seedRepoIntoStore(REPO, src, {
			objects: createObjectStore(db.sql),
			refs: createRefStore(db.sql),
		})
		repacked = await createRepack(db.sql).repack(REPO)
	}, 300_000)

	afterAll(async () => {
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	async function attrs(): Promise<AttrRow[]> {
		return await db.sql<AttrRow[]>`
			select c.relname, a.attname, a.attstorage, a.attcompression
			from pg_attribute a
				join pg_class c on c.oid = a.attrelid
				join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = current_schema()
				and ((c.relname = 'git_pack_encoding' or c.relname like 'git\\_pack\\_encoding\\_p%') and a.attname = 'data'
					or (c.relname = 'git_object' or c.relname like 'git\\_object\\_p%') and a.attname = 'content')
			order by a.attname, length(c.relname), c.relname`
	}

	it("declares STORAGE EXTERNAL on git_pack_encoding.data in EVERY leaf partition", async () => {
		// The catalog check the design doc never ran. `e` = external: out-of-line,
		// never compressed — which is the whole point for bytes that are already
		// deflated.
		const rows = (await attrs()).filter(
			(r) => r.attname === "data" && r.relname.startsWith("git_pack_encoding"),
		)
		const parent = rows.find((r) => r.relname === "git_pack_encoding")
		const leaves = rows.filter((r) => r.relname !== "git_pack_encoding")
		if (parent === undefined) throw new Error("catalog omitted git_pack_encoding parent")
		expect(parent.attstorage).toBe("e")
		// Without this the `filter` below would pass vacuously on an empty match.
		expect(leaves.length).toBeGreaterThan(0)
		expect(leaves.filter((l) => l.attstorage !== "e").map((l) => l.relname)).toEqual([])
	})

	it("propagates the parent's storage to git_object.content leaves too", async () => {
		// The control for the same propagation question on the table that has always
		// shipped this way (inline COMPRESSION on the parent — the 0001 precedent the
		// migration reasoned from).
		const rows = (await attrs()).filter(
			(r) => r.attname === "content" && r.relname.startsWith("git_object"),
		)
		const parent = rows.find((r) => r.relname === "git_object")
		const leaves = rows.filter((r) => r.relname !== "git_object")
		if (parent === undefined) throw new Error("catalog omitted git_object parent")
		expect(leaves.length).toBeGreaterThan(0)
		expect(
			leaves.filter(
				(l) =>
					l.attstorage !== parent.attstorage ||
					l.attcompression !== parent.attcompression,
			),
		).toEqual([])
	})

	it("declares STORAGE EXTERNAL on the unpartitioned reach-epoch blobs (0012)", async () => {
		// The 0012 tables are UNPARTITIONED, so the catalog check reads attstorage
		// straight off them — no leaf propagation question exists here.
		const rows = await db.sql<AttrRow[]>`
			select c.relname, a.attname, a.attstorage, a.attcompression
			from pg_attribute a
				join pg_class c on c.oid = a.attrelid
				join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = current_schema()
				and (c.relname = 'git_reach_epoch' and a.attname in ('tips', 'oids')
					or c.relname = 'git_reach_bitmap' and a.attname = 'bits')
			order by c.relname, a.attname`
		expect(rows.map((r) => `${r.relname}.${r.attname}=${r.attstorage}`)).toEqual([
			"git_reach_bitmap.bits=e",
			"git_reach_epoch.oids=e",
			"git_reach_epoch.tips=e",
		])
	})

	it("A/B: inline STORAGE EXTERNAL on a partitioned parent reaches its leaves", async () => {
		// Locally-created replicas of the DDL: one parent declares `storage external`
		// inline, the other takes the default. Same payload into both.
		await db.sql.unsafe(
			`create table probe_ext (k int, data bytea storage external) partition by hash (k)`,
		)
		await db.sql.unsafe(
			`create table probe_ext_p0 partition of probe_ext for values with (modulus 2, remainder 0)`,
		)
		await db.sql.unsafe(
			`create table probe_ext_p1 partition of probe_ext for values with (modulus 2, remainder 1)`,
		)
		await db.sql.unsafe(
			`create table probe_def (k int, data bytea) partition by hash (k)`,
		)
		await db.sql.unsafe(
			`create table probe_def_p0 partition of probe_def for values with (modulus 2, remainder 0)`,
		)
		await db.sql.unsafe(
			`create table probe_def_p1 partition of probe_def for values with (modulus 2, remainder 1)`,
		)
		// Highly compressible: 16 KiB of one byte. Anything that runs a compression
		// pass shrinks it by ~1000×; EXTERNAL storage cannot.
		const squishy = Buffer.alloc(16 * 1024, 0x41)
		await db.sql`insert into probe_ext (k, data) values (1, ${squishy}), (2, ${squishy})`
		await db.sql`insert into probe_def (k, data) values (1, ${squishy}), (2, ${squishy})`
		const ab = await db.sql<{ t: string; k: number; oct: string; col: string }[]>`
			select 'probe_ext' as t, k, octet_length(data)::text as oct, pg_column_size(data)::text as col from probe_ext
			union all
			select 'probe_def', k, octet_length(data)::text, pg_column_size(data)::text from probe_def
			order by 1, 2`
		const ext = ab.filter((r) => r.t === "probe_ext")
		const def = ab.filter((r) => r.t === "probe_def")
		expect(ext.length).toBe(2)
		expect(def.length).toBe(2)
		// The default-storage control MUST compress, or the payload proves nothing.
		expect(def.every((r) => Number(r.col) < Number(r.oct) / 2)).toBe(true)
		// The propagation claim itself: every value stored verbatim.
		expect(ext.every((r) => Number(r.col) >= Number(r.oct))).toBe(true)
	})

	it("stores a compressible value verbatim in the SHIPPED git_pack_encoding", async () => {
		// The decisive test: it asks the shipped table rather than a replica of its
		// DDL. A second compression pass would shrink 16 KiB of 0x41 by ~1000×.
		const squishy = Buffer.alloc(16 * 1024, 0x41)
		const [repo] = await db.sql<
			{ id: string }[]
		>`insert into repos (name) values ('probe/storage') returning id::text as id`
		if (repo === undefined) throw new Error("probe repo insert returned no row")
		const probeOid = Buffer.alloc(20, 0x7f)
		// The 0008 FK cascades demand a real inventory row behind every encoding
		// row, synthetic probes included — that DDL-level hygiene is the design.
		await db.sql`insert into git_object (repo_id, oid, type, size, content)
			values (${repo.id}::bigint, ${probeOid}, 3, ${squishy.length}, ${squishy})`
		await db.sql`insert into git_pack_encoding (repo_id, oid, base_oid, data_size, data)
			values (${repo.id}::bigint, ${probeOid}, null, ${squishy.length}, ${squishy})`
		const [probe] = await db.sql<{ oct: string; col: string }[]>`
			select octet_length(data)::text as oct, pg_column_size(data)::text as col
			from git_pack_encoding where oid = ${probeOid}`
		if (probe === undefined) throw new Error("storage probe returned no row")
		const probeOct = Number(probe.oct)
		const probeCol = Number(probe.col)
		await db.sql`delete from git_pack_encoding where oid = ${probeOid}`
		await db.sql`delete from repos where name = 'probe/storage'`
		expect(probeOct).toBe(squishy.length)
		expect(probeCol).toBeGreaterThanOrEqual(probeOct / 2)
	})

	it("never compresses the repack's already-deflated bytes a second time", async () => {
		// What the real repack's output actually costs. `pg_column_size` reflects any
		// compression that was applied, so summing it against `octet_length` over the
		// whole tier is the C4 verdict restated on real data rather than a probe row.
		expect(repacked.wholes + repacked.deltas).toBeGreaterThan(0)
		const [agg] = await db.sql<
			{ n: string; oct: string; col: string; inline_n: string; big_n: string }[]
		>`
			select count(*)::text as n,
				sum(octet_length(data))::text as oct,
				sum(pg_column_size(data))::text as col,
				count(*) filter (where octet_length(data) <= 2000)::text as inline_n,
				count(*) filter (where octet_length(data) > 2000)::text as big_n
			from git_pack_encoding`
		if (agg === undefined) throw new Error("encoding aggregate returned no row")
		expect(Number(agg.n)).toBe(repacked.wholes + repacked.deltas)
		expect(Number(agg.col)).toBeGreaterThanOrEqual(Number(agg.oct))

		// Values over ~2 kB are the ones that go out-of-line under EXTERNAL; nothing
		// smaller can, so the out-of-line population can never exceed them.
		const toastRels = await db.sql<{ relname: string; toastname: string }[]>`
			select c.relname, t.relname as toastname
			from pg_class c
				join pg_namespace nn on nn.oid = c.relnamespace
				join pg_class t on t.oid = c.reltoastrelid
			where nn.nspname = current_schema() and c.relname like 'git\\_pack\\_encoding\\_p%'
			order by 1`
		let toastDistinct = 0
		for (const r of toastRels) {
			const [cnt] = await db.sql.unsafe<{ d: string }[]>(
				`select count(distinct chunk_id)::text as d from pg_toast.${r.toastname}`,
			)
			if (cnt === undefined)
				throw new Error(`TOAST aggregate returned no row for ${r.toastname}`)
			toastDistinct += Number(cnt.d)
		}
		expect(toastDistinct).toBeLessThanOrEqual(Number(agg.big_n))

		// The entire prize EXTERNAL gives up (and the entire CPU bill EXTENDED would
		// charge): deflate each encoding once more and total the result.
		const sample = await db.sql<{ data: Buffer }[]>`
			select data from git_pack_encoding order by oid limit 2000`
		let reDeflated = 0
		let original = 0
		for (const r of sample) {
			original += r.data.length
			reDeflated += deflateSync(r.data).length
		}
		expect(original).toBeGreaterThan(0)
		expect(reDeflated).toBeGreaterThanOrEqual(original)
	}, 300_000)
})

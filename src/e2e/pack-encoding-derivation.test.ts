/**
 * Repack derivation — the encoding tier's core contract
 * (docs/2026-08-15-delta-pack-design.md D1/D2/D4/D6).
 *
 * The `git_pack_encoding` table IS `createRepack`'s product, so assertions over it
 * are contract assertions, not white-box reads. The oracle for every byte-fidelity
 * check is the CANONICAL store (`git_object.content`): a derived tier's one promise
 * is that it resolves back to the inventory it derives from.
 *
 * Fixture: the append-only shape (one run directory per commit) — the workload the
 * design exists for, where the same growing tree is rewritten by every commit.
 */
import { rmSync } from "node:fs"
import { deflateSync, inflateSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { applyDelta } from "@/pack/delta"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { lookupRepoId } from "@/store/repo-resolver"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { loadAllObjects, seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

const REPO = "enc-derive"

type EncodingRow = {
	oid: Buffer
	base_oid: Buffer | null
	data_size: number
	data: Buffer
}

describe("repack — derivation of the encoding tier", () => {
	let db: IsolatedDb
	let objects: ObjectStore
	let refs: RefStore
	let repack: Repack
	let src = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		repack = createRepack(db.sql)

		src = await createAppendOnlyRepo({ docs: 6, runs: 80 })
		await seedRepoIntoStore(REPO, src, { objects, refs })
		await repack.repack(REPO)
	}, 300_000)

	afterAll(async () => {
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	async function repoId() {
		const id = await lookupRepoId(db.db, REPO)
		if (id === null) throw new Error(`repo ${REPO} not found`)
		return id
	}

	async function encodingRows(): Promise<EncodingRow[]> {
		const id = await repoId()
		return await db.sql<EncodingRow[]>`
			select oid, base_oid, data_size, data
			from git_pack_encoding where repo_id = ${id}::bigint`
	}

	async function canonical(id: string, oid: Buffer): Promise<Buffer> {
		const [row] = await db.sql<{ content: Buffer }[]>`
			select content from git_object
			where repo_id = ${id}::bigint and oid = ${oid}`
		if (!row) throw new Error(`no canonical object ${oid.toString("hex")}`)
		return row.content
	}

	it("covers the inventory: exactly one encoding row per object, none extra", async () => {
		const id = await repoId()
		const [counts] = await db.sql<
			{ objects: string; encodings: string; orphans: string }[]
		>`
			select
				(select count(*) from git_object where repo_id = ${id}::bigint)::text as objects,
				(select count(*) from git_pack_encoding where repo_id = ${id}::bigint)::text as encodings,
				(select count(*) from git_pack_encoding e
					where e.repo_id = ${id}::bigint and not exists (
						select 1 from git_object o
						where o.repo_id = e.repo_id and o.oid = e.oid))::text as orphans`
		if (counts === undefined) throw new Error("inventory count query returned no row")
		expect(counts.encodings).toBe(counts.objects)
		expect(counts.orphans).toBe("0")
	})

	it("resolves every encoding back to canonical bytes, with an honest data_size", async () => {
		const id = await repoId()
		for (const row of await encodingRows()) {
			const inflated = inflateSync(row.data)
			// data_size is the inflated length of what `data` HOLDS — object bytes for a
			// whole row, the delta program's length for a delta row (the pack header
			// varint needs exactly this; design D6).
			expect(inflated.length).toBe(row.data_size)
			const expected = await canonical(id, row.oid)
			const resolved = row.base_oid
				? applyDelta(await canonical(id, row.base_oid), inflated)
				: inflated
			expect(resolved.equals(expected)).toBe(true)
		}
	})

	it("holds the star invariant: every delta's base is a WHOLE encoding (depth ≤ 1)", async () => {
		const id = await repoId()
		const [violations] = await db.sql<{ chained: string; baseless: string }[]>`
			select
				(select count(*) from git_pack_encoding d
					join git_pack_encoding b
						on b.repo_id = d.repo_id and b.oid = d.base_oid
					where d.repo_id = ${id}::bigint
						and d.base_oid is not null
						and b.base_oid is not null)::text as chained,
				(select count(*) from git_pack_encoding d
					where d.repo_id = ${id}::bigint
						and d.base_oid is not null
						and not exists (
							select 1 from git_pack_encoding b
							where b.repo_id = d.repo_id and b.oid = d.base_oid))::text as baseless`
		if (violations === undefined) throw new Error("star-invariant query returned no row")
		expect(violations.chained).toBe("0") // a delta whose base is itself a delta = a chain
		expect(violations.baseless).toBe("0") // a delta whose base has no encoding at all
	})

	it("actually compresses the trees — deltified bytes well under whole bytes", async () => {
		// The size half of the contract: a correct-but-all-whole tier would pass every
		// test above and change nothing (the same vacuity trap the encoder spec guards
		// against). Whole-deflated tree bytes come from the fixture itself, JS-side.
		const id = await repoId()
		let wholeTrees = 0
		for (const o of await loadAllObjects(src)) {
			if (o.type === "tree") wholeTrees += deflateSync(o.content).length
		}
		const [stored] = await db.sql<{ bytes: string }[]>`
			select coalesce(sum(length(e.data)), 0)::text as bytes
			from git_pack_encoding e
				join git_object o on o.repo_id = e.repo_id and o.oid = e.oid
			where e.repo_id = ${id}::bigint and o.type = 2`
		if (stored === undefined) throw new Error("stored-byte query returned no row")
		expect(Number(stored.bytes)).toBeGreaterThan(0)
		expect(Number(stored.bytes)).toBeLessThan(wholeTrees / 2)
	})

	it("is idempotent: a second pass writes nothing and changes nothing", async () => {
		const before = await encodingRows()
		const fingerprint = (rows: EncodingRow[]) =>
			rows
				.map(
					(r) =>
						`${r.oid.toString("hex")}:${r.base_oid?.toString("hex") ?? "-"}:${r.data.toString("hex")}`,
				)
				.sort()
		const second = await repack.repack(REPO)
		expect(second).toEqual({ deltas: 0, wholes: 0 })
		expect(fingerprint(await encodingRows())).toEqual(fingerprint(before))
	})
})

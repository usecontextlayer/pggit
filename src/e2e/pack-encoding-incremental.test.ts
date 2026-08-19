/**
 * Repack across passes — the frozen-policy and no-rot contract
 * (docs/2026-08-15-delta-pack-design.md D4).
 *
 * The silent failure this file exists to make loud: pass 1 encodes a lineage, the
 * repo grows, and pass 2 deltas the NEW versions against pass 1's newest object —
 * which is itself a delta. Nothing errors; the tier just quietly grows chains the
 * design promised it never would, and every read of a late version pays for it.
 * So the star invariant is asserted AFTER a second, incremental pass — the state
 * where it actually breaks — and finalized encodings are pinned as immutable.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo, RUNS_DIR, runDirName } from "@/testing/append-only-repo"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "enc-incremental"
const INITIAL_RUNS = 40
const EXTRA_RUNS = 12

/** Continue the append-only history with ordinary git commits (the fixture built
 * the initial history via fast-import; growth arrives as normal commits). */
async function appendRuns(dir: string, from: number, count: number): Promise<void> {
	for (let i = from; i < from + count; i++) {
		const run = join(dir, RUNS_DIR, runDirName(i))
		mkdirSync(run, { recursive: true })
		writeFileSync(join(run, "record.json"), `{"run":"${runDirName(i)}","n":${i}}\n`)
		writeFileSync(join(run, "stderr"), `stderr ${i}\n`)
		await spawnGit(["add", "-A"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", `run ${i}`], { cwd: dir })
	}
}

describe("repack — incremental passes", () => {
	let db: IsolatedDb
	let objects: ObjectStore
	let refs: RefStore
	let repack: Repack
	let src = ""
	let firstPassRows = new Map<string, string>()
	let secondPass: Awaited<ReturnType<Repack["repack"]>>

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		repack = createRepack(db.sql)

		src = await createAppendOnlyRepo({ docs: 4, runs: INITIAL_RUNS })
		await seedRepoIntoStore(REPO, src, { objects, refs })
		await repack.repack(REPO)
		firstPassRows = await rowFingerprints()

		// The repo grows; re-seeding pushes the new objects and advances the ref
		// (putPack is idempotent for the objects both histories share).
		await appendRuns(src, INITIAL_RUNS, EXTRA_RUNS)
		await seedRepoIntoStore(REPO, src, { objects, refs })
		secondPass = await repack.repack(REPO)
	}, 300_000)

	afterAll(async () => {
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	async function repoId(): Promise<string> {
		const [row] = await db.sql<{ id: string }[]>`
			select id::text as id from repos where name = ${REPO}`
		if (!row) throw new Error(`repo ${REPO} not found`)
		return row.id
	}

	/** oid → `${base}:${sha1ish-of-data}` for every encoding row. */
	async function rowFingerprints(): Promise<Map<string, string>> {
		const id = await repoId()
		const rows = await db.sql<{ oid: Buffer; base_oid: Buffer | null; digest: string }[]>`
			select oid, base_oid, md5(data) as digest
			from git_pack_encoding where repo_id = ${id}::bigint`
		return new Map(
			rows.map((r) => [
				r.oid.toString("hex"),
				`${r.base_oid?.toString("hex") ?? "-"}:${r.digest}`,
			]),
		)
	}

	it("covers the grown inventory completely", async () => {
		const id = await repoId()
		const [counts] = await db.sql<{ objects: string; encodings: string }[]>`
			select
				(select count(*) from git_object where repo_id = ${id}::bigint)::text as objects,
				(select count(*) from git_pack_encoding where repo_id = ${id}::bigint)::text as encodings`
		expect(counts?.encodings).toBe(counts?.objects)
		// And the growth was real: pass 2 had genuinely new objects to cover.
		expect(Number(counts?.objects)).toBeGreaterThan(firstPassRows.size)
	})

	it("deltifies in the incremental pass — the star invariant has rows to judge", () => {
		// Without this the no-rot invariant below is unfalsifiable: a pass that emitted
		// zero deltas has zero delta-on-delta rows and reports a clean star.
		expect(secondPass.deltas, "the incremental pass emitted no deltas").toBeGreaterThan(0)
	})

	it("holds the star invariant AFTER the incremental pass — no chain rot", async () => {
		const id = await repoId()
		const [violations] = await db.sql<{ chained: string }[]>`
			select count(*)::text as chained
			from git_pack_encoding d
				join git_pack_encoding b on b.repo_id = d.repo_id and b.oid = d.base_oid
			where d.repo_id = ${id}::bigint
				and d.base_oid is not null
				and b.base_oid is not null`
		expect(violations?.chained).toBe("0")
	})

	it("never rewrites a finalized encoding (the frozen policy)", async () => {
		const after = await rowFingerprints()
		for (const [oid, fingerprint] of firstPassRows) {
			expect(after.get(oid), `encoding for ${oid} changed across passes`).toBe(
				fingerprint,
			)
		}
	})
})

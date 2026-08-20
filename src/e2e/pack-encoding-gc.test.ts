/**
 * GC × the encoding tier (docs/2026-08-15-delta-pack-design.md D7).
 *
 * The tier is derived, so GC owns two new obligations, both pinned here:
 *
 *   1. A reclaimed object's encoding row goes with it — nothing about a dead
 *      object survives.
 *   2. No surviving delta encoding may reference a base that GC removed. A force
 *      push can orphan an ANCHOR while a delta against it stays reachable (the
 *      anchor's commits become unreachable, the delta's do not) — the one shape
 *      where the two sweeps disagree. The dangling delta must be removed by the
 *      sweep (the object then serves via the raw path) and the next repack pass
 *      re-encodes it — visible as that pass writing rows where a covered repo
 *      would write none.
 *
 * The interleaving is GC-then-repack per repo (design D5) — exercised here in
 * exactly that order.
 */
import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGc, type Gc } from "@/store/gc"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "enc-gc"

describe("repack × GC — the derived tier follows the inventory", () => {
	let db: IsolatedDb
	let objects: ObjectStore
	let refs: RefStore
	let repack: Repack
	let gc: Gc
	let src = ""
	let keptTip = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		repack = createRepack(db.sql)
		gc = createGc(db.sql)

		// Full history seeded and FULLY encoded — encodings exist for objects that are
		// about to become garbage, which is the only interesting starting state.
		src = await createAppendOnlyRepo({ docs: 4, runs: 60 })
		await seedRepoIntoStore(REPO, src, { objects, refs })
		await repack.repack(REPO)

		// The shape that makes obligation 2 bite is NOT plain truncation — truncating
		// kills an anchor and its dependents together, so no delta ever dangles. It
		// takes a REUSED tree: an orphan commit whose root tree is commit 40's (same
		// content ⇒ same oid), on a ref of its own. Keep that ref, wind main back to
		// commit 10, and commit 40's trees stay reachable while their mid-segment
		// anchors (reachable only through commits 32..39) die — exactly a surviving
		// delta whose base GC removes.
		const commits = (
			await spawnGit(["rev-list", "--reverse", "HEAD"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		const early = commits[10]
		const reused = commits[40]
		if (!early || !reused) throw new Error("fixture too short to orphan")
		const tree40 = (
			await spawnGit(["rev-parse", `${reused}^{tree}`], { cwd: src })
		).stdout.trim()
		const orphan = (
			await spawnGit(["commit-tree", tree40, "-m", "reuse"], { cwd: src })
		).stdout.trim()
		// The orphan commit exists only client-side; put its object into the store so
		// the ref about to point at it has a walkable closure.
		const orphanContent = (await spawnGit(["cat-file", "commit", orphan], { cwd: src }))
			.stdoutBytes
		await objects.putPack(REPO, [{ content: orphanContent, type: "commit" }])
		await refs.setRef(REPO, "refs/heads/keep", orphan)

		keptTip = early
		await refs.setRef(REPO, "refs/heads/main", keptTip)

		await gc.gc(REPO, { graceSeconds: 0 })
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

	it("GC removed the encodings of reclaimed objects", async () => {
		const id = await repoId()
		const [orphans] = await db.sql<{ n: string }[]>`
			select count(*)::text as n
			from git_pack_encoding e
			where e.repo_id = ${id}::bigint
				and not exists (
					select 1 from git_object o
					where o.repo_id = e.repo_id and o.oid = e.oid)`
		if (orphans === undefined) throw new Error("orphan count query returned no row")
		expect(orphans.n).toBe("0")
	})

	it("GC left no delta encoding referencing a removed base", async () => {
		const id = await repoId()
		const [dangling] = await db.sql<{ n: string }[]>`
			select count(*)::text as n
			from git_pack_encoding e
			where e.repo_id = ${id}::bigint
				and e.base_oid is not null
				and not exists (
					select 1 from git_object o
					where o.repo_id = e.repo_id and o.oid = e.base_oid)`
		if (dangling === undefined) throw new Error("dangling-base query returned no row")
		expect(dangling.n).toBe("0")
	})

	it("the next repack pass restores full coverage and reports its repairs", async () => {
		const result = await repack.repack(REPO)
		const id = await repoId()
		const [counts] = await db.sql<{ objects: string; encodings: string }[]>`
			select
				(select count(*) from git_object where repo_id = ${id}::bigint)::text as objects,
				(select count(*) from git_pack_encoding where repo_id = ${id}::bigint)::text as encodings`
		if (counts === undefined) throw new Error("inventory count query returned no row")
		expect(counts.encodings).toBe(counts.objects)
		// GC swept the dangling deltas, so this pass had genuine holes to re-encode —
		// and a SECOND pass over the repaired tier is back to a no-op.
		expect(result.wholes + result.deltas).toBeGreaterThan(0)
		expect(await repack.repack(REPO)).toEqual({ deltas: 0, wholes: 0 })
	})

	it("the surviving history still clones fsck-clean from the store", async () => {
		// End-to-end sanity over the post-GC, post-repair state: what remains must
		// still be a coherent repository, not merely a consistent pair of tables.
		const { createGitApp } = await import("@/index")
		const { serveOnPort } = await import("@/server")
		const { mkdtempSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const { join } = await import("node:path")

		const server = await serveOnPort(createGitApp({ objects, refs }), 0)
		try {
			const dest = join(mkdtempSync(join(tmpdir(), "enc-gc-clone-")), "c")
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				`http://127.0.0.1:${server.port}/${REPO}`,
				dest,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			const clonedTip = (
				await spawnGit(["rev-parse", "HEAD"], { cwd: dest })
			).stdout.trim()
			expect(clonedTip).toBe(keptTip)
			rmSync(dest, { force: true, recursive: true })
		} finally {
			await server.close()
		}
	})
})

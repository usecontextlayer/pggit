/**
 * Spine chunk 1 (S1 gates): every stored commit/tag object gets its
 * `git_commit`/`git_tag` row, derived transactionally at ingest — and
 * `generation` behaves EXACTLY as designed in both directions:
 *
 *   - a first push of a linear history yields FINITE generations 1..N even
 *     though a git pack lists commits newest-first (the in-pack topological
 *     pass; all-NULL here is the bug the design calls out by name), and
 *   - a commit ingested while its parent is ABSENT derives NULL — and STAYS
 *     NULL when the parent arrives later (absorbing, never recomputed), and
 *     NULL propagates to descendants.
 *
 * Plus: `parents` preserves CONTENT order (the kind-2 edge set threw it away —
 * this column is the fix), `commit_time` is the committer epoch, tag rows carry
 * target + type, and the 0009 backfill derives for pre-0009 data exactly what
 * ingest derives — including absorbing NULL for denied-push residue.
 *
 * Every fixture oid is minted by real `git hash-object`, and the tree/parents/
 * commit_time expectations are read back with `git log`, so the fixture and the
 * store cannot agree through one shared hash or header parser. `generation` stays
 * ours — it is pggit's own concept, asserted against the design.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Migration } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { GitServer } from "@/server"
import type { ObjectStore } from "@/store/object-store"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const EPOCH = 1_700_000_000

/** A well-formed synthetic commit. The tree does not need to exist for row
 * derivation (putPack runs no connectivity check), which keeps these fixtures
 * on the exact seam under test: content → row. */
function commitBytes(
	tree: string,
	parents: string[],
	msg: string,
	epoch = EPOCH,
): Buffer {
	return Buffer.from(
		`tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}author a <a@a.test> ${epoch} +0000\ncommitter c <c@c.test> ${epoch} +0000\n\n${msg}\n`,
		"latin1",
	)
}

function tagBytes(target: string, type: string, name: string): Buffer {
	return Buffer.from(
		`object ${target}\ntype ${type}\ntag ${name}\ntagger t <t@t.test> ${EPOCH} +0000\n\n${name}\n`,
		"latin1",
	)
}

const FAKE_TREE = "ab".repeat(20)

/**
 * The oid oracle: one throwaway repo for the whole file. `--literally` is what
 * lets `hash-object` store objects whose tree/parent targets the repo does not
 * hold — exactly the seam these fixtures sit on (content → row, no connectivity).
 */
let oracleRepo = ""

beforeAll(async () => {
	oracleRepo = mkdtempSync(join(tmpdir(), "pggit-s1-oracle-"))
	await spawnGit(["init", "-q", "-b", "main"], { cwd: oracleRepo })
}, 120_000)

afterAll(() => {
	if (oracleRepo) rmSync(oracleRepo, { force: true, recursive: true })
})

/** Canonical git's oid for these exact bytes. */
async function gitOid(type: "commit" | "tag", content: Buffer): Promise<string> {
	const out = await spawnGit(
		["hash-object", "-w", "-t", type, "--literally", "--stdin"],
		{ cwd: oracleRepo, input: content },
	)
	return out.stdout.trim()
}

/** Canonical git's reading of a stored commit — tree, parents in CONTENT order,
 * committer epoch: the same three columns ingest derives. */
async function gitCommitFacts(
	oid: string,
): Promise<{ commitTime: string; parents: string[]; tree: string }> {
	const out = await spawnGit(["log", "-1", "--format=%T|%P|%ct", oid], {
		cwd: oracleRepo,
	})
	const [tree, parents, commitTime] = out.stdout.trim().split("|")
	if (tree === undefined || parents === undefined || commitTime === undefined) {
		throw new Error(`unexpected git log output for ${oid}: ${out.stdout}`)
	}
	return { commitTime, parents: parents.split(" ").filter(Boolean), tree }
}

type CommitRow = {
	oid: string
	tree: string
	parents: string[]
	commit_time: string
	generation: number | null
}

function requireMapEntry<K, V>(map: Map<K, V>, key: K, context: string): V {
	const value = map.get(key)
	if (value === undefined) throw new Error(`${context}: required row is missing`)
	return value
}

describe("spine S1 — git_commit/git_tag derivation", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
	})

	async function commitRows(repo: string): Promise<Map<string, CommitRow>> {
		const rows = await db.sql<CommitRow[]>`
			select encode(c.oid, 'hex') as oid, encode(c.tree_oid, 'hex') as tree,
				(select coalesce(array_agg(encode(p.h, 'hex') order by p.ord), '{}')
					from unnest(c.parents) with ordinality as p(h, ord)) as parents,
				c.commit_time, c.generation
			from git_commit c join repos r on r.id = c.repo_id
			where r.name = ${repo}`
		return new Map(rows.map((r) => [r.oid, r]))
	}

	it("a first push of a linear history yields FINITE generations (in-pack topo pass)", async () => {
		const commits: { oid: string; content: Buffer }[] = []
		let parent: string | null = null
		for (let i = 0; i < 5; i++) {
			const content = commitBytes(FAKE_TREE, parent ? [parent] : [], `c${i}`, EPOCH + i)
			const oid = await gitOid("commit", content)
			commits.push({ content, oid })
			parent = oid
		}
		// NEWEST-FIRST, exactly as a real pack lists them: per-row computation in
		// this order would derive NULL for every commit (the named bug).
		await store.putPack(
			"linear",
			[...commits]
				.reverse()
				.map((c) => ({ content: c.content, type: "commit" as const })),
		)

		const rows = await commitRows("linear")
		expect(rows.size).toBe(5)
		for (const [i, c] of commits.entries()) {
			const row = rows.get(c.oid)
			if (row === undefined) throw new Error(`commit row missing for ${c.oid}`)
			// Every expectation but `generation` is git's own reading of the object.
			const facts = await gitCommitFacts(c.oid)
			expect(row.generation).toBe(i + 1)
			expect(row.tree).toBe(facts.tree)
			expect(BigInt(row.commit_time)).toBe(BigInt(facts.commitTime))
			expect(row.parents).toEqual(facts.parents)
		}
	})

	it("a merge commit's parents preserve CONTENT order; generation is 1+max", async () => {
		const a = commitBytes(FAKE_TREE, [], "a")
		const aOid = await gitOid("commit", a)
		const b = commitBytes(FAKE_TREE, [aOid], "b")
		const bOid = await gitOid("commit", b)
		// Parents deliberately [bOid, aOid] — descending-generation order, so a
		// sorted or set-shaped store would betray itself here.
		const m = commitBytes(FAKE_TREE, [bOid, aOid], "m")
		const mOid = await gitOid("commit", m)
		await store.putPack("merge", [
			{ content: m, type: "commit" },
			{ content: b, type: "commit" },
			{ content: a, type: "commit" },
		])

		const rows = await commitRows("merge")
		const aRow = requireMapEntry(rows, aOid, `commit ${aOid}`)
		const bRow = requireMapEntry(rows, bOid, `commit ${bOid}`)
		const mRow = requireMapEntry(rows, mOid, `commit ${mOid}`)
		// git's own parent reading first (the oracle), then the literal that says
		// which order this fixture deliberately chose.
		expect(mRow.parents).toEqual((await gitCommitFacts(mOid)).parents)
		expect(mRow.parents).toEqual([bOid, aOid])
		expect(aRow.generation).toBe(1)
		expect(bRow.generation).toBe(2)
		expect(mRow.generation).toBe(3)
	})

	it("an absent parent derives NULL, absorbing — the parent arriving later changes NOTHING", async () => {
		const orphanParent = commitBytes(FAKE_TREE, [], "never-pushed-first")
		const orphanParentOid = await gitOid("commit", orphanParent)
		const child = commitBytes(FAKE_TREE, [orphanParentOid], "child")
		const childOid = await gitOid("commit", child)

		// 1. Child arrives WITHOUT its parent (denied-push residue shape).
		await store.putPack("orphan", [{ content: child, type: "commit" }])
		expect(
			requireMapEntry(await commitRows("orphan"), childOid, `commit ${childOid}`)
				.generation,
		).toBeNull()

		// 2. The parent arrives later: it gets its own finite generation, but the
		// child is NEVER recomputed (absorbing NULL, ingest atomicity).
		await store.putPack("orphan", [{ content: orphanParent, type: "commit" }])
		const after = await commitRows("orphan")
		expect(
			requireMapEntry(after, orphanParentOid, `commit ${orphanParentOid}`).generation,
		).toBe(1)
		expect(requireMapEntry(after, childOid, `commit ${childOid}`).generation).toBeNull()

		// 3. Re-sending the child is idempotent — still NULL.
		await store.putPack("orphan", [{ content: child, type: "commit" }])
		expect(
			requireMapEntry(await commitRows("orphan"), childOid, `commit ${childOid}`)
				.generation,
		).toBeNull()

		// 4. NULL propagates: a NEW descendant of the NULL child is NULL too, even
		// beside a finite-generation parent (max over a NULL region is unknowable).
		const grandchild = commitBytes(FAKE_TREE, [childOid, orphanParentOid], "grandchild")
		const grandchildOid = await gitOid("commit", grandchild)
		await store.putPack("orphan", [{ content: grandchild, type: "commit" }])
		expect(
			requireMapEntry(
				await commitRows("orphan"),
				grandchildOid,
				`commit ${grandchildOid}`,
			).generation,
		).toBeNull()
	})

	it("tag rows: target + stored type code, chains included", async () => {
		const c = commitBytes(FAKE_TREE, [], "tagged")
		const cOid = await gitOid("commit", c)
		const t1 = tagBytes(cOid, "commit", "v1")
		const t1Oid = await gitOid("tag", t1)
		const t2 = tagBytes(t1Oid, "tag", "v1-signed")
		const t2Oid = await gitOid("tag", t2)
		await store.putPack("tags", [
			{ content: c, type: "commit" },
			{ content: t1, type: "tag" },
			{ content: t2, type: "tag" },
		])

		const rows = await db.sql<{ oid: string; target: string; target_type: number }[]>`
			select encode(t.oid, 'hex') as oid, encode(t.target_oid, 'hex') as target, t.target_type
			from git_tag t join repos r on r.id = t.repo_id where r.name = ${"tags"}`
		const byOid = new Map(rows.map((r) => [r.oid, r]))
		expect(byOid.get(t1Oid)).toMatchObject({ target: cOid, target_type: 1 })
		expect(byOid.get(t2Oid)).toMatchObject({ target: t1Oid, target_type: 4 })
	})

	it("a real `git push` over the wire derives rows for every commit and tag", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-s1-wire-"))
		try {
			await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
			writeFileSync(join(dir, "f.txt"), "one\n")
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })
			writeFileSync(join(dir, "f.txt"), "two\n")
			await spawnGit(["commit", "-q", "-am", "c2"], { cwd: dir })
			await spawnGit(["tag", "-a", "-m", "v1", "v1"], { cwd: dir })
			const url = repoUrl(server, "wire")
			await spawnGit(
				["push", "-q", url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
				{ cwd: dir },
			)

			const rows = await commitRows("wire")
			expect(rows.size).toBe(2)
			expect([...rows.values()].map((r) => r.generation).sort()).toEqual([1, 2])
			const tags = await db.sql<{ n: string }[]>`
				select count(*) as n from git_tag t join repos r on r.id = t.repo_id
				where r.name = ${"wire"}`
			const [tagCount] = tags
			if (tagCount === undefined) throw new Error("tag-count aggregate returned no row")
			expect(Number(tagCount.n)).toBe(1)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe("spine S1 — 0009 backfill derives rows for pre-0009 data", () => {
	let db: IsolatedDb

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
	}, 600_000)

	afterAll(async () => {
		await db?.drop()
	})

	it("backfills commit generations, ordered parents, and tag rows; absent parents stay NULL", async () => {
		// The pre-0009 world, made with the migration's own inverse: down() drops
		// the derived tables, rows land straight in git_object, up() re-creates and
		// backfills — one test covers both directions of the real migration. Typed
		// through kysely's own Migration interface, exactly as the migrator calls it.
		const m0009: Migration = await import("@/database/migrations/0009_commit_tag")
		if (m0009.down === undefined) throw new Error("0009 migration has no down function")
		await m0009.down(db.db)

		const a = commitBytes(FAKE_TREE, [], "a")
		const aOid = await gitOid("commit", a)
		const b = commitBytes(FAKE_TREE, [aOid], "b")
		const bOid = await gitOid("commit", b)
		const ghost = "cd".repeat(20) // parent object the repo never held
		const c = commitBytes(FAKE_TREE, [ghost, bOid], "c")
		const cOid = await gitOid("commit", c)
		const tag = tagBytes(bOid, "commit", "v1")
		const tagOid = await gitOid("tag", tag)

		await db.sql`insert into repos (name) values ('prebackfill')`
		const [{ id }] = await db.sql<[{ id: string }]>`
			select id from repos where name = 'prebackfill'`
		for (const [oid, type, content] of [
			[aOid, 1, a],
			[bOid, 1, b],
			[cOid, 1, c],
			[tagOid, 4, tag],
		] as const) {
			await db.sql`insert into git_object (repo_id, oid, type, size, content)
				values (${id}::bigint, ${Buffer.from(oid, "hex")}, ${type}, ${content.length}, ${content})`
		}

		await m0009.up(db.db)

		const rows = await db.sql<
			{ oid: string; parents: string[]; generation: number | null }[]
		>`
			select encode(c.oid, 'hex') as oid,
				(select coalesce(array_agg(encode(p.h, 'hex') order by p.ord), '{}')
					from unnest(c.parents) with ordinality as p(h, ord)) as parents,
				c.generation
			from git_commit c where c.repo_id = ${id}::bigint`
		const byOid = new Map(rows.map((r) => [r.oid, r]))
		expect(requireMapEntry(byOid, aOid, `commit ${aOid}`).generation).toBe(1)
		expect(requireMapEntry(byOid, bOid, `commit ${bOid}`).generation).toBe(2)
		// c's first parent never existed in the repo: absorbing NULL, exactly what
		// ingest would have derived — and its CONTENT parent order is preserved.
		const cRow = requireMapEntry(byOid, cOid, `commit ${cOid}`)
		expect(cRow.generation).toBeNull()
		expect(cRow.parents).toEqual([ghost, bOid])

		const tags = await db.sql<{ target: string; target_type: number }[]>`
			select encode(target_oid, 'hex') as target, target_type
			from git_tag where repo_id = ${id}::bigint`
		expect(tags).toHaveLength(1)
		expect(tags[0]).toMatchObject({ target: bOid, target_type: 1 })
	})
})

/**
 * PG TYPE-BOUNDARY PROBE — the projection's silent path collision is now
 * UNREPRESENTABLE: non-UTF-8 tree paths are rejected at push ingest (D16).
 *
 * The defect this file originally reproduced: `a\xe9.txt` and `a\xea.txt` are
 * two distinct, fsck-clean git paths that both decode to `a�.txt` at the
 * projection's `Buffer.toString("utf8")`, and `repo_file`'s PK is (repo_id,
 * ref_name, path) with `INSERT … ON CONFLICT DO NOTHING` underneath — so the
 * second file simply vanished from the published read surface
 * (`repo_file ⋈ git_object`): no error, no `ng`, push reported success.
 *
 * D16 removes the class at its boundary instead of handling it: tree-entry
 * names must be valid UTF-8, judged on the raw bytes in `validateObject` inside
 * the ingest transaction (GitFormatError `non-utf8-path` → the push's unpack
 * fails, every ref is ng'd, nothing lands). The mangling cannot be made
 * injective, so the only honest projection over `path text` is one that never
 * ingests an undecodable name.
 *
 * The tree is hand-framed through git plumbing (porcelain cannot lay down a
 * non-UTF-8 entry name under LC_ALL=C), and canonical git's acceptance of the
 * same repo (fsck-clean, byte-exact ls-tree) is kept as the record of the
 * deliberate divergence.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/badpath"

/** Entry names as RAW BYTES: "a<0xe9>.txt" and "a<0xea>.txt" — two distinct,
 * fsck-clean git paths that both decode to "a�.txt". */
const NAME_E9 = Buffer.concat([
	Buffer.from("a"),
	Buffer.from([0xe9]),
	Buffer.from(".txt"),
])
const NAME_EA = Buffer.concat([
	Buffer.from("a"),
	Buffer.from([0xea]),
	Buffer.from(".txt"),
])
const NAME_OK = Buffer.from("plain.txt")

describe("pg-corrupt — colliding non-UTF-8 paths are rejected at the boundary", () => {
	let db: IsolatedDb
	let server: GitServer
	let srcFsck = -1
	let oraclePathCount = 0
	let push: { code: number; stderr: string } = { code: 0, stderr: "" }
	let stored: { refs: number; objs: number; files: number } = {
		files: -1,
		objs: -1,
		refs: -1,
	}
	const dirs: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-badpath-${tag}-`))
		dirs.push(d)
		return d
	}

	beforeAll(async () => {
		const src = mk("src")
		await spawnGit(["init", "-q", "-b", "main", src])

		const blob = async (content: string): Promise<string> =>
			(
				await spawnGit(["hash-object", "-w", "--stdin"], { cwd: src, input: content })
			).stdout.trim()
		const blobE9 = await blob("AAA-from-e9\n")
		const blobEA = await blob("BBB-from-ea\n")
		const blobOK = await blob("plain\n")

		// Hand-frame the tree: `<mode> <name>\0<20-byte oid>`, entries in git's byte order.
		const entry = (name: Buffer, oid: string): Buffer =>
			Buffer.concat([
				Buffer.from("100644 "),
				name,
				Buffer.from([0]),
				Buffer.from(oid, "hex"),
			])
		const treeRaw = Buffer.concat([
			entry(NAME_E9, blobE9),
			entry(NAME_EA, blobEA),
			entry(NAME_OK, blobOK),
		])
		const tree = (
			await spawnGit(["hash-object", "-w", "-t", "tree", "--stdin"], {
				cwd: src,
				input: treeRaw,
			})
		).stdout.trim()
		const commit = (
			await spawnGit(["commit-tree", tree, "-m", "c1"], { cwd: src, input: "" })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/main", commit], { cwd: src })

		srcFsck = (await spawnGit(["fsck", "--full", "--strict"], { cwd: src })).code

		// The oracle side of the divergence: canonical git lists all three files.
		const lsTree = (
			await spawnGit(["ls-tree", "-r", "-z", "refs/heads/main"], { cwd: src })
		).stdoutBytes
		oraclePathCount = lsTree.toString("latin1").split("\0").filter(Boolean).length

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const url = repoUrl(server, REPO)

		push = await attemptGit(["push", url, "refs/heads/main:refs/heads/main"], src)

		const [counts] = await db.sql<{ refs: number; objs: number; files: number }[]>`
			select
				(select count(*) from git_ref g join repos r on r.id = g.repo_id
					where r.name = ${REPO} and g.oid is not null)::int as refs,
				(select count(*) from git_object o join repos r on r.id = o.repo_id
					where r.name = ${REPO})::int as objs,
				(select count(*) from repo_file f join repos r on r.id = f.repo_id
					where r.name = ${REPO})::int as files`
		if (counts) stored = counts
	}, 300_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("the divergence is real: canonical git accepts the repo with all three files", () => {
		expect(srcFsck).toBe(0)
		expect(oraclePathCount).toBe(3)
	})

	it("pggit REJECTS the push whose tree carries non-UTF-8 entry names", () => {
		expect(push.code, push.stderr).not.toBe(0)
		expect(push.stderr).toMatch(/not valid UTF-8/)
		expect(push.stderr).toMatch(/unpack/)
	})

	it("nothing landed — the silent-drop state cannot be reached", () => {
		// The old failure mode was a push that SUCCEEDED while the read surface lost
		// a file. With ingest-side rejection there is no partial outcome to lose
		// from: no ref moved, no objects stored, no projection rows written.
		expect(stored).toEqual({ files: 0, objs: 0, refs: 0 })
	})
})

/**
 * Typed-graph policy. Two layers:
 *
 * 1. Branch tips must be COMMITS — canonical receive-pack rejects a blob or
 *    tree pushed to refs/heads/* per-ref ("invalid new value provided",
 *    probed against git 2.x), while refs/tags/* accepts any type. Real git
 *    is the driver here, so the whole wire path is under test.
 *
 * 2. Typed EDGES — a commit whose `tree` names a blob, or a `40000` tree
 *    entry naming a blob, is a malformed graph git's writers never produce.
 *    The walks judge a mistyped edge like an absent object: connectivity
 *    rejects the push and a serve refuses the want — never an under-walk
 *    that silently skips the mistyped subtree's descendants.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps, type GitDeps } from "@/index"
import { computeOid } from "@/object/object"
import { WantNotFoundError } from "@/protocol/errors"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

const REPO = "policy/typed"

describe("typed-graph policy", () => {
	let db: IsolatedDb
	let deps: GitDeps
	let server: GitServer
	let src = ""
	let url = ""
	let blobOid = ""
	let treeOid = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		deps = createGitDeps(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
		url = `http://127.0.0.1:${server.port}/${REPO}`
		src = mkdtempSync(join(tmpdir(), "pggit-typed-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "f.txt"), "hello\n")
		await spawnGit(["add", "f.txt"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		blobOid = (await spawnGit(["rev-parse", "HEAD:f.txt"], { cwd: src })).stdout.trim()
		treeOid = (await spawnGit(["rev-parse", "HEAD^{tree}"], { cwd: src })).stdout.trim()
		await spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: src })
	}, 120_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("rejects a blob or tree pushed to refs/heads/* — and accepts them under refs/tags/*", async () => {
		for (const bad of [blobOid, treeOid]) {
			const denied = await attemptGit(["push", url, `${bad}:refs/heads/nontip`], src)
			expect(denied.ok).toBe(false)
			expect(denied.stderr).toContain("invalid new value provided")
		}
		// The same objects are legal tag targets (git's rule, matched exactly).
		await spawnGit(["push", "-q", url, `${blobOid}:refs/tags/blobtag`], { cwd: src })
		await spawnGit(["push", "-q", url, `${treeOid}:refs/tags/treetag`], { cwd: src })
	})

	it("a commit whose tree header names a BLOB fails connectivity and cannot be served", async () => {
		const content = Buffer.from(
			`tree ${blobOid}\ncommitter t <t@t> 1700000000 +0000\n\nmistyped\n`,
		)
		const oid = computeOid("commit", content)
		await deps.objects.putPack(REPO, [{ content, type: "commit" }])
		expect(await deps.objects.isConnected(REPO, oid)).toBe(false)
		await expect(deps.objects.buildPack(REPO, [oid], [], false)).rejects.toThrow(
			WantNotFoundError,
		)
	})

	it("a 40000 tree entry naming a BLOB fails connectivity for its commit", async () => {
		const entry = Buffer.concat([Buffer.from("40000 sub\0"), Buffer.from(blobOid, "hex")])
		const badTreeOid = computeOid("tree", entry)
		const commit = Buffer.from(
			`tree ${badTreeOid}\ncommitter t <t@t> 1700000000 +0000\n\nmistyped-sub\n`,
		)
		const commitOid = computeOid("commit", commit)
		await deps.objects.putPack(REPO, [
			{ content: entry, type: "tree" },
			{ content: commit, type: "commit" },
		])
		expect(await deps.objects.isConnected(REPO, commitOid)).toBe(false)
	})

	it("a parent whose derived row is MISSING crashes loud — corruption, never a sweepable miss", async () => {
		// Judged as a typed-edge "missing", a reachable parent with a missing derived row would be EXCLUDED from
		// GC's live set and swept — corruption converted into data loss. It must
		// crash the walk instead, in connectivity AND in the GC pass.
		const repo = "policy/corrupt"
		const parent = Buffer.from(
			`tree ${treeOid}\ncommitter t <t@t> 1700000000 +0000\n\np\n`,
		)
		const parentOid = computeOid("commit", parent)
		const child = Buffer.from(
			`tree ${treeOid}\nparent ${parentOid}\ncommitter t <t@t> 1700000001 +0000\n\nc\n`,
		)
		const childOid = computeOid("commit", child)
		// Seed the shared tree+blob closure first, then the two commits.
		const blob = Buffer.from("hello\n")
		const tree = Buffer.concat([
			Buffer.from("100644 f.txt\0"),
			Buffer.from(blobOid, "hex"),
		])
		await deps.objects.putPack(repo, [
			{ content: blob, type: "blob" },
			{ content: tree, type: "tree" },
			{ content: parent, type: "commit" },
			{ content: child, type: "commit" },
		])
		await deps.refs.setRef(repo, "refs/heads/main", childOid)
		// Surgical corruption: the parent's derived row vanishes.
		await db.sql`delete from git_commit where oid = ${Buffer.from(parentOid, "hex")}`

		await expect(deps.objects.isConnected(repo, childOid)).rejects.toThrow(
			/no derived row/,
		)
		await expect(deps.objects.isAncestor(repo, parentOid, childOid)).rejects.toThrow(
			/no derived row/,
		)
		await expect(createGc(db.sql).gc(repo, { graceSeconds: 0 })).rejects.toThrow(
			/no derived row/,
		)
		// And nothing was swept by the failed pass.
		const [row] = await db.sql<{ n: string }[]>`
			select count(*)::text as n from git_object
			where oid = ${Buffer.from(parentOid, "hex")}`
		if (row === undefined) throw new Error("object count query returned no row")
		expect(row.n).toBe("1")
	})

	it("a tag whose derived row is missing crashes peeling and include-tag augmentation", async () => {
		const repo = "policy/corrupt-tag"
		const blob = Buffer.from("hello\n")
		const tree = Buffer.concat([
			Buffer.from("100644 f.txt\0"),
			Buffer.from(computeOid("blob", blob), "hex"),
		])
		const commit = Buffer.from(
			`tree ${computeOid("tree", tree)}\ncommitter t <t@t> 1700000000 +0000\n\nc\n`,
		)
		const commitOid = computeOid("commit", commit)
		const tag = Buffer.from(
			`object ${commitOid}\ntype commit\ntag broken\ntagger t <t@t> 1700000001 +0000\n\nbroken\n`,
		)
		const tagOid = computeOid("tag", tag)
		await deps.objects.putPack(repo, [
			{ content: blob, type: "blob" },
			{ content: tree, type: "tree" },
			{ content: commit, type: "commit" },
			{ content: tag, type: "tag" },
		])
		await deps.refs.setRef(repo, "refs/tags/original", tagOid)
		await db.sql`delete from git_tag where oid = ${Buffer.from(tagOid, "hex")}`

		await expect(deps.refs.setRef(repo, "refs/tags/copy", tagOid)).rejects.toThrow(
			/no derived row/,
		)
		await expect(
			deps.objects.buildPack(repo, [commitOid], [], false, true),
		).rejects.toThrow(/no derived row/)
	})

	it("a blob-mode tree entry naming a TREE fails connectivity for its commit", async () => {
		const entry = Buffer.concat([Buffer.from("100644 f\0"), Buffer.from(treeOid, "hex")])
		const badTreeOid = computeOid("tree", entry)
		const commit = Buffer.from(
			`tree ${badTreeOid}\ncommitter t <t@t> 1700000000 +0000\n\nmistyped-blob\n`,
		)
		const commitOid = computeOid("commit", commit)
		await deps.objects.putPack(REPO, [
			{ content: entry, type: "tree" },
			{ content: commit, type: "commit" },
		])
		expect(await deps.objects.isConnected(REPO, commitOid)).toBe(false)
	})
})

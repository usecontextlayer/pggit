/**
 * Typed-graph policy (adversarial-review fix, 2026-08-19). Two layers:
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
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

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
			const denied = await spawnGit(["push", url, `${bad}:refs/heads/nontip`], {
				cwd: src,
			}).catch((e) => e as Error)
			expect(denied).toBeInstanceOf(Error)
			expect(String(denied)).toContain("invalid new value provided")
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

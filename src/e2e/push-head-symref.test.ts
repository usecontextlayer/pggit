/**
 * HEAD symref establishment on first push to an auto-created repo.
 *
 * Merged from a01-head-on-first-push / a03-head-symref / a08-head-symref.
 *
 * Shared behavior under test (the oracle): canonical git's receive-pack, when it
 * creates the first branch in an otherwise empty/unborn repo, points HEAD at that
 * newly-created branch. The smart-HTTP advertisement then carries a
 * `ref: refs/heads/<b>\tHEAD` symref line and a resolved `HEAD` ref line, so a
 * subsequent `git clone` follows the symref and checks the branch out.
 *
 * pggit auto-creates the repo on first push (repo-resolver.ensureRepoId only
 * inserts the repo name) but never sets a HEAD symref, so it advertises NO HEAD;
 * a clone then emits "remote HEAD refers to nonexistent ref, unable to checkout"
 * and produces an EMPTY working tree even though the object closure is intact.
 *
 * Each describe below is preserved verbatim from its original bug file and carries
 * its own rationale docblock. All three drive the REAL wire (real-git push then
 * ls-remote/clone) and assert the canonical (HEAD-present) outcome, so they are RED
 * until pggit advertises HEAD and GREEN once receive-pack sets HEAD on first push.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/**
 * a01 (empty-degenerate) — receive-pack must SET HEAD on the first push to a
 * fresh/unborn repo.
 *
 * Canonical git's receive-pack, when it creates the first branch in an otherwise
 * empty repo (HEAD is unborn / unset), points HEAD at that newly-created branch.
 * The smart-HTTP advertisement then carries `ref: refs/heads/<b>\tHEAD` and a
 * `HEAD` ref line, so a subsequent `git clone` follows the symref and checks the
 * branch out.
 *
 * pggit auto-creates the repo on first push but never sets HEAD. The wire advert
 * therefore omits HEAD entirely, diverging from canonical git.
 *
 * CONTROL (apples-to-apples, run on disk during exploration): pushing the same
 * source to a fresh `git init --bare` (HEAD defaults to refs/heads/main) yields
 *     ref: refs/heads/main\tHEAD
 *     <oid>\tHEAD
 *     <oid>\trefs/heads/main
 * pggit yields only the `refs/heads/main` line — no HEAD. This test reproduces
 * that divergence by driving real `git push` + `git ls-remote --symref` over the
 * wire and asserting the canonical (HEAD-present) outcome, so it is RED now and
 * GREEN once receive-pack sets HEAD on the first push.
 */
describe("a01 — receive-pack sets HEAD on first push to an empty repo", () => {
	let isolated: IsolatedDb
	let server: GitServer
	let src: string

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		isolated = await createIsolatedSchema(baseUrl)
		const objects = createObjectStore(isolated.sql)
		const refs = createRefStore(isolated.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)

		src = mkdtempSync(join(tmpdir(), "a01-head-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "f.txt"), "hi\n")
		await spawnGit(["add", "f.txt"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await isolated?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("advertises HEAD -> the pushed branch after a first push", async () => {
		const url = `http://127.0.0.1:${server.port}/repo`
		await spawnGit(["push", url, "refs/heads/main:refs/heads/main"], { cwd: src })

		const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		// Canonical receive-pack: HEAD symref now points at refs/heads/main, so the
		// advertisement carries both a `ref: refs/heads/main\tHEAD` symref line and a
		// resolved `HEAD` ref line. `ls-remote --symref` surfaces both.
		const symref = (await spawnGit(["ls-remote", "--symref", url])).stdout
		expect(symref).toContain("ref: refs/heads/main\tHEAD")
		expect(symref).toContain(`${head}\tHEAD`)
	})
})

/**
 * refnames / default-branch selection — after a push that creates a repo, the
 * server MUST establish a HEAD symref pointing at the pushed default branch, the
 * same way `git init --bare` (with init.defaultBranch=main) leaves
 * `HEAD -> refs/heads/main`. Canonical control: push `main` to a fresh bare repo,
 * `git ls-remote --symref HEAD` reports `ref: refs/heads/main\tHEAD` and a clone
 * checks out a working tree. pggit auto-creates the repo on first push but never
 * sets a HEAD symref, so it advertises NO HEAD; a clone emits "remote HEAD refers
 * to nonexistent ref, unable to checkout" and produces an EMPTY working tree.
 *
 * Differential observed against the live server (a03-head1): clone leaves no
 * checked-out file and `HEAD` is unresolvable; the control bare repo checks out
 * the file. The test drives the wire (real-git push then clone) and asserts the
 * canonical outcome, so it is RED until pggit advertises HEAD.
 */
describe("a03 — HEAD symref / default-branch selection on first push", () => {
	it("a clone after a first push checks out the pushed default branch", async () => {
		const baseUrl = inject("pgBaseUrl")
		const isolated = await createIsolatedSchema(baseUrl)
		let server: GitServer | undefined
		const src = mkdtempSync(join(tmpdir(), "a03-head-src-"))
		const clone = mkdtempSync(join(tmpdir(), "a03-head-clone-"))
		try {
			const objects = createObjectStore(isolated.sql)
			const refs = createRefStore(isolated.sql)
			server = await serveOnPort(createGitApp({ objects, refs }), 0)
			const url = `http://127.0.0.1:${server.port}/repo`

			await spawnGit(["init", "-q", "-b", "main", src])
			writeFileSync(join(src, "f.txt"), "hi\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			await spawnGit(["push", url, "refs/heads/main:refs/heads/main"], { cwd: src })

			// Canonical: the clone checks out main's tree (HEAD symref is advertised).
			await spawnGit(["clone", "-c", "protocol.version=2", "--quiet", url, clone])

			// 1. The working tree is populated (a real bare-repo clone checks out HEAD).
			expect(existsSync(join(clone, "f.txt"))).toBe(true)

			// 2. HEAD resolves to the pushed default branch.
			const head = (
				await spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: clone })
			).stdout.trim()
			expect(head).toBe("main")
		} finally {
			await server?.close()
			await isolated.drop()
			rmSync(src, { force: true, recursive: true })
			rmSync(clone, { force: true, recursive: true })
		}
	})
})

/**
 * a08 (content-modes / adversarial QA) — HEAD symref is never established on an
 * auto-created repo.
 *
 * THE ORACLE: pggit must be indistinguishable from canonical git. When you push a
 * branch to a fresh bare repo and clone it back, canonical git advertises a HEAD
 * symref pointing at the pushed branch, so the clone checks out a populated working
 * tree and `HEAD` resolves to the tip commit. (Control: `git init --bare` +
 * `git push file://… main:main` + `git clone` checks out the files.)
 *
 * pggit's auto-create-via-push path (repo-resolver.ensureRepoId) only inserts the repo
 * name — it NEVER sets a HEAD symref. So ls-refs advertises no HEAD, and a real
 * `git clone` of a pushed-to pggit repo produces an EMPTY working tree with an
 * unresolvable HEAD ("remote HEAD refers to nonexistent ref, unable to checkout").
 * The object closure is intact — this is purely the missing HEAD symref — so the
 * fetched data is correct but the checkout silently does not happen.
 *
 * This test drives the REAL wire (spawnGit push then a full clone WITH checkout) and
 * asserts the canonical outcome: the working-tree file exists and HEAD resolves. It
 * is RED today (the file is absent / HEAD won't resolve) and GREEN once pggit sets
 * HEAD on first push.
 */
describe("a08 — clone after first push checks out a working tree (HEAD symref)", () => {
	let isolated: IsolatedDb
	let server: GitServer
	let src: string

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		isolated = await createIsolatedSchema(baseUrl)
		const objects = createObjectStore(isolated.sql)
		const refs = createRefStore(isolated.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)

		// A real source repo on a single `main` branch.
		src = mkdtempSync(join(tmpdir(), "a08-head-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "hello.txt"), "hello world\n")
		await spawnGit(["add", "-A"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await isolated?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("populates the clone's working tree and resolves HEAD, like canonical git", async () => {
		const url = `http://127.0.0.1:${server.port}/repo`
		await spawnGit(["push", url, "refs/heads/main:refs/heads/main"], { cwd: src })

		// A normal clone (WITH checkout) — exactly what a user runs.
		const dest = mkdtempSync(join(tmpdir(), "a08-head-dest-"))
		try {
			await spawnGit(["clone", "-c", "protocol.version=2", "--quiet", url, dest])

			// Canonical git advertises a HEAD symref → the working tree is checked out.
			expect(existsSync(join(dest, "hello.txt"))).toBe(true)
			expect(readFileSync(join(dest, "hello.txt"), "utf8")).toBe("hello world\n")

			// And HEAD resolves to the pushed tip (no detached/unborn HEAD).
			const srcHead = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			const destHead = (
				await spawnGit(["rev-parse", "HEAD"], { cwd: dest })
			).stdout.trim()
			expect(destHead).toBe(srcHead)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

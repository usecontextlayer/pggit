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
 * pggit's auto-create-via-push path (repo-store.ensureRepoId) only inserts the repo
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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

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

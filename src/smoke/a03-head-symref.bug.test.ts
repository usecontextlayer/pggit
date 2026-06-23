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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

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

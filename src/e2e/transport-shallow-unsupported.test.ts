/**
 * a10 shallow-partial — pggit does not implement the v2 `shallow` feature (deepen),
 * and that is a deliberate, documented scope choice for now (fetch is full-history
 * only; see encodeAdvertisement). The CONTRACT we hold it to is therefore the
 * fail-CLEAN one, not the implement-the-feature one: a `git clone --depth=1` against
 * pggit must FAIL LOUDLY — never the original bug, a silent EMPTY repo that exits 0.
 *
 * Once a repo advertises a HEAD symref (receive-pack now sets HEAD on first push),
 * a depth-limited clone hard-errors client-side with `fatal: Server does not support
 * shallow requests` and exits non-zero — exactly the loud, honest failure we want.
 * (The earlier silent-empty-success arose only because a HEAD-less advertisement made
 * git suppress the fetch entirely.)
 *
 * Drives the real wire (push, then `git clone --depth=1`) and asserts the loud
 * failure. GREEN once HEAD is advertised AND shallow is cleanly unsupported; it would
 * RED again if a depth clone ever silently "succeeded" with an empty repo.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

describe("a10 — shallow clone (--depth=1) fails loudly, never a silent empty repo", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)

		src = mkdtempSync(join(tmpdir(), "a10-shallow-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		for (const c of ["c1", "c2", "c3"]) {
			await spawnGit(["commit", "-q", "--allow-empty", "-m", c], { cwd: src })
		}
		const url = `http://127.0.0.1:${server.port}/repo`
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("rejects --depth=1 with a clear shallow error (no silent empty success)", async () => {
		const dest = mkdtempSync(join(tmpdir(), "a10-shallow-dest-"))
		try {
			const url = `http://127.0.0.1:${server.port}/repo`
			const outcome = await spawnGit(["clone", "--depth=1", url, dest]).then(
				() => ({ failed: false, stderr: "" }),
				(e) => ({
					failed: true,
					stderr: e instanceof GitCommandError ? e.stderr : String(e),
				}),
			)

			// The clone must fail loudly — not silently exit 0 with an empty repo.
			expect(outcome.failed).toBe(true)
			// And specifically because shallow is unsupported, not some unrelated error.
			expect(outcome.stderr).toMatch(/shallow/i)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

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

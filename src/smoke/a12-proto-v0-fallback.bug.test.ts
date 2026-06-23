/**
 * a12 protocol-config — pggit serves fetch over git protocol v2 ONLY (the charter:
 * "v2 fetch, v0 push"). A v0/v1 fetch client is therefore out of scope; the CONTRACT
 * we hold pggit to is the fail-CLEAN one: such a client must FAIL LOUDLY, never the
 * original bug — a silent EMPTY clone that exits 0.
 *
 * The GET /info/refs?service=git-upload-pack handler now requires the client to have
 * negotiated v2 (a `Git-Protocol: version=2` request header; git ≥ 2.26 sends it by
 * default). A v0 client (`-c protocol.version=0`) sends no such header and gets a
 * clean HTTP 400 instead of a v2 advertisement it would misread as an empty repo — so
 * `ls-remote` / `clone` over v0 now error out non-zero rather than silently producing
 * nothing.
 *
 * Drives a real v0 git client over the wire and asserts the loud failure. GREEN once
 * the v2-only gate is in place; it would RED again if a v0 client ever silently
 * "succeeded" with an empty result.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

describe("a12 — protocol v0 fetch client fails loudly (v2-only gate)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string
	let url: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
		url = `http://127.0.0.1:${server.port}/a12v0`

		src = mkdtempSync(join(tmpdir(), "pggit-a12-v0-src-"))
		await spawnGit(["init", "-q"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("rejects a protocol.version=0 ls-remote loudly (not a silent empty result)", async () => {
		const outcome = await spawnGit(["-c", "protocol.version=0", "ls-remote", url]).then(
			(r) => ({ failed: false, stderr: "", stdout: r.stdout }),
			(e) => ({
				failed: true,
				stderr: e instanceof GitCommandError ? e.stderr : String(e),
				stdout: "",
			}),
		)
		// A v0 client must hit the v2-only gate (HTTP 400), not get an empty advert.
		expect(outcome.failed).toBe(true)
		expect(outcome.stderr).toMatch(/40[03]/)
	})

	it("rejects a protocol.version=0 clone loudly (not a silent empty repo)", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-a12-v0-dest-"))
		try {
			const outcome = await spawnGit([
				"-c",
				"protocol.version=0",
				"clone",
				"--quiet",
				url,
				dest,
			]).then(
				() => ({ failed: false, stderr: "" }),
				(e) => ({
					failed: true,
					stderr: e instanceof GitCommandError ? e.stderr : String(e),
				}),
			)
			expect(outcome.failed).toBe(true)
			expect(outcome.stderr).toMatch(/40[03]/)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

/**
 * HEAD symref establishment on first push to an auto-created repo.
 *
 * Merged from a01-head-on-first-push / a03-head-symref / a08-head-symref — three
 * fixtures that stood up three schemas, three servers and three pushes to assert
 * one contract, two of them asserting the same two observables.
 *
 * THE CONTRACT, which is canonical git's: receive-pack, creating the first branch
 * in an otherwise unborn repo, points HEAD at that branch. The smart-HTTP
 * advertisement then carries a `ref: refs/heads/<b>\tHEAD` symref line and a
 * resolved `HEAD` ref line, so a subsequent `git clone` follows the symref, checks
 * the branch out, and lands on a HEAD that resolves to the pushed tip — exactly
 * what pushing to a fresh `git init --bare` (whose HEAD defaults to
 * refs/heads/main) produces.
 *
 * ORIGINATED as the breakage probe for the auto-create-via-push path, which only
 * inserted the repo name and never set a HEAD symref: the advert carried no HEAD at
 * all, so a real clone emitted "remote HEAD refers to nonexistent ref, unable to
 * checkout" and produced an EMPTY working tree beside a perfectly intact object
 * closure — correct data, no checkout. Fixed: receive-pack sets HEAD on first push.
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
import { withTempDir } from "@/testing/temp-dir"

describe("HEAD symref on first push to an auto-created repo", () => {
	let isolated: IsolatedDb
	let server: GitServer
	let src: string
	let url = ""
	let srcHead = ""

	beforeAll(async () => {
		isolated = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(isolated.sql)
		const refs = createRefStore(isolated.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
		url = `http://127.0.0.1:${server.port}/repo`

		src = mkdtempSync(join(tmpdir(), "head-symref-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "hello.txt"), "hello world\n")
		await spawnGit(["add", "-A"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		srcHead = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		// The one push: the repo does not exist until this lands, which is the whole
		// subject — HEAD must be established by the create.
		await spawnGit(["push", url, "refs/heads/main:refs/heads/main"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await isolated?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("advertises `ref: refs/heads/main\tHEAD` and a resolved HEAD line", async () => {
		// `ls-remote --symref` surfaces both lines of the advertisement.
		const symref = (await spawnGit(["ls-remote", "--symref", url])).stdout
		expect(symref).toContain("ref: refs/heads/main\tHEAD")
		expect(symref).toContain(`${srcHead}\tHEAD`)
	})

	it("a clone checks the branch out and resolves HEAD to the pushed tip", async () => {
		// A normal clone, WITH checkout — exactly what a user runs.
		await withTempDir("head-symref-dest-", async (dest) => {
			await spawnGit(["clone", "-c", "protocol.version=2", "--quiet", url, dest])

			// The working tree is populated with the pushed content.
			expect(existsSync(join(dest, "hello.txt"))).toBe(true)
			expect(readFileSync(join(dest, "hello.txt"), "utf8")).toBe("hello world\n")

			// And HEAD is on the pushed branch, at the pushed tip (not detached/unborn).
			const branch = (
				await spawnGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dest })
			).stdout.trim()
			expect(branch).toBe("main")
			const destHead = (
				await spawnGit(["rev-parse", "HEAD"], { cwd: dest })
			).stdout.trim()
			expect(destHead).toBe(srcHead)
		})
	})
})

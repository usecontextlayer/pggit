import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { allObjectOids, seedRepoIntoStore } from "@/testing/git-fixtures"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("M0 — full clone over smart-HTTP v2 (real git)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)

		// Build a real source repo: nested dirs, two commits, an annotated tag.
		src = mkdtempSync(join(tmpdir(), "pggit-m0-src-"))
		await spawnGit(["init", "-q"], { cwd: src })
		mkdirSync(join(src, "sub"))
		writeFileSync(join(src, "a.txt"), "alpha\n")
		writeFileSync(join(src, "sub", "b.txt"), "beta\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha2\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c2"], { cwd: src })
		await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: src })

		await seedRepoIntoStore("repo1", src, { objects, refs })
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("clones, passes fsck --full, and recovers the exact object set", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-m0-dest-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${server.port}/repo1`,
				dest,
			])

			await spawnGit(["fsck", "--full"], { cwd: dest }) // throws if broken
			expect(await allObjectOids(dest)).toEqual(await allObjectOids(src))

			const srcHead = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			const destHead = (
				await spawnGit(["rev-parse", "HEAD"], { cwd: dest })
			).stdout.trim()
			expect(destHead).toBe(srcHead)

			expect(existsSync(join(dest, "a.txt"))).toBe(true)
			expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("alpha2\n")
			expect((await spawnGit(["tag", "--list"], { cwd: dest })).stdout.trim()).toBe("v1")
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

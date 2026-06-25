import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	allObjectOids,
	packFiles,
	packObjectOids,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("M1 — incremental fetch negotiation (real git)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string
	let objects: ReturnType<typeof createObjectStore>
	let refs: ReturnType<typeof createRefStore>

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)

		src = mkdtempSync(join(tmpdir(), "pggit-m1neg-src-"))
		await spawnGit(["init", "-q"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha\n")
		writeFileSync(join(src, "keep.txt"), "keep\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha2\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c2"], { cwd: src })

		await seedRepoIntoStore("repo1", src, { objects, refs })
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("transfers only the delta on incremental fetch (have-closure subtracted)", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-m1neg-dest-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${server.port}/repo1`,
				dest,
			])
			const haveAfterClone = await allObjectOids(dest)
			const packsAfterClone = new Set(packFiles(dest))

			// Server advances: a new commit c3 changing a.txt (keep.txt unchanged, so
			// its blob + the unchanged subtree are reused — NOT part of the delta).
			writeFileSync(join(src, "a.txt"), "alpha3\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c3"], { cwd: src })
			await seedRepoIntoStore("repo1", src, { objects, refs })

			// Incremental fetch; keep the received objects as a pack so we can read
			// exactly what crossed the wire (unpackLimit=1 defeats loose-unpacking).
			await spawnGit(
				["-c", "protocol.version=2", "-c", "fetch.unpackLimit=1", "fetch", "origin"],
				{ cwd: dest },
			)

			const newPacks = packFiles(dest).filter((p) => !packsAfterClone.has(p))
			expect(newPacks.length).toBe(1)
			const transferred = await packObjectOids(dest, newPacks[0] as string)

			// The delta = everything reachable from c3 that the clone did not have.
			const delta = (await allObjectOids(src)).filter((o) => !haveAfterClone.includes(o))
			expect(delta.length).toBe(3) // c3 commit + new root tree + new a.txt blob
			expect(transferred).toEqual(delta)

			await spawnGit(["fsck", "--full"], { cwd: dest })
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

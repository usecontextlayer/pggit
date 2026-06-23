import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore, type ObjectStore } from "@/object-store"
import { createRefStore, type RefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { allObjectOids } from "@/testing/git-fixtures"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("M2 — push to an empty repo (real git)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let objects: ObjectStore
	let refs: RefStore

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		// No seed: repo1 is empty — the dominant first-push state.
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
	})

	it("accepts a first push that creates refs/heads/main", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-m2-src-"))
		const back = mkdtempSync(join(tmpdir(), "pggit-m2-back-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			mkdirSync(join(src, "sub"))
			writeFileSync(join(src, "a.txt"), "alpha\n")
			writeFileSync(join(src, "sub", "b.txt"), "beta\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha2\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c2"], { cwd: src })

			const url = `http://127.0.0.1:${server.port}/repo1`
			await spawnGit(["push", url, "HEAD:refs/heads/main"], { cwd: src })

			const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			// The store now holds the branch + every pushed object.
			expect(await refs.listRefs("repo1")).toEqual([
				{ name: "refs/heads/main", oid: head },
			])
			for (const oid of await allObjectOids(src)) {
				expect(await objects.hasObject("repo1", oid)).toBe(true)
			}

			// Differential: real git can fetch back exactly what we stored, fsck-clean.
			await spawnGit(["init", "-q"], { cwd: back })
			await spawnGit(["-c", "protocol.version=2", "fetch", url, "refs/heads/main"], {
				cwd: back,
			})
			await spawnGit(["fsck", "--full"], { cwd: back })
			expect(
				(await spawnGit(["rev-parse", "FETCH_HEAD"], { cwd: back })).stdout.trim(),
			).toBe(head)
			expect(await allObjectOids(back)).toEqual(await allObjectOids(src))
		} finally {
			rmSync(src, { force: true, recursive: true })
			rmSync(back, { force: true, recursive: true })
		}
	})
})

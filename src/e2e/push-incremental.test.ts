import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { allObjectOids, bigFile } from "@/testing/git-fixtures"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("M2 — incremental push: CAS update of an existing ref (real git)", () => {
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
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
	})

	it("accepts a second push that updates the ref (old→new) via CAS", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-m2inc-src-"))
		const back = mkdtempSync(join(tmpdir(), "pggit-m2inc-back-"))
		const url = `http://127.0.0.1:${server.port}/repo1`
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "big.txt"), bigFile("original"))
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			await spawnGit(["push", url, "HEAD:refs/heads/main"], { cwd: src })
			const c1 = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			// Second push: updates main from c1 to c2, exercising the CAS update path.
			writeFileSync(join(src, "big.txt"), bigFile("EDITED"))
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c2"], { cwd: src })
			await spawnGit(["push", url, "HEAD:refs/heads/main"], { cwd: src })
			const c2 = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			expect(c2).not.toBe(c1)
			expect(await refs.listRefs("repo1")).toEqual([{ name: "refs/heads/main", oid: c2 }])

			// Differential: real git fetches the result back, fsck-clean, with the
			// edited content intact across the two pushes.
			await spawnGit(["init", "-q"], { cwd: back })
			await spawnGit(["-c", "protocol.version=2", "fetch", url, "refs/heads/main"], {
				cwd: back,
			})
			await spawnGit(["fsck", "--full"], { cwd: back })
			expect(
				(await spawnGit(["rev-parse", "FETCH_HEAD"], { cwd: back })).stdout.trim(),
			).toBe(c2)
			expect(await allObjectOids(back)).toEqual(await allObjectOids(src))
			await spawnGit(["checkout", "-q", "FETCH_HEAD"], { cwd: back })
			expect(readFileSync(join(back, "big.txt"), "utf8")).toBe(bigFile("EDITED"))
		} finally {
			rmSync(src, { force: true, recursive: true })
			rmSync(back, { force: true, recursive: true })
		}
	})
})

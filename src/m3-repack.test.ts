/**
 * M3 at-rest repack invariant (testing #10). The repack WORKER is deferred, but
 * the soft-delete schema (`packs.dead_at`) already ships, so pin the at-rest
 * contract a future reaper must preserve: re-ingesting a consolidated `git repack`
 * pack over the same history must leave the SERVED object set + refs byte-
 * identical and fsck-clean. The reader does not yet honor `dead_at` (no worker
 * sets it) — that step is an explicit pending obligation below.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore, type ObjectStore } from "@/object-store"
import { createRefStore, type RefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { allObjectOids, seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("M3 — at-rest repack invariant", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let objects: ObjectStore
	let refs: RefStore
	let src = ""

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		objects = createObjectStore(db.db)
		refs = createRefStore(db.db)

		// A real repo: two commits + an annotated tag (a tag object to consolidate too).
		src = mkdtempSync(join(tmpdir(), "pggit-repack-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "one\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "two\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c2"], { cwd: src })
		await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: src })
		await seedRepoIntoStore("repo", src, { objects, refs })

		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	/** Clone the server fresh and return its sorted object set, fsck-verified. */
	async function cloneBackObjects(): Promise<string[]> {
		const dest = mkdtempSync(join(tmpdir(), "pggit-repack-back-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${server.port}/repo`,
				dest,
			])
			await spawnGit(["fsck", "--full"], { cwd: dest })
			return await allObjectOids(dest)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	}

	it("re-ingesting a consolidated pack preserves the served object set and refs", async () => {
		const objectsBefore = await cloneBackObjects()
		const refsBefore = await refs.listRefs("repo")

		// Consolidate the source into a single pack (what a repack worker would ship)
		// and re-ingest it. The served set + refs must not move.
		await spawnGit(["repack", "-adq"], { cwd: src })
		const packDir = join(src, ".git/objects/pack")
		const packName = readdirSync(packDir).find((f) => f.endsWith(".pack"))
		if (!packName) throw new Error("no pack produced by repack")
		await objects.ingestPack("repo", readFileSync(join(packDir, packName)))

		expect(await cloneBackObjects()).toEqual(objectsBefore)
		expect(await refs.listRefs("repo")).toEqual(refsBefore)
	})

	// The reaper that sets `packs.dead_at` and the reader-skip + connectivity-
	// preserving GC are not built yet; pin them when the worker lands.
	it.todo("getObject/listRefs skip dead_at packs once the repack reaper exists")
	it.todo("a clone concurrent with a repack returns a consistent object set")
})

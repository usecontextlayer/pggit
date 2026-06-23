/**
 * At-rest re-ingest invariant (testing #10). The Postgres-native redesign stores
 * objects as rows and drops the pack-blob soft-delete model (`packs.dead_at`, the
 * TTL reaper, the offline repack worker) entirely — GC becomes a reachability
 * set-difference DELETE (redesign §7), a deferred follow-up. What still must hold
 * here: re-ingesting a consolidated `git repack` pack over the same history is
 * idempotent at the served layer — the SERVED object set + refs stay byte-
 * identical and fsck-clean.
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
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)

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

	// A regression FLOOR for the at-rest contract: consolidating a repo's history
	// into one pack and re-ingesting it is idempotent at the served layer (object
	// set + refs unchanged, clone stays fsck-clean) — guarding against an ingest
	// regression that drops/duplicates/corrupts on re-consolidation.
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

	// GC in the redesign is a reachability set-difference DELETE with a grace
	// window (redesign §7), a deferred follow-up; pin these when it lands.
	it.todo("GC deletes unreachable objects while preserving ref-closure connectivity")
	it.todo("a clone concurrent with GC returns a consistent object set")
})

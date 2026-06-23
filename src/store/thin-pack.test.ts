import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { allObjectOids, bigFile, loadAllObjects } from "@/testing/git-fixtures"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("M2 — thin-pack ingest: external REF_DELTA base from the store", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let objects: ObjectStore

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		objects = createObjectStore(db.sql)
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		await container?.stop()
	})

	it("resolves a thin pack against stored bases — and fails without them", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-thin-src-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "big.txt"), bigFile("original"))
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			const c1 = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			const c1Objects = await loadAllObjects(src)

			// One-line edit on a 400-line file: the new blob is overwhelmingly cheaper
			// as a delta, so `pack-objects --thin` emits a REF_DELTA against the c1
			// blob, which lives only outside this pack.
			writeFileSync(join(src, "big.txt"), bigFile("EDITED"))
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c2"], { cwd: src })
			const c2 = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			const thinPack = (
				await spawnGit(["pack-objects", "--thin", "--stdout", "--revs"], {
					cwd: src,
					input: `${c2}\n^${c1}\n`,
				})
			).stdoutBytes

			// Self-verifying: without c1's objects the external base is unresolvable,
			// so ingest MUST fail. (A non-thin pack would succeed here — this asserts
			// the pack really does carry external deltas.)
			await expect(objects.ingestPack("repo-empty", thinPack)).rejects.toThrow()

			// With c1's objects stored, the same thin pack resolves and re-stores c2
			// self-contained.
			await objects.putPack("repo-base", c1Objects)
			await objects.ingestPack("repo-base", thinPack)

			for (const oid of await allObjectOids(src)) {
				expect(await objects.hasObject("repo-base", oid)).toBe(true)
			}

			// The edited blob was reconstructed correctly from the external base.
			const blobOid = (
				await spawnGit(["rev-parse", `${c2}:big.txt`], { cwd: src })
			).stdout.trim()
			const stored = await objects.getObject("repo-base", blobOid)
			expect(stored?.content.toString("utf8")).toBe(bigFile("EDITED"))
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})
})

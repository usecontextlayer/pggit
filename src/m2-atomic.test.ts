import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore, type ObjectStore } from "@/object-store"
import { createRefStore, type RefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)
const A = "a".repeat(40)
const B = "b".repeat(40)
const C = "c".repeat(40)

function oidOf(repo: RefStore, repoId: string, name: string) {
	return repo.listRefs(repoId).then((rs) => rs.find((r) => r.name === name)?.oid)
}

describe("M2 — atomic vs non-atomic ref updates", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let objects: ObjectStore
	let refs: RefStore

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		objects = createObjectStore(db.db)
		refs = createRefStore(db.db)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
	})

	it("creates multiple branches in one --atomic push (real git)", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-atomic-src-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			await spawnGit(
				[
					"push",
					"--atomic",
					`http://127.0.0.1:${server.port}/repo-atomic`,
					"HEAD:refs/heads/one",
					"HEAD:refs/heads/two",
				],
				{ cwd: src },
			)

			expect(await refs.listRefs("repo-atomic")).toEqual([
				{ name: "refs/heads/one", oid: head },
				{ name: "refs/heads/two", oid: head },
			])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	it("rolls the whole batch back when an atomic update has a stale CAS", async () => {
		await refs.applyRefUpdates(
			"atomic-fail",
			[{ newOid: A, oldOid: ZERO, ref: "refs/heads/main" }],
			false,
		)

		// feature is a valid create; main's update is stale (main is A, not C).
		const result = await refs.applyRefUpdates(
			"atomic-fail",
			[
				{ newOid: B, oldOid: ZERO, ref: "refs/heads/feature" },
				{ newOid: B, oldOid: C, ref: "refs/heads/main" },
			],
			true,
		)

		expect(result).toEqual([false, false])
		// Nothing applied: feature was never created and main is untouched.
		expect(await oidOf(refs, "atomic-fail", "refs/heads/feature")).toBeUndefined()
		expect(await oidOf(refs, "atomic-fail", "refs/heads/main")).toBe(A)
	})

	it("applies the good refs and rejects only the stale one when non-atomic", async () => {
		await refs.applyRefUpdates(
			"nonatomic",
			[{ newOid: A, oldOid: ZERO, ref: "refs/heads/main" }],
			false,
		)

		const result = await refs.applyRefUpdates(
			"nonatomic",
			[
				{ newOid: B, oldOid: ZERO, ref: "refs/heads/feature" },
				{ newOid: B, oldOid: C, ref: "refs/heads/main" },
			],
			false,
		)

		expect(result).toEqual([true, false])
		// The valid create landed; the stale update did not.
		expect(await oidOf(refs, "nonatomic", "refs/heads/feature")).toBe(B)
		expect(await oidOf(refs, "nonatomic", "refs/heads/main")).toBe(A)
	})
})

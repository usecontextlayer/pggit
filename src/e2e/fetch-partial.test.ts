import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { allObjectOids, seedRepoIntoStore } from "@/testing/git-fixtures"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** Every object OID in `dir`, split by inflated type. */
async function objectsByType(dir: string): Promise<{ oid: string; type: string }[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const out: { oid: string; type: string }[] = []
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (oid && type) out.push({ oid, type })
	}
	return out
}

describe("M1 — blobless partial clone (real git)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let src: string

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)

		src = mkdtempSync(join(tmpdir(), "pggit-m1-src-"))
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
		await container?.stop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("clones with --filter=blob:none, transferring every object except blobs", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-m1-dest-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--filter=blob:none",
				"--no-checkout",
				"--quiet",
				`http://127.0.0.1:${server.port}/repo1`,
				dest,
			])

			await spawnGit(["fsck"], { cwd: dest }) // promisor-aware; throws if broken

			const srcObjs = await objectsByType(src)
			const expectedNonBlob = srcObjs
				.filter((o) => o.type !== "blob")
				.map((o) => o.oid)
				.sort()
			const blobOids = srcObjs.filter((o) => o.type === "blob").map((o) => o.oid)

			// Sanity: the source really does have blobs to omit.
			expect(blobOids.length).toBeGreaterThan(0)
			// The blobless pack carried exactly the commits + trees + tag.
			expect(await allObjectOids(dest)).toEqual(expectedNonBlob)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})

	it("lazily fetches blobs from the promisor remote on checkout", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-m1-lazy-"))
		try {
			// Checkout is ON: the initial fetch is blobless (our filter), then the
			// checkout must lazily fault HEAD's blobs back via bare `want <oid>`
			// (allowAnySHA1InWant). Correct file contents prove the blobs really
			// came from us — there is no other source.
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--filter=blob:none",
				"--quiet",
				`http://127.0.0.1:${server.port}/repo1`,
				dest,
			])

			expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("alpha2\n")
			expect(readFileSync(join(dest, "sub", "b.txt"), "utf8")).toBe("beta\n")
			await spawnGit(["fsck"], { cwd: dest })
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

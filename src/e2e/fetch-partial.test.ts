import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { allObjectOids, objectsByType, seedRepoIntoStore } from "@/testing/git-fixtures"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("M1 — blobless partial clone (real git)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
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

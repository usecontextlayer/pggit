import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	allObjectOids,
	objectsByType,
	packFiles,
	packObjectOids,
	parseLsTree,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

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
		await withTempDir("pggit-m1-dest-", async (dest) => {
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
		})
	})

	it("lazily fetches blobs from the promisor remote on checkout", async () => {
		await withTempDir("pggit-m1-lazy-", async (dest) => {
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

			// Correct file contents alone do NOT prove a lazy fault: a server that
			// ignored the filter would ship every blob up front and read identically.
			// The pack layout is the observable — the INITIAL fetch's pack (the one
			// carrying the tip commit) must hold no blob at all, and HEAD's blobs must
			// nevertheless be present, i.e. they arrived afterwards on demand.
			const srcBlobs = (await objectsByType(src))
				.filter((o) => o.type === "blob")
				.map((o) => o.oid)
			expect(srcBlobs.length).toBeGreaterThan(0)
			const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: dest })).stdout.trim()
			const packs = await Promise.all(
				packFiles(dest).map(async (pack) => ({
					oids: await packObjectOids(dest, pack),
					pack,
				})),
			)
			const initial = packs.find((p) => p.oids.includes(tip))
			if (initial === undefined)
				throw new Error("no pack in the clone carries the tip commit")
			expect(
				srcBlobs.filter((oid) => initial.oids.includes(oid)),
				"the initial fetch shipped blobs — `blob:none` was not honored",
			).toEqual([])
			const headBlobs = parseLsTree(
				(await spawnGit(["ls-tree", "-r", "HEAD"], { cwd: src })).stdout,
			).map((e) => e.oid)
			const have = new Set(await allObjectOids(dest))
			expect(
				headBlobs.filter((oid) => !have.has(oid)),
				"the checkout never faulted HEAD's blobs back from the promisor remote",
			).toEqual([])
		})
	})
})

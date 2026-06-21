import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import type { GitObjectType } from "@/object"
import { createObjectStore } from "@/object-store"
import type { PackInputObject } from "@/pack/write-pack"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

async function loadAllObjects(dir: string): Promise<PackInputObject[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const objs: PackInputObject[] = []
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (!oid || !type) continue
		const raw = await spawnGit(["cat-file", type, oid], { cwd: dir })
		objs.push({ content: raw.stdoutBytes, type: type as GitObjectType })
	}
	return objs
}

async function allObjectOids(dir: string): Promise<string[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
		{ cwd: dir },
	)
	return list.stdout.trim().split("\n").sort()
}

describe("M0 — full clone over smart-HTTP v2 (real git)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let src: string

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		await objects.migrate()
		await refs.migrate()

		// Build a real source repo: nested dirs, two commits, an annotated tag.
		src = mkdtempSync(join(tmpdir(), "pggit-m0-src-"))
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

		// Seed objects + refs into Postgres.
		await objects.putPack("repo1", await loadAllObjects(src))
		const showRef = await spawnGit(["show-ref"], { cwd: src })
		for (const line of showRef.stdout.trim().split("\n")) {
			const [oid, name] = line.split(" ")
			if (oid && name) await refs.setRef("repo1", name, oid)
		}
		const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()
		await refs.setSymref("repo1", "HEAD", head)

		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("clones, passes fsck --full, and recovers the exact object set", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-m0-dest-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${server.port}/repo1`,
				dest,
			])

			await spawnGit(["fsck", "--full"], { cwd: dest }) // throws if broken
			expect(await allObjectOids(dest)).toEqual(await allObjectOids(src))

			const srcHead = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			const destHead = (
				await spawnGit(["rev-parse", "HEAD"], { cwd: dest })
			).stdout.trim()
			expect(destHead).toBe(srcHead)

			expect(existsSync(join(dest, "a.txt"))).toBe(true)
			expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("alpha2\n")
			expect((await spawnGit(["tag", "--list"], { cwd: dest })).stdout.trim()).toBe("v1")
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

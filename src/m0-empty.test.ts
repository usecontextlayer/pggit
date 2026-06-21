/**
 * M0 — the empty (unborn) repo: the literal first state of every repo the
 * engine/Slate creates. A real `git clone` of an empty served repo must succeed
 * with no objects, and — because we advertise + honor `ls-refs=unborn` — must
 * propagate the server's default branch (HEAD → refs/heads/main) instead of the
 * client's own `init.defaultBranch`. Also pins the receive-pack info/refs HTTP
 * framing (the synthetic `capabilities^{}` advert a first push reads).
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { allObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"

describe("M0 — empty (unborn) repo", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let app: ReturnType<typeof createGitApp>

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.db)
		const refs = createRefStore(db.db)
		// An unborn repo: HEAD points at a branch that has no commit yet. No objects,
		// no direct refs — exactly what `git init` + a server default branch yields.
		await refs.setSymref("empty", "HEAD", "refs/heads/main")
		app = createGitApp({ objects, refs })
		server = await serveOnPort(app, 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
	})

	it("clones an empty repo successfully, with no objects and the server's default branch", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-empty-dest-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"-c",
				"init.defaultBranch=somethingelse",
				"--quiet",
				`http://127.0.0.1:${server.port}/empty`,
				dest,
			])
			// allObjectOids returns [""] for an empty repo (split of empty stdout).
			expect((await allObjectOids(dest)).filter(Boolean)).toEqual([])
			// Unborn HEAD propagated the SERVER's branch, not the client's override.
			const head = (
				await spawnGit(["symbolic-ref", "--short", "HEAD"], { cwd: dest })
			).stdout.trim()
			expect(head).toBe("main")
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})

	it("serves the receive-pack info/refs advert with the synthetic capabilities^{} line", async () => {
		const res = await app.request("/empty/info/refs?service=git-receive-pack")
		expect(res.status).toBe(200)
		expect(res.headers.get("Content-Type")).toBe(
			"application/x-git-receive-pack-advertisement",
		)
		const unpacked = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(unpacked.startsWith("# service=git-receive-pack\n0000\n")).toBe(true)
		expect(unpacked).toContain(`${"0".repeat(40)} capabilities^{}`)
		expect(unpacked).toContain("report-status")
		expect(unpacked).toContain("delete-refs")
	})
})

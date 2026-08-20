import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { allObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack, ZERO_OID } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

describe("M0 — empty (unborn) repo", () => {
	let db: IsolatedDb
	let server: GitServer
	let app: ReturnType<typeof createGitApp>

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		// An unborn repo: HEAD points at a branch that has no commit yet. No objects,
		// no direct refs — exactly what `git init` + a server default branch yields.
		await refs.setSymref("empty", "HEAD", "refs/heads/main")
		app = createGitApp({ objects, refs })
		server = await serveOnPort(app, 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
	})

	it("clones an empty repo successfully, with no objects and the server's default branch", async () => {
		await withTempDir("pggit-empty-dest-", async (dest) => {
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
			expect(await allObjectOids(dest)).toEqual([])
			// Unborn HEAD propagated the SERVER's branch, not the client's override.
			const head = (
				await spawnGit(["symbolic-ref", "--short", "HEAD"], { cwd: dest })
			).stdout.trim()
			expect(head).toBe("main")
		})
	})

	it("serves the receive-pack info/refs advert with the synthetic capabilities^{} line", async () => {
		const res = await app.request("/empty/info/refs?service=git-receive-pack")
		expect(res.status).toBe(200)
		expect(res.headers.get("Content-Type")).toBe(
			"application/x-git-receive-pack-advertisement",
		)
		const unpacked = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(unpacked.startsWith("# service=git-receive-pack\n0000\n")).toBe(true)
		expect(unpacked).toContain(`${ZERO_OID} capabilities^{}`)
		expect(unpacked).toContain("report-status")
		expect(unpacked).toContain("delete-refs")
	})
})

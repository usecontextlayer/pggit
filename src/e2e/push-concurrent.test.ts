/**
 * §8.5 concurrency — the exact scenario CAS exists to protect: two diverged
 * clients racing a push to the SAME ref. Postgres row-level locking on the refs
 * row must let EXACTLY ONE win; the loser is rejected (server `ng stale ref` or a
 * client-side non-ff), and the final store equals the winner. Also pins that a
 * malformed pack becomes a clean `ng ... unpacker error` with the ref unset
 * (readPack runs on attacker-controlled bytes; a bad pack must never apply a ref).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore, type ObjectStore } from "@/object-store"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore, type RefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)

/** Clone the served repo and add one commit on main; return the new tip. */
async function divergedClone(
	url: string,
	label: string,
	body: string,
): Promise<{
	dir: string
	tip: string
}> {
	const dir = mkdtempSync(join(tmpdir(), `pggit-race-${label}-`))
	await spawnGit(["clone", "-c", "protocol.version=2", "--quiet", url, dir])
	writeFileSync(join(dir, "a.txt"), body)
	await spawnGit(["add", "."], { cwd: dir })
	await spawnGit(["commit", "-q", "-m", label], { cwd: dir })
	const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
	return { dir, tip }
}

describe("M2 — concurrent push race + malformed-pack rejection", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let app: ReturnType<typeof createGitApp>
	let objects: ObjectStore
	let refs: RefStore
	let url = ""
	let base = ""

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)

		// A base repo with one commit on main, seeded so both clients clone the same tip.
		base = mkdtempSync(join(tmpdir(), "pggit-race-base-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: base })
		writeFileSync(join(base, "a.txt"), "base\n")
		await spawnGit(["add", "."], { cwd: base })
		await spawnGit(["commit", "-q", "-m", "base"], { cwd: base })
		await seedRepoIntoStore("race", base, { objects, refs })

		app = createGitApp({ objects, refs })
		server = await serveOnPort(app, 0)
		url = `http://127.0.0.1:${server.port}/race`
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
		if (base) rmSync(base, { force: true, recursive: true })
	})

	it("lets exactly one of two racing pushes win; the store equals the winner", async () => {
		const a = await divergedClone(url, "a", "from-a\n")
		const b = await divergedClone(url, "b", "from-b\n")
		try {
			const results = await Promise.allSettled([
				spawnGit(["push", url, "main:refs/heads/main"], { cwd: a.dir }),
				spawnGit(["push", url, "main:refs/heads/main"], { cwd: b.dir }),
			])

			const winners = results.filter((r) => r.status === "fulfilled")
			expect(winners.length).toBe(1) // CAS prevents the lost update

			const stored = (await refs.listRefs("race")).find(
				(r) => r.name === "refs/heads/main",
			)
			const winnerTip = results[0].status === "fulfilled" ? a.tip : b.tip
			expect(stored?.oid).toBe(winnerTip)
			// The loser's distinct commit never became the ref tip.
			expect(stored?.oid).not.toBe(results[0].status === "fulfilled" ? b.tip : a.tip)
		} finally {
			rmSync(a.dir, { force: true, recursive: true })
			rmSync(b.dir, { force: true, recursive: true })
		}
	})

	it("reports a malformed pack as `ng ... unpacker error` and leaves the ref unset", async () => {
		const newOid = "a".repeat(40)
		const body = Buffer.concat([
			encodePktLine(Buffer.from(`${ZERO} ${newOid} refs/heads/bad\0report-status`)),
			encodePkt({ type: "flush" }),
			Buffer.from("this is not a valid packfile"), // garbage → readPack throws
		])
		const res = await app.request("/badrepo/git-receive-pack", {
			body: new Uint8Array(body),
			method: "POST",
		})
		expect(res.status).toBe(200) // the failure is reported in-band, not as HTTP error
		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(report).toMatch(/^unpack [^\n]*\n/) // `unpack <error>`
		expect(report).toContain("ng refs/heads/bad unpacker error")
		expect(
			(await refs.listRefs("badrepo")).find((r) => r.name === "refs/heads/bad"),
		).toBeUndefined()
	})
})

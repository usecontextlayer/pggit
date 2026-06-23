/**
 * a10 shallow-partial dimension — pggit advertises the `filter` fetch capability
 * unconditionally (`fetch=filter`) but only honors `blob:none`. A client that asks
 * for `--filter=tree:0` (a filter spec every canonical filter-enabled git server
 * accepts) is therefore lured into sending `filter tree:0`, and pggit answers with
 * HTTP 400 — aborting the clone (`error: RPC failed; HTTP 400` / `fatal: expected
 * 'packfile'`, exit 128).
 *
 * Oracle: a canonical git server that advertises `filter` accepts `tree:0` and
 * returns a valid (tree+blob-less) pack; the clone succeeds. By advertising the
 * capability and then rejecting a standard filter, pggit makes the client hard-fail
 * a clone it would otherwise complete. (A server that did not advertise `filter`
 * would let git downgrade to a full clone with a warning — also a success.)
 *
 * The test drives the wire (`git push` then `git clone --filter=tree:0`) and asserts
 * the canonical outcome: the clone completes and the tip commit is present. It FAILS
 * now (clone aborts on HTTP 400) and will PASS once pggit honors `tree:0` (or stops
 * advertising filter support it cannot fully provide). It observes behavior, not
 * internals.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("a10 — advertised filter capability must honor tree:0 (not 400)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let src: string
	let tipOid: string

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)

		const { writeFileSync } = await import("node:fs")
		src = mkdtempSync(join(tmpdir(), "a10-tree0-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		for (const c of ["c1", "c2"]) {
			// real content so a tree:0 filter has trees + blobs to omit
			writeFileSync(join(src, `${c}.txt`), `${c} contents\n`)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", c], { cwd: src })
		}
		tipOid = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		const url = `http://127.0.0.1:${server.port}/repo`
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("a --filter=tree:0 clone completes with the tip commit present", async () => {
		const dest = mkdtempSync(join(tmpdir(), "a10-tree0-dest-"))
		try {
			const url = `http://127.0.0.1:${server.port}/repo`
			const cloned = await spawnGit([
				"clone",
				"--filter=tree:0",
				"--no-checkout",
				url,
				dest,
			]).then(
				() => true,
				() => false,
			)

			const haveTip = await spawnGit(["cat-file", "-e", `${tipOid}^{commit}`], {
				cwd: dest,
			}).then(
				() => true,
				() => false,
			)

			expect({ cloned, haveTip }).toEqual({ cloned: true, haveTip: true })
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

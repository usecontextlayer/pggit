/**
 * a06 scale-objects bug — the queryable-view snapshot insert is NOT chunked under
 * the Postgres bind-parameter ceiling.
 *
 * The object-store ingest path chunks its INSERTs (INSERT_BATCH=1000) so a large
 * push lands under the 65534-parameter wire cap. But the post-commit `repo_file`
 * snapshot rebuild (`snapshot-store.rebuildRefSnapshot`) does ONE un-chunked
 * multi-row INSERT of every file at the tip. `repo_file` has 5 bound columns, so a
 * single commit whose tree holds >= 13107 files binds >= 65535 parameters and the
 * driver throws MAX_PARAMETERS_EXCEEDED. The exception escapes the receive-pack
 * handler -> HTTP 500 -> the client's push dies ("the remote end hung up
 * unexpectedly", exit 1) EVEN THOUGH the objects + ref already committed.
 *
 * The live server wires `snapshots: createSnapshotStore(db)` (server.ts), so this
 * reproduces production. Canonical git accepts a 13107-file push without error;
 * pggit must too. Observed via the wire: the push exits 0 and the ref is created.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("a06 — repo_file snapshot insert exceeds the bind-parameter ceiling", () => {
	let isolated: IsolatedDb
	let server: GitServer
	let url: string
	const dirs: string[] = []

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		isolated = await createIsolatedSchema(baseUrl)
		const objects = createObjectStore(isolated.sql)
		const refs = createRefStore(isolated.sql)
		// Wire the queryable-view layer EXACTLY as the live server does (server.ts).
		const snapshots = createSnapshotStore(isolated.sql)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)
		url = `http://127.0.0.1:${server.port}/repo`
	}, 120_000)

	afterAll(async () => {
		await server?.close()
		await isolated?.drop()
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("pushes a single commit whose tree holds 13107 files (>65534 bind params)", async () => {
		// 13107 files * 5 repo_file columns = 65535 bound params > the 65534 cap.
		const N = 13_107
		const src = mkdtempSync(join(tmpdir(), "a06-snap-src-"))
		dirs.push(src)
		await spawnGit(["init", "--quiet", src])
		for (let i = 0; i < N; i++) {
			const sub = join(src, `d${Math.floor(i / 500)}`)
			mkdirSync(sub, { recursive: true })
			writeFileSync(join(sub, `f${i}.txt`), `b${i}\n`)
		}
		// spawnGit injects the pinned identity + clock itself.
		await spawnGit(["add", "-A"], { cwd: src })
		await spawnGit(["commit", "--quiet", "-m", "many files"], { cwd: src })

		// Canonical git accepts this push; pggit must too (no 500 / hangup).
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })

		// The ref must be advertised back — proving the push succeeded end to end.
		const lsRemote = await spawnGit(["ls-remote", url])
		expect(lsRemote.stdout).toMatch(/refs\/heads\/(main|master)/)
	}, 120_000)
})

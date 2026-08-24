/**
 * a06 scale-objects — the queryable-view snapshot insert stays under the Postgres
 * bind-parameter ceiling.
 *
 * `repo_file` binds 5 columns per row, so a single commit whose tree holds 13107
 * files needs 65535 parameters — one past the 65534 wire cap — if the post-commit
 * projection rebuild issues ONE multi-row INSERT. The contract: a push of that tree
 * succeeds like canonical git's, AND the projection actually holds all 13107 rows
 * at the pushed tip.
 *
 * The row count is the load-bearing half. A projection failure is absorbed by
 * design (the rebuild runs after the ref CAS has committed, and its throw is logged
 * rather than propagated, since the push has already succeeded), so the push
 * exiting 0 and the ref being advertised hold whether the insert wrote every row or
 * none. Only reading `repo_file` tells "the chunked insert landed" from "the insert
 * threw and was logged".
 *
 * ORIGINATED as the breakage probe for that un-chunked INSERT: the driver raised
 * MAX_PARAMETERS_EXCEEDED, which at the time escaped the receive-pack handler as an
 * HTTP 500 and killed the client's push ("the remote end hung up unexpectedly")
 * even though objects and ref had committed. Fixed by chunking the rebuild.
 *
 * The live server wires `projection: createRepoFileProjection(db)`, and so does this
 * fixture — the path under test is production's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createRepoFileProjection } from "@/repo-file/projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("a06 — repo_file projection insert stays under the bind-parameter ceiling", () => {
	let isolated: IsolatedDb
	let server: GitServer
	let url: string
	const dirs: string[] = []

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		isolated = await createIsolatedSchema(baseUrl)
		const objects = createObjectStore(isolated.sql)
		const refs = createRefStore(isolated.sql)
		// Wire the projection EXACTLY as the live server does (server.ts).
		const projection = createRepoFileProjection(isolated.sql)
		server = await serveOnPort(createGitApp({ objects, projection, refs }), 0)
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

		// ...and the projection really holds every file at the pushed tip. Without
		// this the whole fixture passes on a projection that wrote nothing.
		const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		const [files] = await isolated.sql<{ n: number }[]>`
			select count(*)::int as n
			from repo_file f join repos r on r.id = f.repo_id
			where r.name = 'repo'`
		if (files === undefined) throw new Error("snapshot count query returned no row")
		expect(files.n).toBe(N)
		const [head] = await isolated.sql<{ commit_oid: Buffer; ref_name: string }[]>`
			select h.ref_name, h.commit_oid
			from repo_file_head h join repos r on r.id = h.repo_id
			where r.name = 'repo'`
		if (head === undefined) throw new Error("snapshot head row missing")
		expect(head.commit_oid.toString("hex")).toBe(tip)
	}, 120_000)
})

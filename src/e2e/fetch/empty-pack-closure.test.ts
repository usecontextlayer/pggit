/**
 * neg02 incremental-negotiation — a `want` the client already owns through its
 * `have`-closure is served as NOTHING. The pack pggit builds for that shape carries
 * exactly the objects canonical `git upload-pack --stateless-rpc` builds for the
 * same request bytes: zero.
 *
 * The shape: linear history c1..c6, a v2 fetch with `want c3` (old) and `have c6`
 * (the tip). c3 is an ANCESTOR of c6, so the client already holds c3 and its whole
 * closure and there is nothing left to send.
 *
 * WHY A RAW-WIRE REQUEST: a real git HTTP client never issues `want c3 / have c6`
 * when c3 is an ancestor of its local c6 — it short-circuits because it already has
 * the ref target. The shape is only reachable by putting the exact negotiation bytes
 * on the wire, so this test builds them once and feeds the SAME bytes to pggit and
 * to a real `git upload-pack` over the source repo — the oracle is a dependency of
 * the run, not a remembered value.
 *
 * ORIGINATED as the breakage probe for a serve set that subtracted the have-closure
 * and then re-added EVERY explicit want — a re-add justified only for partial-clone
 * promisor roots, which on a plain fetch shipped a 1-object pack carrying a commit
 * whose tree the same pack omitted (connectivity-incomplete in isolation). Fixed:
 * the served set is routed and that re-add is scoped to the promisor case.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createRepoFileProjection } from "@/repo-file/projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { packObjectCount } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"
import { spawnUploadPack } from "@/testing/upload-pack-oracle"
import { fetchRequest } from "@/testing/wire-fetch"

describe("neg02 — buildPack must not re-add a want already in the have-closure (minimal pack)", () => {
	let db: IsolatedDb
	let server: GitServer
	let app: ReturnType<typeof createGitApp>
	let url: string
	let src: string
	let c3 = ""
	let c6 = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		// Wire the projection exactly as the live server does (server.ts).
		const projection = createRepoFileProjection(db.sql)
		app = createGitApp({ objects, projection, refs })
		server = await serveOnPort(app, 0)
		url = `http://127.0.0.1:${server.port}/neg02`

		// Linear history c1 ← c2 ← … ← c6, pushed over the real wire. c3 is an
		// ancestor of c6, so the c3 closure is fully contained in the c6 closure.
		src = mkdtempSync(join(tmpdir(), "pggit-neg02-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		for (const v of ["1", "2", "3", "4", "5", "6"]) {
			writeFileSync(join(src, "a.txt"), `${v}\n`)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", `c${v}`], { cwd: src })
		}
		c6 = (await spawnGit(["rev-parse", "main"], { cwd: src })).stdout.trim()
		c3 = (await spawnGit(["rev-parse", "main~3"], { cwd: src })).stdout.trim()
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("serves a want fully contained in the have-closure exactly as canonical git does: a ZERO-object pack", async () => {
		const request = fetchRequest({
			done: true,
			haves: [c6],
			objectFormat: "sha1",
			wants: [c3],
		})
		const res = await app.request("/neg02/git-upload-pack", {
			body: request,
			headers: { "Git-Protocol": "version=2" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		const ours = Buffer.from(await res.arrayBuffer())

		// THE ORACLE: the identical request bytes through real `git upload-pack
		// --stateless-rpc` over the source repo. Asserting the oracle's own count
		// first keeps the differential honest — a helper that silently found no PACK
		// would otherwise let `null === null` pass for agreement.
		const oracle = await spawnUploadPack(src, request)
		expect(packObjectCount(oracle)).toEqual({ kind: "pack", objectCount: 0 })
		expect(packObjectCount(ours)).toEqual(packObjectCount(oracle))
	}, 60_000)
})

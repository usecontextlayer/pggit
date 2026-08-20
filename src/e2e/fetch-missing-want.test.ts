/**
 * A `want` the repo does NOT have is answered the way canonical upload-pack answers
 * it: IN-BAND. Two describes over one contract —
 *   - mal: in-process, per shape. A well-formed but absent OID comes back HTTP 200
 *     carrying `ERR upload-pack: not our ref <oid>`; a want that is not a 40-hex OID
 *     at all never reaches the store — it is a malformed request, rejected at the
 *     wire boundary with HTTP 400.
 *   - mal01: the same absent OID through a real `git fetch`, asserting what the
 *     CLIENT prints: `fatal: remote error: upload-pack: not our ref <oid>`, with no
 *     HTTP 5xx and no `expected 'packfile'`.
 *
 * The empty-repo case does not reach this path at all (an empty repo short-circuits
 * to an empty pack), so both fixtures seed real objects first and then want a
 * DIFFERENT, absent OID.
 *
 * ORIGINATED as the breakage probe for `buildPack` throwing a bare Error for an
 * incomplete want closure: not being a `GitProtocolError`, it fell through to the
 * app's onError as HTTP 500, and the client died with `RPC failed; HTTP 500` /
 * `fatal: expected 'packfile'` instead of reading git's own diagnosis. Fixed by the
 * typed WantNotFoundError and its in-band ERR encoding.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

// A well-formed 40-hex OID a seeded repo does not (and cannot) contain.
const ABSENT_OID = "c".repeat(40)

describe("mal — fetch of a want absent from the store must not 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>

	async function postFetch(
		repo: string,
		want: string,
	): Promise<{ status: number; text: string }> {
		const res = await app.request(`/${repo}/git-upload-pack`, {
			body: fetchRequest({ done: true, objectFormat: "sha1", wants: [want] }),
			headers: { "Git-Protocol": "version=2" },
			method: "POST",
		})
		return {
			status: res.status,
			text: Buffer.from(await res.arrayBuffer()).toString("utf8"),
		}
	}

	it("answers an absent want in-band (200 + ERR) and a malformed one at the boundary (400)", async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			const objects = createObjectStore(db.sql)
			app = createGitApp({ objects, refs: createRefStore(db.sql) })

			// The repo must EXIST for the bug to bite: buildPack short-circuits to an
			// empty pack when the repo id is null, so seed one real object first. Now a
			// `want` for a DIFFERENT, absent object exercises the missing-want throw.
			await objects.putPack("malmw", [{ content: Buffer.from("hi\n"), type: "blob" }])

			// A well-formed 40-hex OID the (now non-empty) repo does not have: a client
			// condition, so upload-pack says so IN-BAND under a 200, naming the oid —
			// exactly the text real git prints back (pinned end-to-end by mal01 below).
			const absent = await postFetch("malmw", ABSENT_OID)
			expect(absent.status).toBe(200)
			expect(absent.text).toContain(`ERR upload-pack: not our ref ${ABSENT_OID}`)
			// A want that is not an object id at all never reaches the store — it is a
			// malformed request, rejected at the wire boundary.
			const garbage = await postFetch("malmw", "zzzz")
			expect(garbage.status).toBe(400)
		} finally {
			await db?.drop()
		}
	})
})

describe("mal01 — fetch of a want absent from a non-empty repo errors cleanly (not HTTP 500)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string
	let url: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const snapshots = createRepoFileProjection(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)
		url = `http://127.0.0.1:${server.port}/mal01`

		// The repo must EXIST and hold objects for the bug to bite (an empty repo
		// short-circuits to an empty pack). Push one real commit over the wire.
		src = mkdtempSync(join(tmpdir(), "pggit-mal01-src-"))
		await spawnGit(["init", "-q"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("fetching a want the repo does not have fails CLEANLY — no HTTP 5xx, no 'expected packfile'", async () => {
		// Fetch a specific, absent OID into a fresh client repo over protocol v2.
		const dest = mkdtempSync(join(tmpdir(), "pggit-mal01-dest-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dest })
			const outcome = await attemptGit(
				["-c", "protocol.version=2", "fetch", url, ABSENT_OID],
				dest,
			)

			// The fetch MUST fail: the ref genuinely is not ours.
			expect(outcome.ok).toBe(false)

			// ...but it must fail like the ORACLE — a clean, client-readable protocol
			// error (`fatal: remote error: upload-pack: not our ref <oid>`), NOT the
			// `RPC failed; HTTP 500` / `expected 'packfile'` transport breakdown.
			expect(outcome.stderr).not.toMatch(/HTTP 5\d\d/)
			expect(outcome.stderr).not.toMatch(/expected 'packfile'/)
			// And the message names the absent ref, the way real git does.
			expect(outcome.stderr).toMatch(/not our ref/)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

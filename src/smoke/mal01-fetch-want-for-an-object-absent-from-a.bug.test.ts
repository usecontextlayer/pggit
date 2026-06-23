/**
 * mal01 — a v2 `fetch` whose `want` names an object that the (NON-EMPTY) repo does
 * NOT have must surface as a CLEAN, client-readable error — never an unhandled
 * HTTP 500 transport breakdown.
 *
 * THE BUG (EXPECTED-RED until pggit is fixed):
 *   `object-store.buildPack` throws a bare `Error("upload-pack: wanted objects
 *   missing from store: …")` (object-store.ts:101) when a want's closure is
 *   incomplete. That is not a `GitProtocolError`, so `createGitApp`'s onError maps
 *   it to HTTP 500 ("internal server error"). The real git client then dies with
 *   `error: RPC failed; HTTP 500 …` / `fatal: expected 'packfile'` — a transport
 *   failure, NOT a protocol-level "ref unknown" message.
 *
 *   The empty-repo case does NOT trigger it (buildPack short-circuits to an empty
 *   pack when the repo id is null), so the repo must already hold objects — hence
 *   we push a real commit first, then `want` a DIFFERENT, absent OID.
 *
 * THE ORACLE (what real git upload-pack does, verified directly):
 *   It answers IN-BAND with a pkt-line `ERR upload-pack: not our ref <oid>`; the
 *   HTTP response is a normal 200 carrying that ERR, and the client prints
 *   `fatal: remote error: upload-pack: not our ref <oid>` and exits non-zero.
 *   The failure is a clean, readable protocol error — it is NEVER an HTTP 500 and
 *   NEVER `fatal: expected 'packfile'`.
 *
 * This drives a REAL git client over the wire and asserts the oracle contract:
 * the fetch fails (the ref is genuinely absent), but cleanly — no HTTP 5xx, no
 * "expected 'packfile'" transport breakdown. RED on current code (the client sees
 * the 500); GREEN once pggit answers the missing want in-band like real git.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

// A well-formed 40-hex OID the seeded repo does not (and cannot) contain.
const ABSENT_OID = "c".repeat(40)

describe("mal01 — fetch of a want absent from a non-empty repo errors cleanly (not HTTP 500)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string
	let url: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const snapshots = createSnapshotStore(db.sql)
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
			const outcome = await spawnGit(
				["-c", "protocol.version=2", "fetch", url, ABSENT_OID],
				{ cwd: dest },
			).then(
				() => ({ failed: false, stderr: "" }),
				(e) => ({
					failed: true,
					stderr: e instanceof GitCommandError ? e.stderr : String(e),
				}),
			)

			// The fetch MUST fail: the ref genuinely is not ours.
			expect(outcome.failed).toBe(true)

			// ...but it must fail like the ORACLE — a clean, client-readable protocol
			// error, NOT an HTTP 500 transport breakdown.
			//
			// Current (buggy) pggit emits:
			//   error: RPC failed; HTTP 500 …  /  fatal: expected 'packfile'
			// Real git emits:
			//   fatal: remote error: upload-pack: not our ref <oid>
			//
			// These two assertions are RED on current code and GREEN once pggit
			// answers the missing want in-band.
			expect(outcome.stderr).not.toMatch(/HTTP 5\d\d/)
			expect(outcome.stderr).not.toMatch(/expected 'packfile'/)
			// And the message names the absent ref, the way real git does.
			expect(outcome.stderr).toMatch(/not our ref/)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

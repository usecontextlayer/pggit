/**
 * fetch of a `want` the repo does NOT have must error CLEANLY — never an
 * unhandled HTTP 500 transport breakdown.
 *
 * Merged from two regression suites for the same root-cause bug:
 *   - mal (mal-missing-want-500): in-process Hono assertion that a v2 fetch for
 *     an absent want (well-formed-but-absent OID AND garbage non-hex OID) returns
 *     a client-readable status < 500, never an unhandled 500.
 *   - mal01 (mal01-fetch-want-for-an-object-absent-from-a): end-to-end real-git
 *     client over the wire, asserting the oracle contract — the fetch fails, but
 *     cleanly (no HTTP 5xx, no `expected 'packfile'`, message names "not our ref").
 *
 * THE BUG (EXPECTED-RED until pggit is fixed):
 *   `object-store.buildPack` throws a bare `Error("upload-pack: wanted objects
 *   missing from store: …")` (object-store.ts:101) when a want's closure is
 *   incomplete. That is not a `GitProtocolError`, so `createGitApp`'s onError
 *   maps it to HTTP 500 ("internal server error"). Real git's upload-pack instead
 *   answers IN-BAND with `ERR upload-pack: not our ref <oid>` (HTTP 200), and the
 *   client prints `fatal: remote error: upload-pack: not our ref <oid>`.
 *
 *   The empty-repo case does NOT trigger it (buildPack short-circuits to an empty
 *   pack when the repo id is null), so the repo must already hold objects — hence
 *   each suite seeds a real object/commit first, then `want`s a DIFFERENT, absent
 *   OID. `Buffer.from("zzzz","hex")` silently yields an empty OID, so a garbage
 *   want hits the same path with an empty oid in the message.
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
import { GitCommandError, spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

// A well-formed 40-hex OID a seeded repo does not (and cannot) contain.
const ABSENT_OID = "c".repeat(40)

describe("mal — fetch of a want absent from the store must not 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>

	async function postFetch(repo: string, want: string): Promise<number> {
		const res = await app.request(`/${repo}/git-upload-pack`, {
			body: fetchRequest({ done: true, objectFormat: "sha1", wants: [want] }),
			headers: { "Git-Protocol": "version=2" },
			method: "POST",
		})
		return res.status
	}

	it("returns a client-readable error (< 500), never an unhandled 500", async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			const objects = createObjectStore(db.sql)
			app = createGitApp({ objects, refs: createRefStore(db.sql) })

			// The repo must EXIST for the bug to bite: buildPack short-circuits to an
			// empty pack when the repo id is null, so seed one real object first. Now a
			// `want` for a DIFFERENT, absent object exercises the missing-want throw.
			await objects.putPack("malmw", [{ content: Buffer.from("hi\n"), type: "blob" }])

			// Well-formed 40-hex OID the (now non-empty) repo does not have.
			expect(await postFetch("malmw", "c".repeat(40))).toBeLessThan(500)
			// Garbage non-hex OID — coerces to an empty buffer, same buildPack throw.
			expect(await postFetch("malmw", "zzzz")).toBeLessThan(500)
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

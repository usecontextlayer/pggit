/**
 * nam03 (naming-isolation) — an over-long, INCOMPRESSIBLE repo name is rejected
 * by the Postgres btree limit on `repos_name_key` rather than by a boundary-level
 * length check. pggit has NO repo-name length validation: the name only enters via
 * the URL path and is inserted verbatim by `repos.ensureRepoId`. Whether a long
 * name lands is therefore content-dependent — a highly-compressible 3004-byte name
 * inserts fine (btree suffix/prefix dedup shrinks the index tuple), but an
 * incompressible ~2804-byte name produces an index tuple over the btree "version 4
 * maximum 2704" and the INSERT throws inside the receive-pack ingest try/catch.
 *
 * That rejection is LOUD and NON-CORRUPTING — exactly the fail-CLEAN contract this
 * test LOCKS (like a10/a12), NOT a corruption bug:
 *   - the push FAILS non-zero (`[remote rejected] ... (unpacker error)`), it does
 *     not silently half-succeed;
 *   - it is reported IN-BAND: git parsed a valid report-status, so the server
 *     answered HTTP 200, never a 500 / dropped connection;
 *   - the ingest is ATOMIC: ZERO `repos` rows for the rejected name are left
 *     behind (no orphan repo id);
 *   - the server stays HEALTHY — a subsequent normal push to a short-named repo
 *     succeeds and round-trips.
 *
 * GREEN today (the fail-clean contract holds). It would RED if the over-long name
 * ever (a) silently half-inserts a repo row, (b) crashes the request to a 500 /
 * dropped connection, or (c) wedges the server for later pushes.
 *
 * KNOWN QUALITY GAP (intentionally NOT asserted as a hard contract here, so this
 * test stays GREEN and a clean fix doesn't need to touch it): the rejection reason
 * is currently a raw leaked PostgresError ("index row size 2816 exceeds btree
 * version 4 maximum 2704 ...") framed as an `unpack` failure, when the real cause
 * is repo-name-too-long. A boundary-level repo-name length check producing a clean
 * message at the right layer is the recommended follow-up.
 */

import { createHash } from "node:crypto"
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

/**
 * Deterministic, INCOMPRESSIBLE repo name. Concatenating sha256 hex of distinct
 * counters yields a string with no repeated block, so the btree index tuple cannot
 * be compressed under the 2704-byte ceiling — this is what trips `repos_name_key`.
 * (A repeated-block name of the same length would compress and insert fine, which
 * is exactly why the ceiling is content-dependent.) ~2800 hex chars + "nam-".
 */
function incompressibleName(): string {
	let hex = ""
	for (let i = 0; hex.length < 2800; i++) {
		hex += createHash("sha256").update(`nam03-incompressible|${i}`).digest("hex")
	}
	return `nam-${hex.slice(0, 2800)}`
}

describe("nam03 — over-long incompressible repo name fails clean (in-band, atomic, server-healthy)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string
	const longName = incompressibleName()

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const snapshots = createSnapshotStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)

		src = mkdtempSync(join(tmpdir(), "pggit-nam03-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("rejects the over-long name loudly and in-band (not a 500 / not a silent half-success)", async () => {
		const url = `http://127.0.0.1:${server.port}/${longName}`
		const outcome = await spawnGit(["push", url, "main"], { cwd: src }).then(
			() => ({ failed: false, stderr: "" }),
			(e) => ({
				failed: true,
				stderr: e instanceof GitCommandError ? e.stderr : String(e),
			}),
		)

		// LOUD: the push must fail non-zero, not silently half-succeed.
		expect(outcome.failed).toBe(true)
		// IN-BAND: git parsed a report-status `unpacker error` (HTTP 200), which it
		// could not do if the server had 500'd / dropped the connection. A transport
		// 500 surfaces in git's stderr as "HTTP 500" / "RPC failed", never the
		// report-status `unpacker error` / `[remote rejected]` framing below.
		expect(outcome.stderr).toMatch(/unpacker error|remote rejected/)
		expect(outcome.stderr).not.toMatch(/HTTP 500|RPC failed|HTTP request failed/)
	})

	it("leaves ZERO partial repos rows for the rejected name (atomic ingest)", async () => {
		const rows = await db.sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM repos WHERE name = ${longName}
		`
		expect(rows[0]?.n).toBe(0)
	})

	it("stays healthy: a normal short-named push afterward still succeeds and round-trips", async () => {
		const url = `http://127.0.0.1:${server.port}/nam03ok`
		// Must NOT throw — the earlier rejection did not wedge the server.
		await spawnGit(["push", url, "main"], { cwd: src })

		const ls = await spawnGit(["ls-remote", url])
		expect(ls.stdout).toMatch(/refs\/heads\/main/)
	})
})

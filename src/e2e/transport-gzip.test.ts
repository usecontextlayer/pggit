/**
 * Transport gzip request-body handling for the smart-HTTP upload-pack endpoint.
 *
 * Merged from two regression suites:
 *  - http-gzip-request: the happy/identity/unsupported-encoding decode boundary
 *    (real git clones a many-ref repo whose fetch request git gzip-compresses;
 *    plus deterministic manual gzip, identity, and unsupported-encoding cases).
 *  - pro02 (post-with-content-encoding-gzip-but-a-non-gzip-body): a body that
 *    LIES about being gzip must yield a clean 400, never a 500, consistent with
 *    the sibling unsupported encodings (deflate / br / unknownfoo).
 *
 * Both suites are kept as their own top-level describe blocks (the safe combine):
 * their `postUploadPack` helpers have different signatures, so each lives in its
 * own block scope to avoid a top-level redeclaration.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import type { GitObjectType } from "@/object/object"
import type { PackInputObject } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

async function loadAllObjects(dir: string): Promise<PackInputObject[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const objs: PackInputObject[] = []
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (!oid || !type) continue
		const raw = await spawnGit(["cat-file", type, oid], { cwd: dir })
		objs.push({ content: raw.stdoutBytes, type: type as GitObjectType })
	}
	return objs
}

async function allObjectOids(dir: string): Promise<string[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
		{ cwd: dir },
	)
	return list.stdout.trim().split("\n").sort()
}

// A minimal, valid v2 `ls-refs` request (command + delim + flush, no args → list
// every ref). Built from our own pkt-line encoders so the gzip cases test the
// transport, not a hand-authored byte string. Identical in both source suites,
// so kept as a single module-level const.
const LS_REFS_REQUEST = Buffer.concat([
	encodePktLine(Buffer.from("command=ls-refs\n")),
	encodePkt({ type: "delim" }),
	encodePkt({ type: "flush" }),
])

// git gzip-compresses the upload-pack *fetch* request (Content-Encoding: gzip)
// once it carries enough `want` lines. A clone wants one per advertised ref, so
// fanning out many refs at the tip pushes the request past git's compression
// threshold — the smart-HTTP transport detail single-ref m0/m1 clones never hit.
const REF_COUNT = 64

describe("smart-HTTP — request body Content-Encoding (gzip)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let src: string

	// File-1 variant: a free function parameterized by `port`, returning the full
	// Response (callers assert status + body). Kept in block scope to avoid a
	// top-level collision with the pro02 variant's same-named helper.
	function postUploadPack(
		port: number,
		body: Buffer,
		contentEncoding?: string,
	): Promise<Response> {
		const headers: Record<string, string> = {
			"content-type": "application/x-git-upload-pack-request",
			"git-protocol": "version=2",
		}
		if (contentEncoding) headers["content-encoding"] = contentEncoding
		return fetch(`http://127.0.0.1:${port}/repo1/git-upload-pack`, {
			body,
			headers,
			method: "POST",
		})
	}

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)

		src = mkdtempSync(join(tmpdir(), "pggit-gzip-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		for (let i = 0; i < REF_COUNT; i++) {
			await spawnGit(["branch", `b${i}`], { cwd: src })
		}

		await objects.putPack("repo1", await loadAllObjects(src))
		const showRef = await spawnGit(["show-ref"], { cwd: src })
		for (const line of showRef.stdout.trim().split("\n")) {
			const [oid, name] = line.split(" ")
			if (oid && name) await refs.setRef("repo1", name, oid)
		}
		const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()
		await refs.setSymref("repo1", "HEAD", head)

		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	// End-to-end: real git clones a many-ref repo, which makes git gzip the fetch
	// request. The original bug (server fed the gzip body to the pkt-line parser)
	// surfaced here as HTTP 500 "expected 'packfile'".
	it("real git clones a many-ref repo (gzipped fetch request) cleanly", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-gzip-dest-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${server.port}/repo1`,
				dest,
			])
			await spawnGit(["fsck", "--full"], { cwd: dest })
			expect(await allObjectOids(dest)).toEqual(await allObjectOids(src))
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})

	// Deterministic: a manually gzip-compressed request body must be decoded and
	// served (does not depend on git's opaque compression threshold).
	it("decodes a gzip-compressed request body", async () => {
		const res = await postUploadPack(server.port, gzipSync(LS_REFS_REQUEST), "gzip")
		expect(res.status).toBe(200)
		const text = Buffer.from(await res.arrayBuffer()).toString("utf8")
		expect(text).toContain("refs/heads/main")
	})

	// Guard the un-encoded path: the new decode boundary must not break identity bodies.
	it("still serves an uncompressed (identity) request body", async () => {
		const res = await postUploadPack(server.port, LS_REFS_REQUEST)
		expect(res.status).toBe(200)
		const text = Buffer.from(await res.arrayBuffer()).toString("utf8")
		expect(text).toContain("refs/heads/main")
	})

	// Fail loud: an encoding we do not implement must be rejected, never fed raw
	// to the pkt-line parser as if it were plaintext. It is a client-caused error
	// (a `GitProtocolError`), so the boundary returns a clean 400, not a 500.
	it("rejects an unsupported Content-Encoding with a clean 400", async () => {
		const res = await postUploadPack(server.port, gzipSync(LS_REFS_REQUEST), "deflate")
		expect(res.status).toBe(400)
	})
})

/**
 * pro02 protocol-http-boundary — a POST that declares `Content-Encoding: gzip`
 * but carries a body that is NOT valid gzip is a CLIENT-side wire fault, and it
 * MUST surface as a clean HTTP 400, exactly like every other malformed/unsupported
 * encoding already does (`deflate` → 400, `br` → 400, `unknownfoo` → 400 — all via
 * `GitProtocolError`).
 *
 * THE BUG: `readRequestBody` (src/index.ts:53) calls `gunzipSync(raw)` UNGUARDED.
 * On a body that fails to inflate, Node throws a `ZlibError` ("incorrect header
 * check"), which is NOT a `GitProtocolError`, so `createGitApp`'s onError maps it
 * to HTTP 500 "internal server error" — a server fault for a client mistake, and
 * an INCONSISTENCY with the sibling encodings that all return a clean 400.
 *
 * ORACLE EXPECTATION: a declared-gzip body that fails to inflate is a bad request
 * body → clean 400 (like the sibling encodings, and like `git http-backend`, which
 * never 500s on a malformed request body). The fix is trivial: wrap `gunzipSync`
 * and rethrow as a `GitProtocolError`, sharing the existing 400 path.
 *
 * This test is EXPECTED-RED on current code: it asserts the oracle 400 while the
 * server still returns 500. The RED IS the reproduction. It flips to GREEN once
 * pggit wraps the gunzip failure as a GitProtocolError.
 *
 * Observed against the wire (the in-process Hono app over a real listening port),
 * asserting only the HTTP status the client sees — not any internal zlib detail.
 */
describe("pro02 — Content-Encoding: gzip with a non-gzip body yields a clean 400, never 500", () => {
	let db: IsolatedDb
	let server: GitServer

	// pro02 variant: closes over `server` and returns only the HTTP status. Kept
	// in block scope to avoid a top-level collision with the File-1 variant.
	async function postUploadPack(body: Buffer, contentEncoding: string): Promise<number> {
		const res = await fetch(`http://127.0.0.1:${server.port}/pro02/git-upload-pack`, {
			body,
			headers: {
				"content-encoding": contentEncoding,
				"content-type": "application/x-git-upload-pack-request",
				"git-protocol": "version=2",
			},
			method: "POST",
		})
		return res.status
	}

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const snapshots = createSnapshotStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
	})

	it("returns 400 (not 500) for a declared-gzip body that fails to inflate", async () => {
		// A valid pkt-line body, but NOT gzipped. gunzipSync throws ZlibError
		// "incorrect header check". The oracle expects this to share the clean 400
		// path with the other unsupported/malformed encodings.
		const status = await postUploadPack(LS_REFS_REQUEST, "gzip")
		expect(status).toBe(400)
	})

	it("treats the gzip failure consistently with sibling unsupported encodings (all 400)", async () => {
		// Contrast cases that already return a clean 400 via GitProtocolError. The
		// gzip-corrupt case above must join them, not stand alone at 500.
		expect(await postUploadPack(LS_REFS_REQUEST, "deflate")).toBe(400)
		expect(await postUploadPack(LS_REFS_REQUEST, "br")).toBe(400)
		expect(await postUploadPack(LS_REFS_REQUEST, "unknownfoo")).toBe(400)
	})
})

/**
 * Transport gzip request-body handling for the smart-HTTP upload-pack endpoint.
 *
 * Two complementary groups cover this boundary:
 *  - the happy/identity/unsupported-encoding decode boundary
 *    (real git clones a many-ref repo whose fetch request git gzip-compresses;
 *    plus deterministic manual gzip, identity, and unsupported-encoding cases).
 *  - a body that
 *    LIES about being gzip must yield a clean 400, never a 500, consistent with
 *    the sibling unsupported encodings (deflate / br / unknownfoo).
 *
 * The groups use separate top-level describe blocks because their `postUploadPack`
 * helpers have different signatures. The git-oracle helpers come
 * from `@/testing/git-fixtures` — a local copy would miss every guarantee added at
 * that seam.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createRepoFileProjection } from "@/repo-file/projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { allObjectOids, seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

// A minimal, valid v2 `ls-refs` request (command + delim + flush, no args → list
// every ref). Built from our own pkt-line encoders so the gzip cases test the
// transport, not a hand-authored byte string.
const LS_REFS_REQUEST = Buffer.concat([
	encodePktLine(Buffer.from("command=ls-refs\n")),
	encodePkt({ type: "delim" }),
	encodePkt({ type: "flush" }),
])

// git gzip-compresses the upload-pack *fetch* request (Content-Encoding: gzip)
// once it carries enough `want` lines. A clone wants one per advertised ref, so
// fanning out many refs at the tip pushes the request past git's compression
// threshold — a smart-HTTP transport detail single-ref clones do not hit.
const REF_COUNT = 64

describe("smart-HTTP — request body Content-Encoding (gzip)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string

	// This helper is parameterized by `port` and returns the full
	// Response (callers assert status + body). Kept in block scope to avoid a
	// top-level collision with the other group's same-named helper.
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
		db = await createIsolatedSchema(inject("pgBaseUrl"))
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

		await seedRepoIntoStore("repo1", src, { objects, refs })

		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	// End-to-end: real git clones a many-ref repo, which makes git gzip the fetch
	// request. Feeding those compressed bytes to the pkt-line parser would surface
	// as HTTP 500 "expected 'packfile'".
	it("real git clones a many-ref repo (gzipped fetch request) cleanly", async () => {
		await withTempDir("pggit-gzip-dest-", async (dest) => {
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
		})
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
 * A POST that declares `Content-Encoding: gzip` but
 * carries a body that is NOT valid gzip is a CLIENT-side wire fault, and it comes
 * back as a clean HTTP 400 — exactly like every other malformed or unsupported
 * encoding (`deflate`, `br`, `unknownfoo`, all via `GitProtocolError`), and like
 * `git http-backend`, which never 500s on a malformed request body.
 *
 * Inflate failures are translated to `GitProtocolError` so they follow the shared
 * client-error path.
 *
 * Observed against the wire (the in-process Hono app over a real listening port),
 * asserting only the HTTP status the client sees — not any internal zlib detail.
 */
describe("Content-Encoding: gzip with a non-gzip body yields a clean 400", () => {
	let db: IsolatedDb
	let server: GitServer

	// This helper closes over `server` and returns only the HTTP status.
	async function postUploadPack(body: Buffer, contentEncoding: string): Promise<number> {
		const res = await fetch(
			`http://127.0.0.1:${server.port}/malformed-gzip/git-upload-pack`,
			{
				body,
				headers: {
					"content-encoding": contentEncoding,
					"content-type": "application/x-git-upload-pack-request",
					"git-protocol": "version=2",
				},
				method: "POST",
			},
		)
		return res.status
	}

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const projection = createRepoFileProjection(db.sql)
		server = await serveOnPort(createGitApp({ objects, projection, refs }), 0)
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

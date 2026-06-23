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
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore } from "@/refs-store"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

// A minimal, valid v2 `ls-refs` request (command + delim + flush). It is a
// perfectly well-formed pkt-line body — the ONLY thing wrong with the request is
// that the client lied about the Content-Encoding. Built from our own pkt-line
// encoders so the case tests the decode boundary, not a hand-authored byte string.
const LS_REFS_REQUEST = Buffer.concat([
	encodePktLine(Buffer.from("command=ls-refs\n")),
	encodePkt({ type: "delim" }),
	encodePkt({ type: "flush" }),
])

describe("pro02 — Content-Encoding: gzip with a non-gzip body yields a clean 400, never 500", () => {
	let db: IsolatedDb
	let server: GitServer

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

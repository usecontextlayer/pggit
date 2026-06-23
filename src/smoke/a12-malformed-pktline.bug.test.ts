/**
 * a12 protocol-config — a malformed pkt-line in a POST body is the CLIENT's fault
 * and MUST surface as a clean HTTP 400 (GitProtocolError), exactly like an empty
 * body ("upload-pack: unsupported command") or an unsupported capability already
 * do. The pkt-line PARSER (`parseLen` / `decodePktStream`) throws a bare `Error`,
 * not a `GitProtocolError`, so `createGitApp`'s onError maps it to a 500
 * "internal server error" — a server fault for a client mistake. The assignment's
 * stated contract: "A malformed pkt-line length prefix must yield 400, not an
 * unhandled 500." Each case is a distinct malformed-framing shape that a real or
 * adversarial client can put on the wire; all must be 4xx, none 500.
 *
 * Observed against the wire (app.request), asserting the HTTP status the client
 * sees — not any internal parser detail.
 */
import { describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

describe("a12 — malformed pkt-line POST body yields 4xx, never 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>

	async function post(path: string, body: string): Promise<number> {
		const res = await app.request(path, {
			body: Buffer.from(body, "latin1"),
			method: "POST",
		})
		return res.status
	}

	it("never returns 500 for malformed framing", async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			app = createGitApp({
				objects: createObjectStore(db.sql),
				refs: createRefStore(db.sql),
			})

			// Non-hex 4-byte length prefix. parseLen's /^[0-9a-f]{4}$/ rejects it.
			expect(await post("/a12mp/git-upload-pack", "ZZZZ")).toBeLessThan(500)
			// Arbitrary garbage that is not a pkt-line at all.
			expect(
				await post("/a12mp/git-upload-pack", "this is not a pktline at all"),
			).toBeLessThan(500)
			// One non-hex char in an otherwise plausible prefix.
			expect(await post("/a12mp/git-upload-pack", "abcg")).toBeLessThan(500)
			// Reserved length 0003 (decodePktStream throws "reserved length 0003").
			expect(await post("/a12mp/git-upload-pack", "0003")).toBeLessThan(500)
			// Declared payload over the reader bound (ffff ⇒ 65531 > READER_MAX_PAYLOAD).
			expect(await post("/a12mp/git-upload-pack", "ffff")).toBeLessThan(500)
			// Same malformed framing on the receive-pack endpoint.
			expect(await post("/a12mp/git-receive-pack", "ZZZZ")).toBeLessThan(500)
			expect(await post("/a12mp/git-receive-pack", "garbage-not-pkt")).toBeLessThan(500)
		} finally {
			await db?.drop()
		}
	})
})

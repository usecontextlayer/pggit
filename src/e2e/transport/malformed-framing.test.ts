/**
 * Transport-level malformed pkt-line framing.
 *
 * Both describes pin one contract from different angles: a malformed pkt-line on
 * the wire is the CLIENT's fault and comes back as HTTP 400 — never an unhandled
 * 500, and never a swallowed 200 that reinterprets framing garbage as payload.
 *
 * The two groups use DIFFERENT `post` helpers: one hits `app.request` and
 * returns just the status; the other hits a real listening port via `fetch` and
 * returns `{status, text}`). To avoid a top-level redeclaration collision, each
 * `post` is scoped inside its own describe block.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createRepoFileProjection } from "@/repo-file/projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

/**
 * A malformed pkt-line in a POST body is the CLIENT's fault and surfaces as
 * a clean HTTP 400 (GitProtocolError), exactly like an empty body ("upload-pack:
 * unsupported command") or an unsupported capability. Each case below is a distinct
 * malformed-framing shape a real or adversarial client can put on the wire.
 *
 * The status asserted here is the one the client sees, not any parser detail.
 */
describe("malformed pkt-line POST body yields 400", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>

	async function post(path: string, body: string): Promise<number> {
		const res = await app.request(path, {
			body: Buffer.from(body, "latin1"),
			method: "POST",
		})
		return res.status
	}

	it("answers 400 for every malformed framing shape", async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			app = createGitApp({
				objects: createObjectStore(db.sql),
				refs: createRefStore(db.sql),
			})

			// Non-hex 4-byte length prefix. parseLen's /^[0-9a-f]{4}$/ rejects it.
			expect(await post("/a12mp/git-upload-pack", "ZZZZ")).toBe(400)
			// Arbitrary garbage that is not a pkt-line at all.
			expect(await post("/a12mp/git-upload-pack", "this is not a pktline at all")).toBe(
				400,
			)
			// One non-hex char in an otherwise plausible prefix.
			expect(await post("/a12mp/git-upload-pack", "abcg")).toBe(400)
			// Reserved length 0003 (decodePktStream throws "reserved length 0003").
			expect(await post("/a12mp/git-upload-pack", "0003")).toBe(400)
			// Declared payload over the reader bound (ffff ⇒ 65531 > READER_MAX_PAYLOAD).
			expect(await post("/a12mp/git-upload-pack", "ffff")).toBe(400)
			// Same malformed framing on the receive-pack endpoint.
			expect(await post("/a12mp/git-receive-pack", "ZZZZ")).toBe(400)
			expect(await post("/a12mp/git-receive-pack", "garbage-not-pkt")).toBe(400)
		} finally {
			await db?.drop()
		}
	})
})

/**
 * A pkt-line whose declared length OVERRUNS the bytes present, or a command
 * list that ends without a flush, is a framing error on a COMPLETE HTTP body: the
 * server answers 400 and never reinterprets the leftover as pack payload or drops
 * it to an empty argument set.
 *
 * That is canonical git's stance too ("protocol error: bad line length"). The
 * distinction is the completeness of the body: treating an overrun as an INCOMPLETE
 * trailing packet is right for a streaming chunk with more bytes coming, and wrong
 * for a request body where there is no next chunk.
 *
 * A complete body with an overrun or unflushed command stream is rejected as a
 * framing error, never reinterpreted as pack bytes or a zero-want request.
 */
describe("overrun/unterminated pkt-line is a framing error", () => {
	let db: IsolatedDb
	let server: GitServer

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

	async function post(
		path: string,
		body: Buffer,
		headers: Record<string, string> = {},
	): Promise<{ status: number; text: string }> {
		const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
			body,
			headers,
			method: "POST",
		})
		return { status: res.status, text: await res.text() }
	}

	it("receive-pack: an overrun command pkt-line is rejected as a framing error", async () => {
		// `0064` declares a 0x64 = 100-byte pkt-line, but only 9 bytes are present.
		// No flush ever appears before the (nonexistent) pack.
		const body = Buffer.from("0064hello", "latin1")
		const { status, text } = await post("/overrun-command/git-receive-pack", body, {
			"Content-Type": "application/x-git-receive-pack-request",
		})

		// A framing fault is a clean client-readable rejection — the 400 the handler
		// commits to — never a swallowed 200 reinterpreting garbage as a pack.
		expect(status).toBe(400)
		expect(text).not.toMatch(/bad magic/)
	})

	it("receive-pack: a 2-byte truncated length prefix is rejected, not swallowed", async () => {
		// A bare `00` — an incomplete length prefix on a complete body.
		const body = Buffer.from("00", "latin1")
		const { status } = await post("/truncated-prefix/git-receive-pack", body, {
			"Content-Type": "application/x-git-receive-pack-request",
		})
		expect(status).toBe(400)
	})

	it("upload-pack: an overrun want pkt-line is rejected, not dropped to an empty want set", async () => {
		// command=fetch, delim (0001), then `00ff` declares 0xff-4 = 251 payload bytes
		// but supplies far fewer — a shape that must not be dropped into a silent NAK.
		const body = Buffer.from(
			"0012command=fetch\n" +
				"0001" +
				"00ffwant abcdef0123456789abcdef0123456789abcdef01\n" +
				"0000",
			"latin1",
		)
		const { status, text } = await post("/overrun-want/git-upload-pack", body, {
			"Content-Type": "application/x-git-upload-pack-request",
			"Git-Protocol": "version=2",
		})

		// The overrun want is a framing error, not a swallowed 200 that silently
		// produces an empty want set and answers NAK.
		expect(status).toBe(400)
		expect(text).not.toMatch(/acknowledgments/)
	})
})

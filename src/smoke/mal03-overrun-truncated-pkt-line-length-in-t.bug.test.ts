/**
 * mal03 — OVERRUN / TRUNCATED pkt-line length is silently swallowed instead of
 * being a framing error (EXPECTED-RED until pggit is fixed).
 *
 * BUG. `decodePktStream` treats a data pkt-line whose declared length overruns the
 * bytes actually present (`offset + len > buf.length`) as an INCOMPLETE trailing
 * packet and `break`s — a correct stance for a STREAMING chunk that has more bytes
 * coming, but wrong for a COMPLETE HTTP request body, where there is no next chunk.
 * The overrun bytes are then handed back as `rest`:
 *
 *   - receive-pack: `parseReceivePack` calls `decodePktStream(body, {stopAtFlush})`.
 *     It never asserts the command stream was flush-terminated. An overrun (or any
 *     unterminated) command list falls out of the loop with `packets=[]` and the
 *     whole malformed buffer in `rest`, which becomes the `pack`. The server then
 *     tries to UNPACK the framing garbage. OBSERVED against the live wire: a body of
 *     `0064hello` (declares 0x64=100 payload bytes, supplies 5) returns HTTP 200
 *     with an in-band `unpack ... bad magic` — the framing fault was reinterpreted
 *     as a pack payload and swallowed.
 *
 *   - upload-pack: `parseV2Request` calls `decodePktStream(body)`. An overrun `want`
 *     pkt-line (`00ff` declares 251 payload bytes, supplies far fewer) is dropped
 *     from `packets`, so `wants=[]`. OBSERVED: HTTP 200 with a silent
 *     `acknowledgments / NAK` no-op instead of a framing error.
 *
 * ORACLE (real git). A pkt-line whose declared length overruns the available bytes,
 * or a command list that ends without a flush before the pack, is a HARD protocol
 * error ("protocol error: bad line length"). The malformed-wire-fuzz contract: a
 * framing fault must be REJECTED LOUDLY (a 4xx the client can read), never silently
 * reinterpreted as pack payload or dropped args. A crafted overrun whose leftover
 * happens to land on valid-looking PACK bytes could otherwise mask a partial command
 * set with no diagnostic.
 *
 * These assert the HTTP status the client sees on a COMPLETE body of handcrafted
 * malformed wire bytes (real git would never emit these — the server must reject
 * them). EXPECTED-RED: pggit currently answers 200; the oracle wants < 500 AND a
 * non-2xx framing rejection. Goes GREEN once decode/parse rejects a complete body
 * with an overrun or unflushed command stream as a framing error.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

describe("mal03 — overrun/unterminated pkt-line is a framing error, not swallowed", () => {
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
		const { status, text } = await post("/mal03rp/git-receive-pack", body, {
			"Content-Type": "application/x-git-receive-pack-request",
		})

		// Oracle: a framing fault is a clean client-readable rejection (4xx), never a
		// swallowed 200 that re-interprets the garbage as a pack ("bad magic").
		expect(status).toBeLessThan(500)
		expect(status).not.toBe(200)
		expect(text).not.toMatch(/bad magic/)
	})

	it("receive-pack: a 2-byte truncated length prefix is rejected, not swallowed", async () => {
		// A bare `00` — an incomplete length prefix on a complete body.
		const body = Buffer.from("00", "latin1")
		const { status } = await post("/mal03rp2/git-receive-pack", body, {
			"Content-Type": "application/x-git-receive-pack-request",
		})
		expect(status).toBeLessThan(500)
		expect(status).not.toBe(200)
	})

	it("upload-pack: an overrun want pkt-line is rejected, not dropped to an empty want set", async () => {
		// command=fetch, delim (0001), then `00ff` declares 0xff-4 = 251 payload bytes
		// but supplies far fewer. The want is currently dropped -> silent NAK no-op.
		const body = Buffer.from(
			"0012command=fetch\n" +
				"0001" +
				"00ffwant abcdef0123456789abcdef0123456789abcdef01\n" +
				"0000",
			"latin1",
		)
		const { status, text } = await post("/mal03up/git-upload-pack", body, {
			"Content-Type": "application/x-git-upload-pack-request",
			"Git-Protocol": "version=2",
		})

		// Oracle: the overrun want is a framing error (4xx), not a swallowed 200 that
		// silently produces an empty want set and answers NAK.
		expect(status).toBeLessThan(500)
		expect(status).not.toBe(200)
		expect(text).not.toMatch(/acknowledgments/)
	})
})

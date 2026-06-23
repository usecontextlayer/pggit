/**
 * blb01 (large-blobs, SERVE side) — a blob larger than V8's max string length
 * (0x1fffffe8 ≈ 512M chars) can be PUSHED but never FETCHED back: it is write-only.
 *
 * a07 fixed the INGEST half (raw-bytes binary COPY, no JS string) and asserts a
 * ~257MB blob stores + the ref lands. But it never reads the blob back, so the
 * SERVE half stayed broken: `buildPack` reads `git_object.content` through the
 * porsager driver, which decodes a `bytea` result from its text wire form
 * (`'\x' + hex`, DOUBLE the byte length). A blob over ~256MiB therefore makes the
 * driver build a string longer than V8's hard cap and throw
 * `Cannot create a string longer than 0x1fffffe8 characters`. That escapes
 * `buildPack` (object-store.ts) as a bare Error → Hono onError → HTTP 500, so a
 * real `git clone`/`fetch` of the blob dies with `RPC failed; HTTP 500 / expected
 * 'packfile'`. The object is durably stored yet unreadable.
 *
 * Observable contract (driven over the wire, asserting only the wire outcome): the
 * push report is `unpack ok` AND a subsequent v2 fetch of the stored blob returns
 * HTTP 200 with a packfile — never a 500. Verified live at :8080: push exit 0,
 * clone → HTTP 500 + the string-cap error in the server log.
 *
 * RED now: the fetch returns 500. GREEN once the serve path reads large `bytea`
 * as raw bytes (e.g. a binary COPY-out / cursor) instead of through a JS string,
 * symmetric to the ingest COPY.
 */
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { computeOid } from "@/object"
import { createObjectStore, type ObjectStore } from "@/object-store"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore, type RefStore } from "@/refs-store"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"

const ZERO = "0".repeat(40)

/** A receive-pack POST body that pushes a single blob and points refs/heads/<branch>
 * at it (no snapshot layer wired, so a blob-tipped branch is accepted — this isolates
 * the SERVE-side string-cap bug from the non-commit-tip snapshot bug). */
function pushBlobBody(blobOid: string, branch: string, content: Buffer): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from(`${ZERO} ${blobOid} refs/heads/${branch}\0report-status`)),
		encodePkt({ type: "flush" }),
		writePack([{ content, type: "blob" }]),
	])
}

/** A v2 upload-pack `fetch` request body: clone-shape (want + done, no haves). */
function fetchBody(wantOid: string): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from("command=fetch\n")),
		encodePktLine(Buffer.from("object-format=sha1\n")),
		encodePkt({ type: "delim" }),
		encodePktLine(Buffer.from(`want ${wantOid}\n`)),
		encodePktLine(Buffer.from("done\n")),
		encodePkt({ type: "flush" }),
	])
}

describe("blb01 — large blob is write-only (serve over V8 string cap)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let objects: ObjectStore
	let refs: RefStore
	const branch = "huge"
	let blobOid: string

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		app = createGitApp({ objects, refs })

		// 270_000_000 bytes > 0x1fffffe8 / 2 ≈ 268_435_443, so the bytea READ result's
		// text form (`\x`+hex, doubled) exceeds V8's max string length. Same sizing +
		// deterministic fill as a07 (no randomness).
		const size = 270_000_000
		const content = Buffer.alloc(size)
		for (let i = 0; i < size; i += 4096) content.writeUInt32LE((i * 2654435761) >>> 0, i)
		blobOid = computeOid("blob", content)

		const res = await app.request("/r/git-receive-pack", {
			body: new Uint8Array(pushBlobBody(blobOid, branch, content)),
			method: "POST",
		})
		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		// Sanity: the blob ingests fine (a07's fix). The bug is purely on serve.
		expect(report).toContain("unpack ok")
		expect(await objects.hasObject("r", blobOid)).toBe(true)
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		await container?.stop()
	})

	it("serves a fetch of a >256MiB stored blob (HTTP 200 packfile), never a 500", async () => {
		const res = await app.request("/r/git-upload-pack", {
			body: new Uint8Array(fetchBody(blobOid)),
			method: "POST",
		})
		// RED: buildPack reads the blob's bytea through a JS string → V8 cap → 500.
		// The stored-but-unfetchable blob is the bug; a clone/fetch must succeed.
		expect(res.status).toBe(200)
		const body = Buffer.from(await res.arrayBuffer())
		// The served upload-pack result carries the packfile (sideband band-1 frames it).
		expect(body.includes(Buffer.from("PACK"))).toBe(true)
	}, 120_000)
})

/**
 * Large-blob behavior over V8's maximum string length (0x1fffffe8 ≈ 512M chars).
 *
 * Merged from a07-large-blob-string-cap.bug + blb01-large-blob-serve-string-cap.bug.
 * Both halves exercise a blob whose raw inflated content exceeds ~256MiB, so a
 * `bytea` value round-tripped through the porsager driver's text wire form
 * (`'\x' + hex`, DOUBLE the byte length) would exceed V8's hard string cap and
 * throw `Cannot create a string longer than 0x1fffffe8 characters`.
 *
 *   - a07 covers the INGEST half: a push carrying such a blob must report
 *     `unpack ok` and land the ref (raw-bytes binary COPY, no JS string).
 *   - blb01 covers the SERVE half: a previously-pushed >256MiB blob must be
 *     FETCHable (HTTP 200 + packfile), never a write-only 500.
 *
 * Each original `describe` is preserved verbatim as its own block so the two
 * bug rationales and their assertions stay independent.
 */
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { computeOid } from "@/object/object"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"
import { fetchRequest } from "@/testing/wire-fetch"

const ZERO = "0".repeat(40)

/**
 * a07 (large-blobs) — a push carrying a single blob larger than V8's maximum
 * string length (0x1fffffe8 ≈ 512MB) is rejected with an unpacker error, where
 * canonical git accepts it.
 *
 * Root cause: on ingest the object's raw inflated `content` Buffer is bound as a
 * Postgres `bytea` parameter; the driver hex-encodes the bytea into a JS string
 * (`'\x' + buf.toString('hex')`), which DOUBLES the byte length. A blob whose
 * content exceeds ~256MiB therefore produces a string longer than V8's hard cap
 * (`Cannot create a string longer than 0x1fffffe8 characters`), the insert
 * throws, ingest aborts, and the ref is never created. Postgres itself accepts
 * `bytea` up to ~1GB and real git happily stores blobs of this size, so pggit is
 * rejecting a push that canonical git accepts.
 *
 * Observable contract (driven over the receive-pack wire, asserting only the wire
 * outcome + stored state — no implementation detail): the report-status must say
 * `unpack ok` and the pushed ref must land, exactly as a bare-repo control would.
 *
 * RED now: the report comes back with an unpacker error and the ref is absent.
 * GREEN once ingest stores large blobs without round-tripping their content
 * through a JS string (e.g. binary bytea bind / COPY).
 */
describe("a07 — large-blob push over V8 string cap", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let objects: ObjectStore
	let refs: RefStore

	/** A receive-pack POST body that pushes `objects` and creates `refs/heads/<branch>`. */
	function pushBody(
		newOid: string,
		branch: string,
		objects: { type: "blob" | "commit" | "tag" | "tree"; content: Buffer }[],
	): Buffer {
		return Buffer.concat([
			encodePktLine(Buffer.from(`${ZERO} ${newOid} refs/heads/${branch}\0report-status`)),
			encodePkt({ type: "flush" }),
			writePack(objects),
		])
	}

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		app = createGitApp({ objects, refs })
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		await container?.stop()
	})

	it("ingests a ~257MB blob and creates the ref (real git accepts it)", async () => {
		// 270_000_000 bytes > 0x1fffffe8 / 2 ≈ 268_435_443, so the hex-encoded bytea
		// parameter string would exceed V8's max string length.
		const size = 270_000_000
		// Incompressible content so the pack stays large and the stored bytea is the
		// full size (a zero blob would compress away but the stored raw is identical
		// length; random just makes the wire transfer representative).
		const content = Buffer.alloc(size)
		for (let i = 0; i < size; i += 4096) content.writeUInt32LE((i * 2654435761) >>> 0, i)

		const blobOid = computeOid("blob", content)
		const branch = "huge"
		const body = pushBody(blobOid, branch, [{ content, type: "blob" }])

		const res = await app.request(`/r/git-receive-pack`, {
			body: new Uint8Array(body),
			method: "POST",
		})
		expect(res.status).toBe(200)

		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		// Canonical git: the pack unpacks and the ref is created.
		expect(report).toContain("unpack ok")
		expect(report).toContain(`ok refs/heads/${branch}`)

		const stored = (await refs.listRefs("r")).find(
			(r) => r.name === `refs/heads/${branch}`,
		)
		expect(stored?.oid).toBe(blobOid)
		expect(await objects.hasObject("r", blobOid)).toBe(true)
	}, 120_000)
})

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
describe("blb01 — large blob is write-only (serve over V8 string cap)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let objects: ObjectStore
	let refs: RefStore
	const branch = "huge"
	let blobOid: string

	/** A receive-pack POST body that pushes a single blob and points refs/heads/<branch>
	 * at it (no snapshot layer wired, so a blob-tipped branch is accepted — this isolates
	 * the SERVE-side string-cap bug from the non-commit-tip snapshot bug). */
	function pushBlobBody(blobOid: string, branch: string, content: Buffer): Buffer {
		return Buffer.concat([
			encodePktLine(
				Buffer.from(`${ZERO} ${blobOid} refs/heads/${branch}\0report-status`),
			),
			encodePkt({ type: "flush" }),
			writePack([{ content, type: "blob" }]),
		])
	}

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
			body: new Uint8Array(
				fetchRequest({ done: true, objectFormat: "sha1", wants: [blobOid] }),
			),
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

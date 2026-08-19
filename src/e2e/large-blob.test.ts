/**
 * Large blobs past V8's maximum string length (0x1fffffe8 ≈ 512M chars) — the
 * ingest and the serve halves of one contract, over one fixture.
 *
 * A blob whose raw inflated content exceeds ~256MiB cannot round-trip through the
 * porsager driver's TEXT wire form for `bytea` (`'\x' + hex`, DOUBLE the byte
 * length): the string exceeds V8's hard cap. Both directions must therefore move
 * the bytes AS bytes — ingest writes raw (binary COPY), and serve reads the value
 * back in chunks rather than as one decoded string. Postgres itself takes `bytea`
 * to ~1GB and canonical git stores blobs this size happily, so anything smaller
 * than this is pggit refusing what git accepts.
 *
 * THE CONTRACT: a push carrying such a blob reports `unpack ok` and lands its ref,
 * and a subsequent v2 fetch of that blob answers HTTP 200 with a pack of exactly
 * ONE object whose oid is the blob's — the bytes that went in came back.
 *
 * The ref is a TAG: tags legally hold ANY object type (canonical git accepts a
 * blob-tipped tag, probed live), which isolates the string-cap subject from the
 * branch-tips-must-be-commits policy without faking a commit wrapper.
 *
 * ORIGINATED as two breakage probes over the same shape — a07 (INGEST: the push
 * came back with an unpacker error and no ref) and blb01 (SERVE: the blob stored
 * but every fetch died with `RPC failed; HTTP 500`, i.e. write-only storage). Both
 * fixed; merged into one describe because two byte-identical 270MB fixtures were
 * paying twice for one shape.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { computeOid } from "@/object/object"
import { readPack } from "@/pack/read-pack"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { packObjectCount, pktLineUnpack, sidebandDemux } from "@/testing/pkt-oracle"
import { fetchRequest } from "@/testing/wire-fetch"

const ZERO = "0".repeat(40)
const TAG = "huge"
/** 270_000_000 bytes > 0x1fffffe8 / 2 ≈ 268_435_443, so this value's hex text form
 * — in EITHER direction — exceeds V8's max string length. */
const SIZE = 270_000_000

describe("large blob past the V8 string cap — pushed, then fetched back", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let objects: ObjectStore
	let refs: RefStore
	let blobOid = ""
	let report = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		app = createGitApp({ objects, refs })

		// Deterministic fill, no randomness: the size is what matters, and the same
		// bytes must be reproducible for the served-oid comparison below.
		const content = Buffer.alloc(SIZE)
		for (let i = 0; i < SIZE; i += 4096) content.writeUInt32LE((i * 2654435761) >>> 0, i)
		blobOid = computeOid("blob", content)

		const body = Buffer.concat([
			encodePktLine(Buffer.from(`${ZERO} ${blobOid} refs/tags/${TAG}\0report-status`)),
			encodePkt({ type: "flush" }),
			writePack([{ content, type: "blob" }]),
		])
		const res = await app.request("/r/git-receive-pack", {
			body: new Uint8Array(body),
			method: "POST",
		})
		expect(res.status).toBe(200)
		report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
	}, 300_000)

	afterAll(async () => {
		await db?.drop()
	})

	it("ingests a ~257MB blob and lands the ref", async () => {
		expect(report).toContain("unpack ok")
		expect(report).toContain(`ok refs/tags/${TAG}`)
		const stored = (await refs.listRefs("r")).find((r) => r.name === `refs/tags/${TAG}`)
		expect(stored?.oid).toBe(blobOid)
		expect(await objects.hasObject("r", blobOid)).toBe(true)
	})

	it("serves it back — one object in the pack, and it is the blob that went in", async () => {
		const res = await app.request("/r/git-upload-pack", {
			body: new Uint8Array(
				fetchRequest({ done: true, objectFormat: "sha1", wants: [blobOid] }),
			),
			method: "POST",
		})
		expect(res.status).toBe(200)
		const body = Buffer.from(await res.arrayBuffer())
		// A `PACK` substring proves nothing — every upload-pack response carries that
		// header, an EMPTY pack included. The count and the parsed object are the
		// observables that tell "blob served" from "200 with nothing in it".
		expect(packObjectCount(body)).toBe(1)
		const served = await readPack(sidebandDemux(body).band1)
		// readPack hashes what it parsed, so a matching oid IS byte identity.
		expect(served.map((o) => `${o.type} ${o.oid}`)).toEqual([`blob ${blobOid}`])
	}, 180_000)
})

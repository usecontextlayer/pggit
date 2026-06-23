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

describe("a07 — large-blob push over V8 string cap", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let objects: ObjectStore
	let refs: RefStore

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

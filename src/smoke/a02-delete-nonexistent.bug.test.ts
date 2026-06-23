/**
 * force-nonff dimension — deleting a NONEXISTENT ref must be a clean per-ref
 * report, NOT an HTTP 500.
 *
 * When `git push <remote> :refs/heads/doesnotexist` targets a ref the server does
 * not advertise, git sends the command `0{40} 0{40} refs/heads/doesnotexist`
 * (old=zero because the client knows of no current value, new=zero for delete).
 * Canonical git-receive-pack accepts this as a no-op delete: `unpack ok` then a
 * per-ref `ok refs/heads/doesnotexist`, process exits 0 (it merely warns
 * "deleting a non-existent ref"). The LIVE pggit server instead returns HTTP 500
 * "internal server error" — the client sees "the remote end hung up unexpectedly".
 *
 * Root cause (observed, not asserted): the zero-old/zero-delete command is
 * classified as "create whose target is the zero OID" and THROWS, propagating as
 * a 500 instead of being reported per-ref.
 *
 * This test drives the wire directly (the client never refuses a delete, so this
 * is reproducible end-to-end too, but the in-process request isolates the server
 * contract): a delete command for an absent ref must yield a 200 report-status
 * with `unpack ok` and a per-ref line (canonical git: `ok ...`). It must NOT 500.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore, type ObjectStore } from "@/object-store"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore, type RefStore } from "@/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"

const ZERO = "0".repeat(40)

describe("a02 force-nonff — delete of a nonexistent ref is reported, not a 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let objects: ObjectStore
	let refs: RefStore

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		app = createGitApp({ objects, refs })
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
	})

	it("returns a 200 report-status (not HTTP 500) for `push :refs/heads/doesnotexist`", async () => {
		// `0{40} 0{40} refs/heads/doesnotexist` — delete an absent ref, empty pack.
		const body = Buffer.concat([
			encodePktLine(
				Buffer.from(`${ZERO} ${ZERO} refs/heads/doesnotexist\0report-status`),
			),
			encodePkt({ type: "flush" }),
			writePack([]),
		])

		const res = await app.request("/repo/git-receive-pack", {
			body: new Uint8Array(body),
			method: "POST",
		})

		// Canonical git-receive-pack: this is a clean per-ref outcome, HTTP 200.
		expect(res.status).toBe(200)
		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(report).toContain("unpack ok")
		// Deleting an absent ref is a no-op success in canonical git (it warns but
		// reports `ok`). The ref must not exist afterward, and nothing must crash.
		expect(report).toContain("ok refs/heads/doesnotexist")
		expect(
			(await refs.listRefs("repo")).find((r) => r.name === "refs/heads/doesnotexist"),
		).toBeUndefined()
	})
})

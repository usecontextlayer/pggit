/**
 * Push-delete of a NONEXISTENT ref must be reported per-ref, NOT an HTTP 500.
 *
 * Merged from a01-delete-nonexistent-ref.bug + a02-delete-nonexistent.bug.
 *
 * When the client doesn't know a current value for the ref it is deleting it
 * sends `<zero> <zero> <ref>` (old=zero, new=zero). Canonical git-receive-pack
 * treats this as a no-op delete: it warns "deleting a non-existent ref", emits
 * `unpack ok` then a non-error per-ref status (`ok ...`), and `git push` exits
 * 0. pggit instead 500s ("the remote end hung up unexpectedly"). These tests
 * drive the receive-pack wire directly with the exact `<zero> <zero> ref`
 * delete command and assert the canonical 200 report-status outcome.
 *
 * The two describes preserve each original bug's distinct repro: a01 sends a
 * pack-less delete body (a delete carries no objects), a02 appends an empty
 * pack and additionally asserts the ref does not exist afterward.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"

const ZERO = "0".repeat(40)

/**
 * a01 (empty-degenerate) — deleting a NONEXISTENT ref must not crash the server.
 *
 * A delete command is `<old> <zero> <ref>`; when the client doesn't have the ref
 * either, git sends `<zero> <zero> <ref>` (both old and new are the zero-oid).
 * Canonical receive-pack treats this as a no-op delete: it emits
 * `warning: deleting a non-existent ref` and reports success (`git push` exits 0,
 * the per-ref status is `[deleted]`).
 *
 * CONTROL (run on disk during exploration): pushing `:refs/heads/ghost` to a
 * fresh `git init --bare` prints
 *     remote: warning: deleting a non-existent ref
 *      - [deleted]         ghost
 * and exits 0.
 *
 * pggit instead returns HTTP 500 and the client sees
 *     error: RPC failed; HTTP 500
 *     send-pack: unexpected disconnect while reading sideband packet
 *     fatal: the remote end hung up unexpectedly
 *
 * This test drives the receive-pack wire with the exact `<zero> <zero> ref`
 * delete command (no pack — a delete carries no objects) and asserts the
 * canonical outcome: HTTP 200 with a valid report-status (`unpack ok` and a
 * non-`ng` status for the ref). It is RED now (the handler 500s) and GREEN once
 * a no-op delete of a missing ref is handled gracefully.
 */
describe("a01 — receive-pack tolerates deleting a nonexistent ref", () => {
	let isolated: IsolatedDb
	let app: ReturnType<typeof createGitApp>

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		isolated = await createIsolatedSchema(baseUrl)
		app = createGitApp({
			objects: createObjectStore(isolated.sql),
			refs: createRefStore(isolated.sql),
		})
	}, 180_000)

	afterAll(async () => {
		await isolated?.drop()
	})

	it("does not 500 on a `<zero> <zero> ref` no-op delete of a missing ref", async () => {
		// A pack-less receive-pack body: one delete command + flush. No objects
		// follow a delete-only push, so there is no pack trailer.
		const body = Buffer.concat([
			encodePktLine(Buffer.from(`${ZERO} ${ZERO} refs/heads/ghost\0report-status`)),
			encodePkt({ type: "flush" }),
		])

		const res = await app.request("/repo/git-receive-pack", {
			body: new Uint8Array(body),
			method: "POST",
		})

		expect(res.status).toBe(200)
		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		// Canonical git unpacks (zero objects) and the no-op delete is NOT an error.
		expect(report).toContain("unpack ok")
		expect(report).not.toContain("ng refs/heads/ghost")
	})
})

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

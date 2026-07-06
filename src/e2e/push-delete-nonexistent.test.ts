/**
 * Push-delete of a NONEXISTENT ref must be reported per-ref, NOT an HTTP 500.
 *
 * Merged from a01-delete-nonexistent-ref.bug + a02-delete-nonexistent.bug.
 *
 * When the client doesn't know a current value for the ref it is deleting it
 * sends `<zero> <zero> <ref>` (old=zero, new=zero). The original bug: pggit
 * threw on that command and the client saw HTTP 500 ("the remote end hung up
 * unexpectedly"). The pin both tests exist for is the TRANSPORT contract:
 * HTTP 200 with a clean per-ref report-status, never a thrown 500. WHAT the
 * per-ref line says moved under deny-non-FF (2026-07-05): canonical git
 * no-ops an absent-ref delete with a non-error status, but pggit refuses
 * every wire delete as policy, so the line is now
 * `ng ... deletion denied (refs only advance)`.
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
 * (Canonical receive-pack, for reference, no-ops this — `warning: deleting a
 * non-existent ref`, success. pggit's deny-non-FF policy deliberately diverges
 * and refuses every wire delete.)
 *
 * The BUG this file pins: pggit used to THROW on the command and the client saw
 *     error: RPC failed; HTTP 500
 *     send-pack: unexpected disconnect while reading sideband packet
 *     fatal: the remote end hung up unexpectedly
 *
 * This test drives the receive-pack wire with the exact `<zero> <zero> ref`
 * delete command (no pack — a delete carries no objects) and asserts the
 * transport contract: HTTP 200 with a valid report-status carrying a per-ref
 * line — `ng ... deletion denied` under the policy. It must NOT 500.
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
		// The unpack (zero objects) is fine, and since deny-non-FF (2026-07-05) the
		// delete — even a no-op delete of an absent ref — is refused as policy with
		// a per-ref `ng`. The pin this test exists for is unchanged: a clean
		// per-ref REPORT over HTTP 200, never a thrown 500.
		expect(report).toContain("unpack ok")
		expect(report).toContain("ng refs/heads/ghost deletion denied")
	})
})

/**
 * a02 (empty-pack variant) — deleting a NONEXISTENT ref must be a clean per-ref
 * report, NOT an HTTP 500.
 *
 * When `git push <remote> :refs/heads/doesnotexist` targets a ref the server does
 * not advertise, git sends the command `0{40} 0{40} refs/heads/doesnotexist`
 * (old=zero because the client knows of no current value, new=zero for delete).
 * The LIVE pggit server used to return HTTP 500 "internal server error" — the
 * client saw "the remote end hung up unexpectedly".
 *
 * Root cause (observed, not asserted): the zero-old/zero-delete command was
 * classified as "create whose target is the zero OID" and THREW, propagating as
 * a 500 instead of being reported per-ref.
 *
 * This test drives the wire directly (the client never refuses a delete, so this
 * is reproducible end-to-end too, but the in-process request isolates the server
 * contract): a delete command for an absent ref must yield a 200 report-status
 * with `unpack ok` and a per-ref line — `ng ... deletion denied` since the
 * deny-non-FF policy refuses every wire delete (canonical git, for reference,
 * would no-op it with `ok`). It must NOT 500.
 */
describe("a02 — delete of a nonexistent ref is reported (ng, deny-non-FF), not a 500", () => {
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

		// The no-500 pin this test exists for is unchanged: a clean report, HTTP 200.
		expect(res.status).toBe(200)
		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(report).toContain("unpack ok")
		// Since deny-non-FF (2026-07-05) ALL deletions are refused as policy — the
		// absent-ref delete now reports a per-ref `ng` with the policy reason
		// (canonical git would no-op `ok`; the policy deliberately diverges). The
		// contract this pins: a per-ref REPORT, never a thrown 500.
		expect(report).toContain("ng refs/heads/doesnotexist deletion denied")
		expect(
			(await refs.listRefs("repo")).find((r) => r.name === "refs/heads/doesnotexist"),
		).toBeUndefined()
	})
})

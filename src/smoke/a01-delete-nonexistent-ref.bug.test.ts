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
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore } from "@/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"

const ZERO = "0".repeat(40)

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

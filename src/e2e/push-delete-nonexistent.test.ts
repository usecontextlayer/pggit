/**
 * Push-delete of a NONEXISTENT ref is reported per-ref, never an HTTP 500.
 *
 * Merged from a01-delete-nonexistent-ref.bug + a02-delete-nonexistent.bug — two
 * fixtures driving the identical `<zero> <zero> <ref>` command with the identical
 * expectations; the only distinct idea between them is the body shape (a delete
 * carries no objects, but a client may still append an empty pack), so both shapes
 * survive here as two `it`s over one schema.
 *
 * THE WIRE SHAPE: when the client knows no current value for the ref it is
 * deleting — `git push <remote> :refs/heads/doesnotexist` — it sends old=zero and
 * new=zero. The contract is the TRANSPORT one: HTTP 200 with a clean per-ref
 * report-status. WHAT the per-ref line says moved under deny-non-FF (2026-07-05):
 * canonical git no-ops an absent-ref delete with a success status, while pggit
 * refuses every wire delete as policy, so the line is
 * `ng <ref> deletion denied (refs only advance)` — a deliberate divergence in the
 * reason, not in the shape.
 *
 * ORIGINATED as the breakage probe for that command being classified as "a create
 * whose target is the zero OID", which THREW: the client saw `RPC failed; HTTP 500`
 * / `send-pack: unexpected disconnect` / `the remote end hung up unexpectedly`
 * instead of a per-ref answer. Fixed.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"

const ZERO = "0".repeat(40)

describe("delete of a nonexistent ref is reported per-ref, not a 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let refs: RefStore

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		refs = createRefStore(db.sql)
		app = createGitApp({ objects: createObjectStore(db.sql), refs })
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
	})

	/** POST one delete command for `ref`, with or without a trailing empty pack. */
	async function postDelete(
		ref: string,
		withEmptyPack: boolean,
	): Promise<{ report: string; status: number }> {
		const body = Buffer.concat([
			encodePktLine(Buffer.from(`${ZERO} ${ZERO} ${ref}\0report-status`)),
			encodePkt({ type: "flush" }),
			...(withEmptyPack ? [writePack([])] : []),
		])
		const res = await app.request("/repo/git-receive-pack", {
			body: new Uint8Array(body),
			method: "POST",
		})
		return {
			report: pktLineUnpack(Buffer.from(await res.arrayBuffer())),
			status: res.status,
		}
	}

	it("answers a pack-less `<zero> <zero> ref` body with a per-ref ng", async () => {
		// No objects follow a delete-only push, so there is no pack trailer at all.
		const { report, status } = await postDelete("refs/heads/ghost", false)
		expect(status).toBe(200)
		expect(report).toContain("unpack ok")
		expect(report).toContain("ng refs/heads/ghost deletion denied")
	})

	it("answers the same body with a trailing EMPTY pack identically, and writes no ref", async () => {
		const { report, status } = await postDelete("refs/heads/doesnotexist", true)
		expect(status).toBe(200)
		expect(report).toContain("unpack ok")
		expect(report).toContain("ng refs/heads/doesnotexist deletion denied")
		expect(
			(await refs.listRefs("repo")).find((r) => r.name === "refs/heads/doesnotexist"),
		).toBeUndefined()
	})
})

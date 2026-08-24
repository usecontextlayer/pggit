/**
 * Push-delete of a NONEXISTENT ref is reported per-ref, never an HTTP 500.
 *
 * The two body shapes differ only in whether an empty pack follows the delete
 * command, so both are exercised over one schema.
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
 * The command must be classified as a delete and answered per-ref.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { writePack } from "@/pack/write-pack"
import { createObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack, ZERO_OID } from "@/testing/pkt-oracle"
import { postReceivePack, receivePackRequest } from "@/testing/wire-receive"

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
		const body = receivePackRequest(
			[`${ZERO_OID} ${ZERO_OID} ${ref}\0report-status`],
			withEmptyPack ? writePack([]) : undefined,
		)
		const res = await postReceivePack(app, "repo", body)
		return {
			report: pktLineUnpack(res.body),
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

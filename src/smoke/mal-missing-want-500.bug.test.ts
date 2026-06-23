/**
 * mal — a v2 `fetch` whose `want` names an object the repo does NOT have (a
 * nonexistent OID, or a garbage/non-hex OID that coerces to an empty buffer) is an
 * adversarial WIRE input: it MUST surface as a clean error the client can read —
 * real git's upload-pack answers in-band with `ERR upload-pack: not our ref <oid>`
 * (the client prints `fatal: remote error: ...`) — NEVER an unhandled HTTP 500.
 *
 * Observed against the live wire (`git fetch <pggit-url> <nonexistent-oid>` and raw
 * curl): pggit returns HTTP 500 "internal server error". The mechanism:
 * `object-store.buildPack` throws a bare `Error("upload-pack: wanted objects
 * missing from store: …")` (object-store.ts:101), which is not a `GitProtocolError`,
 * so `createGitApp`'s onError maps it to 500. `Buffer.from("zzzz","hex")` silently
 * yields an empty OID, so a garbage want hits the same path with an empty oid in the
 * message.
 *
 * This asserts the HTTP status the client sees — not any internal detail. Both the
 * well-formed-but-absent want and the garbage want must be < 500.
 */
import { describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore } from "@/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

function fetchBody(want: string): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from("command=fetch\n")),
		encodePktLine(Buffer.from("object-format=sha1\n")),
		encodePkt({ type: "delim" }),
		encodePktLine(Buffer.from(`want ${want}\n`)),
		encodePktLine(Buffer.from("done\n")),
		encodePkt({ type: "flush" }),
	])
}

describe("mal — fetch of a want absent from the store must not 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>

	async function postFetch(repo: string, want: string): Promise<number> {
		const res = await app.request(`/${repo}/git-upload-pack`, {
			body: fetchBody(want),
			headers: { "Git-Protocol": "version=2" },
			method: "POST",
		})
		return res.status
	}

	it("returns a client-readable error (< 500), never an unhandled 500", async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			const objects = createObjectStore(db.sql)
			app = createGitApp({ objects, refs: createRefStore(db.sql) })

			// The repo must EXIST for the bug to bite: buildPack short-circuits to an
			// empty pack when the repo id is null, so seed one real object first. Now a
			// `want` for a DIFFERENT, absent object exercises the missing-want throw.
			await objects.putPack("malmw", [{ content: Buffer.from("hi\n"), type: "blob" }])

			// Well-formed 40-hex OID the (now non-empty) repo does not have.
			expect(await postFetch("malmw", "c".repeat(40))).toBeLessThan(500)
			// Garbage non-hex OID — coerces to an empty buffer, same buildPack throw.
			expect(await postFetch("malmw", "zzzz")).toBeLessThan(500)
		} finally {
			await db?.drop()
		}
	})
})

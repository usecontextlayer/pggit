/**
 * neg02 incremental-negotiation — `buildPack` over-serves an explicit `want` that
 * the client already owns through its `have`-closure, producing a NON-MINIMAL pack
 * where the oracle ships nothing.
 *
 * THE BUG (EXPECTED-RED until pggit is fixed):
 *   `object-store.ts` buildPack (lines 109-111) computes the served set as:
 *       for (const o of want.present) if (!have.present.has(o)) set.add(o)   // subtract
 *       for (const w of wants)        if (want.present.has(w)) set.add(w)     // re-add EVERY want
 *   The first loop correctly subtracts the have-closure. The second loop then
 *   unconditionally re-adds every explicit want. That re-add is justified ONLY for
 *   partial-clone promisor roots (a wanted blob reachable from a tree the client
 *   already has, which omitBlobs subtracted) — but on a normal, non-filtered fetch
 *   it re-inserts a want the subtraction already (correctly) dropped.
 *
 *   Concretely: linear history c1..c6, a fetch with `want c3` (old) and `have c6`
 *   (new tip; c3 is an ANCESTOR of c6, so the client already has c3 and its whole
 *   closure). The subtraction empties the set, then loop 2 re-adds the c3 commit —
 *   and ONLY the commit; its tree/blob stay subtracted. The result is a 1-object
 *   pack carrying a commit whose tree the pack omits — a thin/incomplete standalone
 *   pack (`git index-pack --strict` on it in isolation fails connectivity). The
 *   real-git fetch still completes (git tolerates a duplicate it already owns), so
 *   no corruption — but it diverges from the oracle's minimal pack.
 *
 * THE ORACLE (real `git upload-pack --stateless-rpc`, same bytes — verified):
 *   c3 is fully contained in the have-closure, so there is NOTHING to send: a
 *   ZERO-object pack. pggit must match.
 *
 * WHY A RAW-WIRE REQUEST: a real git HTTP client never issues `want c3 / have c6`
 * when c3 is an ancestor of its local c6 — it short-circuits because it already has
 * the ref target. So the divergence is only reachable by putting the exact
 * negotiation bytes on the wire ourselves; this test POSTs them to the real server
 * and reads the served pack's object count from the response.
 *
 * RED on current code (served pack count == 1); GREEN once buildPack stops
 * re-adding a want that the have-closure already contains (the count drops to 0).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore } from "@/refs-store"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** A v2 fetch with `done`: `want <oid>`, `have <oid>`, no filter. */
function fetchBody(want: string, have: string): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from("command=fetch\n")),
		encodePktLine(Buffer.from("object-format=sha1\n")),
		encodePkt({ type: "delim" }),
		encodePktLine(Buffer.from(`want ${want}\n`)),
		encodePktLine(Buffer.from(`have ${have}\n`)),
		encodePktLine(Buffer.from("done\n")),
		encodePkt({ type: "flush" }),
	])
}

/** Count packed objects from a smart-HTTP fetch response, or null if no PACK is
 * present. The pack header is `PACK` + 4-byte version + 4-byte big-endian object
 * count; `PACK` appears literally inside the sideband band-1 payload, so a raw
 * search locates it without de-muxing. */
function packObjectCount(body: Buffer): number | null {
	const i = body.indexOf(Buffer.from("PACK", "ascii"))
	if (i < 0 || i + 12 > body.length) return null
	return body.readUInt32BE(i + 8)
}

describe("neg02 — buildPack must not re-add a want already in the have-closure (minimal pack)", () => {
	let db: IsolatedDb
	let server: GitServer
	let app: ReturnType<typeof createGitApp>
	let url: string
	let src: string
	let c3 = ""
	let c6 = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		// Wire the snapshot layer exactly as the live server does (server.ts).
		const snapshots = createSnapshotStore(db.sql)
		app = createGitApp({ objects, refs, snapshots })
		server = await serveOnPort(app, 0)
		url = `http://127.0.0.1:${server.port}/neg02`

		// Linear history c1 ← c2 ← … ← c6, pushed over the real wire. c3 is an
		// ancestor of c6, so the c3 closure is fully contained in the c6 closure.
		src = mkdtempSync(join(tmpdir(), "pggit-neg02-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		for (const v of ["1", "2", "3", "4", "5", "6"]) {
			writeFileSync(join(src, "a.txt"), `${v}\n`)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", `c${v}`], { cwd: src })
		}
		c6 = (await spawnGit(["rev-parse", "main"], { cwd: src })).stdout.trim()
		c3 = (await spawnGit(["rev-parse", "main~3"], { cwd: src })).stdout.trim()
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("want fully contained in the have-closure serves a ZERO-object pack (oracle), not 1", async () => {
		const res = await app.request("/neg02/git-upload-pack", {
			body: fetchBody(c3, c6),
			headers: { "Git-Protocol": "version=2" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		const body = Buffer.from(await res.arrayBuffer())
		const objCount = packObjectCount(body)

		// ORACLE: real `git upload-pack` ships a 0-object pack here — c3 is wholly
		// inside the c6 have-closure, so there is nothing to send. pggit currently
		// re-adds the lone c3 commit (object-store.ts:111), serving a 1-object,
		// connectivity-incomplete pack. This assertion is RED on current code and
		// GREEN once buildPack stops re-adding a want the have-closure already has.
		expect(objCount).toBe(0)
	}, 60_000)
})

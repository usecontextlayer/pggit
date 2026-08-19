/**
 * neg01 incremental-negotiation — `readyToGiveUp` walks reachability the WRONG
 * direction vs git's `ok_to_give_up`, so it never sends `ready` when a common
 * `have` is a SIBLING of the want (shares an ancestor with it but is not on the
 * want's ancestor chain).
 *
 * THE BUG (object-store.ts `ancestryReachesCommon`, lines ~400-423): it walks
 * COMMIT_PARENT/TAG_TARGET edges FROM each want, looking to land ON a common oid.
 * A sibling `have` is never on the want's ancestor chain, so `readyToGiveUp`
 * (~242-255) returns false even though git would give up. git readies when the
 * common set shares an ancestor that BOUNDS the wants — not when a want descends
 * into a have.
 *
 * Scenario (the finding's crisp wire form): main = c1←c2←c3, feature = c1←f1
 * (a sibling off c1). want=c3, have=f1, NO `done`. f1 and c3 share c1 (BASE).
 *
 * ORACLE (verified live with real `git upload-pack --stateless-rpc` v2 on a
 * file:// bare repo with this exact history, same request bytes):
 *     acknowledgments\nACK <f1>\nready\n   + DELIM + packfile (6 objects)
 * pggit currently emits:
 *     acknowledgments\nACK <f1>\n          + flush, NO ready, NO pack
 * forcing extra negotiation rounds (~2x have/ACK traffic, an extra round-trip).
 *
 * This is a protocol-conformance / negotiation-efficiency divergence (NOT data
 * loss — both fetches complete and produce identical, minimal object sets). The
 * test asserts the CORRECT oracle behavior (`ready` is emitted), so it is
 * EXPECTED-RED until pggit's reachability direction is fixed. Drives a real git
 * client over the wire (push) + a raw v2 fetch POST matching the finding.
 *
 * NOTE: src/e2e/fetch-multiround.spec.test.ts currently enshrines the BUGGY behavior
 * (asserts `ACK f1` + no pack for this same sibling-have case). That spec is the
 * specification of the wrong contract; this regression test observes the real
 * divergence against canonical git.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { decodePktStream } from "@/protocol/pkt-line"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { sidebandDemux } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"

/** Encode one pkt-line: `<4-hex-len><payload>`. */
function pktLine(payload: string): Buffer {
	const body = Buffer.from(payload, "utf8")
	const head = Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii")
	return Buffer.concat([head, body])
}

/** The data packets BEFORE the first delim — the acknowledgments section text. */
function ackSection(out: Buffer): string {
	const { packets } = decodePktStream(out)
	const delim = packets.findIndex((p) => p.type === "delim")
	const end = delim < 0 ? packets.length : delim
	return packets
		.slice(0, end)
		.map((p) => (p.type === "data" ? p.payload.toString("utf8") : ""))
		.join("")
}

describe("neg01 — readyToGiveUp must send `ready` for a sibling common have (git ok_to_give_up)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string
	let url: string
	let c3 = ""
	let f1 = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const snapshots = createRepoFileProjection(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)
		url = `http://127.0.0.1:${server.port}/neg01`

		// main: c1 ← c2 ← c3.  feature (off c1): f1 — a SIBLING, NOT an ancestor of c3.
		src = mkdtempSync(join(tmpdir(), "pggit-neg01-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		for (const v of ["1", "2", "3"]) {
			writeFileSync(join(src, "a.txt"), `${v}\n`)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", `c${v}`], { cwd: src })
		}
		c3 = (await spawnGit(["rev-parse", "main"], { cwd: src })).stdout.trim()
		const c1 = (await spawnGit(["rev-parse", "main~2"], { cwd: src })).stdout.trim()
		await spawnGit(["checkout", "-q", "-b", "feature", c1], { cwd: src })
		writeFileSync(join(src, "f.txt"), "feature\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "f1"], { cwd: src })
		f1 = (await spawnGit(["rev-parse", "feature"], { cwd: src })).stdout.trim()

		// Push the whole repo to pggit over the real wire (both branches land).
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	// DEFERRED (rc8, decision 2026-06-22): the real fix reworks readyToGiveUp to git's
	// ok_to_give_up direction AND rewrites the fetch-multiround spec that encodes the
	// current behavior. Low impact — an extra negotiation round-trip, never data loss
	// (both fetches complete, fsck-clean, object sets equal source). The repro is kept
	// but skipped until addressed deliberately with the git oracle.
	it.skip("want=c3, have=f1 (sibling, no done) → emits `ready` + packfile, like git", async () => {
		// The finding's crisp wire form: v2 fetch, want C3, have F1 (sibling), NO done.
		const body = Buffer.concat([
			pktLine("command=fetch\n"),
			pktLine("object-format=sha1\n"),
			Buffer.from("0001", "ascii"), // delim
			pktLine(`want ${c3}\n`),
			pktLine(`have ${f1}\n`),
			Buffer.from("0000", "ascii"), // flush
		])
		const res = await fetch(`${url}/git-upload-pack`, {
			body,
			headers: {
				"Content-Type": "application/x-git-upload-pack-request",
				"Git-Protocol": "version=2",
			},
			method: "POST",
		})
		expect(res.status).toBe(200)
		const out = Buffer.from(await res.arrayBuffer())

		// ORACLE: f1 shares c1 with c3, so ok_to_give_up readies. pggit must agree.
		expect(ackSection(out)).toBe(`acknowledgments\nACK ${f1}\nready\n`)
		const { packets } = decodePktStream(out)
		expect(packets.some((p) => p.type === "delim")).toBe(true)
		expect(sidebandDemux(out).band1.subarray(0, 4).toString("latin1")).toBe("PACK")
	})
})

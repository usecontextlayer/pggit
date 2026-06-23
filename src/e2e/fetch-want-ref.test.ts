/**
 * mal04 ref-in-want — a v2 `fetch` carrying a `want-ref <ref>` line (the
 * `ref-in-want` capability) is served as a SILENT EMPTY clone instead of failing
 * loudly.
 *
 * THE BUG: `parseFetch` (src/protocol/v2.ts) recognizes only `want <oid>`,
 * `have <oid>`, `filter <spec>`, `include-tag`, and `done`. A `want-ref refs/…`
 * arg starts with `want-ref ` — which does NOT match `arg.startsWith("want ")`
 * (the char after `want` is `-`, not a space) — so the line is SILENTLY DROPPED.
 * With `wants = []`, `handleFetch` falls through to its "zero-want = no-op"
 * branch and `buildPack` emits an EMPTY packfile, yielding HTTP 200 + a 4-object-
 * free `PACK` body.
 *
 * THE ORACLE EXPECTATION: pggit deliberately does NOT advertise `ref-in-want`
 * (see encodeAdvertisement in v2.ts: "No shallow / ref-in-want"). Per the charter,
 * an unimplemented capability that a client nonetheless drives must FAIL LOUDLY —
 * never silently hand back an empty clone. A request whose ONLY want is a
 * `want-ref` must surface a client-readable error (a `GitProtocolError` → 4xx, or
 * an in-band `ERR …`), exactly as the unsupported-command / unsupported-object-
 * format paths already do. It must NOT be an HTTP 200 carrying an empty pack.
 *
 * Observed against the live wire: HTTP 200, body `000dpackfile … 0025PACK…0000`
 * (an empty pack — zero objects). This raw-wire request is the only way to reach
 * the path (real git emits `want-ref` only when the server advertised
 * `ref-in-want`, which pggit does not), so this is a raw/adversarial-client
 * divergence, but a silent-empty one all the same.
 *
 * EXPECTED-RED until pggit either (a) rejects an unrecognized `want-*` arg loudly
 * in parseFetch / handleFetch, or (b) implements ref-in-want. The test drives a
 * real git push to seed a non-empty repo, then puts the raw `want-ref` fetch body
 * on the wire and asserts the response is NOT a silent empty-pack 200.
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

/** A v2 fetch whose only ref-selection arg is `want-ref <ref>` (ref-in-want). */
function wantRefFetchBody(ref: string): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from("command=fetch\n")),
		encodePktLine(Buffer.from("object-format=sha1\n")),
		encodePkt({ type: "delim" }),
		encodePktLine(Buffer.from(`want-ref ${ref}\n`)),
		encodePktLine(Buffer.from("done\n")),
		encodePkt({ type: "flush" }),
	])
}

/** Count packed objects from a smart-HTTP fetch response body, or null if the
 * body is not a recognizable `packfile`/PACK response. The PACK header is
 * `PACK` + 4-byte version + 4-byte big-endian object count. */
function packObjectCount(body: Buffer): number | null {
	const i = body.indexOf(Buffer.from("PACK", "ascii"))
	if (i < 0 || i + 12 > body.length) return null
	return body.readUInt32BE(i + 8)
}

describe("mal04 — ref-in-want (want-ref, unadvertised) must fail loudly, not clone empty", () => {
	let db: IsolatedDb
	let server: GitServer
	let app: ReturnType<typeof createGitApp>
	let url: string
	let src: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		// Wire the snapshot layer exactly as the live server does (server.ts).
		const snapshots = createSnapshotStore(db.sql)
		app = createGitApp({ objects, refs, snapshots })
		server = await serveOnPort(app, 0)
		url = `http://127.0.0.1:${server.port}/mal04`

		// Seed a non-empty repo over the real wire so the bug bites: if the repo were
		// empty, buildPack would short-circuit to an empty pack regardless and the
		// test would not distinguish the dropped want-ref from a genuinely empty repo.
		src = mkdtempSync(join(tmpdir(), "pggit-mal04-src-"))
		await spawnGit(["init", "--quiet", src])
		writeFileSync(join(src, "a.txt"), "alpha\n")
		await spawnGit(["add", "-A"], { cwd: src })
		await spawnGit(["commit", "--quiet", "-m", "c1"], { cwd: src })
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("does not silently return an empty-pack HTTP 200 for a want-ref request", async () => {
		// Sanity: the repo is non-empty — a normal want of the tip yields objects.
		const ls = await spawnGit(["ls-remote", url])
		const tip = ls.stdout.match(/^([0-9a-f]{40})\s+refs\/heads\/(?:main|master)/m)?.[1]
		expect(tip, "seeded repo must advertise a branch tip").toBeTruthy()

		const res = await app.request("/mal04/git-upload-pack", {
			body: wantRefFetchBody("refs/heads/main"),
			headers: { "Git-Protocol": "version=2" },
			method: "POST",
		})
		const body = Buffer.from(await res.arrayBuffer())
		const objCount = packObjectCount(body)

		// ORACLE: an unadvertised ref-in-want request must NOT succeed as a clone with
		// an empty pack. Either it fails loudly (status >= 400, no pack) OR — if some
		// day implemented — it serves the requested ref's closure (objCount > 0). The
		// silent-empty divergence is exactly status 200 + a zero-object pack.
		const silentEmptyClone = res.status === 200 && objCount === 0
		expect(
			silentEmptyClone,
			"want-ref must not be silently dropped to an empty pack",
		).toBe(false)
	}, 60_000)
})

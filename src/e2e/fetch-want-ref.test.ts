/**
 * mal04 ref-in-want — a v2 `fetch` whose only want is a `want-ref <ref>` line fails
 * LOUDLY; it is never served as a silent empty clone.
 *
 * pggit deliberately does not advertise `ref-in-want` (see the v2 advertisement:
 * "No shallow / ref-in-want"). Per the charter, an unimplemented capability a client
 * nonetheless drives must surface a client-readable error — a `GitProtocolError`
 * (4xx) or an in-band `ERR …`, the way the unsupported-command and
 * unsupported-object-format paths already answer — and never HTTP 200 carrying an
 * empty pack.
 *
 * The request is raw wire on purpose: real git emits `want-ref` only when the server
 * advertised `ref-in-want`, so an adversarial or hand-built client is the only way
 * to reach the path.
 *
 * ORIGINATED as the breakage probe for `parseFetch` matching only `want <oid>`: a
 * `want-ref refs/…` line does not start with `want ` (the next char is `-`), so it
 * was SILENTLY DROPPED, `wants` came out empty, and the zero-want branch answered
 * HTTP 200 with an empty pack — a clone that succeeded and delivered nothing. Fixed
 * by rejecting the unadvertised argument at the parse boundary.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { packObjectCount } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

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
		const snapshots = createRepoFileProjection(db.sql)
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
			body: fetchRequest({
				done: true,
				objectFormat: "sha1",
				wantRefs: ["refs/heads/main"],
			}),
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

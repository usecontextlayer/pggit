/**
 * nam02 ref-naming / non-atomic state divergence — a SINGLE non-atomic push that
 * carries one valid ref (`refs/heads/ok`) and one ref whose name is so long it
 * cannot be stored leaves the server and the client disagreeing about what landed.
 *
 * ROOT CAUSE (same family as nam-01 / a11 / a13): `git_ref`'s primary key is a
 * btree on `(repo_id, name)`, and a btree index entry cannot exceed ~2704 bytes.
 * An *incompressible* ref name of ~2800 bytes (real git imposes no such limit —
 * `git push` happily sends it) makes the INSERT in `casRefUpdate` throw a raw
 * Postgres error: `index row size NNNN exceeds btree version 4 maximum 2704 for
 * index "git_ref_pkey"`. In the NON-atomic apply loop (`applyRefUpdates`, the
 * default push mode) each command runs as its own statement with NO surrounding
 * transaction or try/catch: `refs/heads/ok` is applied and COMMITTED, then the
 * over-long ref's INSERT throws, the error escapes `applyRefUpdates` →
 * `handleReceivePack`, and the app's `onError` turns it into HTTP 500.
 *
 * OBSERVED DIVERGENCE (reproduced live against http://127.0.0.1:8080):
 *   - The client gets `error: RPC failed; HTTP 500` and NO report-status pkt-line,
 *     so git reports `Everything up-to-date` / `the remote end hung up` and treats
 *     the WHOLE push as failed — the client believes nothing was pushed.
 *   - But the server DB already holds `git_ref` = {HEAD, refs/heads/ok}, and a
 *     fresh clone checks out `refs/heads/ok`: the good branch was DURABLY applied
 *     server-side while the client believes it landed nothing.
 *
 * ORACLE (canonical git, `file://` bare): every push command gets a per-ref in-band
 * status the client can read — `ok refs/heads/ok` / `ng <long> ...` (or, where the
 * backend rejects the whole batch, `! [remote rejected]` for BOTH) — at the HTTP
 * level a clean 200, NEVER a 500. Client and server always agree on which refs
 * landed.
 *
 * CONTRACT asserted here: a mixed non-atomic push must be answered with an
 * HTTP-level success the client can read AND client+server must agree on the
 * applied set — pggit must not 500 while silently committing one of the refs.
 *
 * EXPECTED-RED until pggit catches the per-command apply failure and turns it into
 * an in-band `ng` (status 200) instead of leaking it as a 500. This test drives
 * real `git push` over the wire and observes the divergence directly.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

/**
 * A deterministic, INCOMPRESSIBLE ref-name tail of `len` lowercase-hex chars.
 * Chained SHA-256 hex is high-entropy, so Postgres' btree TOAST compression
 * cannot shrink it below the 2704-byte index-entry ceiling — which is exactly
 * what makes the over-long-name INSERT throw. (A repeated/compressible name of
 * the same length does NOT reproduce — the live server accepts it.) No
 * Math.random / Date.now: the bytes are a pure function of the fixed seed.
 */
function incompressibleHex(len: number): string {
	let out = ""
	let seed = "pggit-nam02-seed"
	while (out.length < len) {
		seed = createHash("sha256").update(seed).digest("hex")
		out += seed
	}
	return out.slice(0, len)
}

describe("nam02 — mixed non-atomic push (valid + over-long ref) must not diverge", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string
	let url: string
	// 2800 incompressible chars > the ~2704-byte btree index-entry ceiling.
	const longRef = `refs/heads/${incompressibleHex(2800)}`

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		// Boot exactly like the live server (server.ts) — objects + refs + the
		// queryable snapshot view — so the receive-pack path under test is identical.
		const snapshots = createSnapshotStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)
		url = `http://127.0.0.1:${server.port}/nam02`

		src = mkdtempSync(join(tmpdir(), "pggit-nam02-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("does not 500 while silently committing one ref of the batch", async () => {
		// One non-atomic push of TWO refspecs: a valid branch and an over-long one.
		const outcome = await spawnGit(
			["push", url, "main:refs/heads/ok", `main:${longRef}`],
			{ cwd: src },
		).then(
			(r) => ({ failed: false, stderr: r.stderr, stdout: r.stdout }),
			(e) => ({
				failed: true,
				stderr: e instanceof GitCommandError ? e.stderr : String(e),
				stdout: e instanceof GitCommandError ? e.stdout : "",
			}),
		)

		// Whatever the client observed, read the SERVER's durable state and a fresh
		// clone — the two must not contradict each other.
		const refs = createRefStore(db.sql)
		const stored = new Set((await refs.listRefs("nam02")).map((r) => r.name))
		const okAppliedServerSide = stored.has("refs/heads/ok")

		// The bug surfaces as an HTTP 500 with no in-band report-status: git can't
		// read a per-ref result, so it reports the whole push as failed even though
		// `refs/heads/ok` is durably in the store. Canonical git NEVER answers a push
		// with a server error — it sends `ng`/`ok` per ref at HTTP 200.
		expect(
			outcome.stderr,
			"client must not see an HTTP 500 / RPC failure — push must report per-ref status in-band",
		).not.toMatch(/HTTP 500|RPC failed|hung up/)

		// And the core divergence: the client must not believe the push failed
		// wholesale while the server durably kept one of the refs. If `ok` landed
		// server-side, the client's push must have SUCCEEDED (exit 0) and reported it.
		if (okAppliedServerSide) {
			// No divergence: refs/heads/ok landed in-band, so the client was TOLD it landed
			// (git prints `* [new branch] main -> ok`). The push still exits non-zero because
			// the over-long ref was rejected in-band — which is correct, and exactly what the
			// file:// oracle does too (a 2800-char ref overflows the filesystem there); the
			// non-zero exit is NOT a divergence. The bug was a 500 with NO report-status, so
			// the client saw a wholesale failure while refs/heads/ok had durably landed.
			expect(
				outcome.stderr,
				"refs/heads/ok landed server-side, so the client must have been told in-band ([new branch]), not seen a wholesale failure",
			).toMatch(/\[new branch]/)
		}
	})
})

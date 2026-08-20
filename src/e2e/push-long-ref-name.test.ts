/**
 * Ref-name limits at the receive-pack boundary — the storable-name cap and the
 * state a rejection must not leave behind.
 *
 * Two describes, each driving the boundary differently (nam01 via an in-process
 * app.request, nam02 via real `git push` over the wire):
 *
 *   - nam01 — the cap pinned in BOTH directions, and no orphaned objects behind a
 *     rejection
 *   - nam02 — a mixed non-atomic push (valid + over-long ref) reports per-ref status
 *     in-band; client and server never disagree about what landed
 *
 * THE RULE: receive-pack rejects a ref name longer than MAX_REF_NAME_BYTES (2000)
 * BEFORE ingest, as an in-band `ng <ref> funny refname (too long to store)` under
 * HTTP 200 — the shape canonical git answers with when its own backend cannot lock
 * the ref.
 *
 * ORIGINATED as the breakage probe for `git_ref`'s btree primary key on
 * (repo_id, name): an INCOMPRESSIBLE ~2800-byte name overflows the ~2704-byte
 * index-entry cap, and the raw Postgres error escaped the handler as an HTTP 500
 * after the pack had already been ingested — a torn half-push behind an opaque
 * status. Fixed by the boundary cap, which is why the over-long fixtures here stay
 * incompressible: that is the shape that used to reach the btree.
 */
import { createHash } from "node:crypto"
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
import { attemptGit, spawnGit } from "@/testing/spawn-git"
import { postReceivePack, receivePackRequest } from "@/testing/wire-receive"

const ZERO = "0".repeat(40)

/**
 * nam01 — the ref-name cap in both directions, and the state a rejection leaves.
 *
 * The cap is a byte-count rule applied before ingest, so the pair pins it: a name
 * of exactly 2000 bytes is ACCEPTED and stored; 2001 comes back as an in-band `ng`.
 * The historical over-long name (2832 incompressible bytes — the shape that used to
 * reach the btree and 500) is the third case, and carries the state assertion: a
 * rejected push leaves ZERO objects, because the boundary check runs before ingest.
 */
describe("nam01 — the storable ref-name cap, pinned in both directions", () => {
	/**
	 * Deterministic incompressible hex string of exactly `len` chars: a SHA-256 chain
	 * seeded by a fixed string, hex-concatenated and truncated. High-entropy hex does
	 * not compress under pglz, so a name built from it is genuinely unstorable in the
	 * btree PK past ~2704 bytes — the storage pressure the boundary cap keeps off the
	 * store, and the reason a compressible name of the same length proves nothing.
	 */
	function incompressibleName(len: number): string {
		let seed = Buffer.from("pggit-nam01")
		let out = ""
		while (out.length < len) {
			seed = createHash("sha256").update(seed).digest()
			out += seed.toString("hex")
		}
		return out.slice(0, len)
	}

	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let src: string
	let commitOid = ""
	let pack: Buffer
	// receive-pack's own MAX_REF_NAME_BYTES: the boundary rejects anything longer,
	// in-band, rather than letting the btree PK raise an opaque storage error.
	const MAX_REF_NAME_BYTES = 2000
	const refAtCap = `refs/heads/${incompressibleName(MAX_REF_NAME_BYTES - "refs/heads/".length)}`
	const refOverCap = `refs/heads/${incompressibleName(MAX_REF_NAME_BYTES + 1 - "refs/heads/".length)}`
	// 2832 chars also overflows the btree's 2704-byte index-entry cap (the observed
	// `index row size 2832 exceeds ... 2704`) — the original reproduction.
	const longRef = `refs/heads/${incompressibleName(2832 - "refs/heads/".length)}`

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		// Mirror the LIVE server boot (the queryable snapshot view is wired in prod).
		const snapshots = createRepoFileProjection(db.sql)
		app = createGitApp({ objects, refs, snapshots })

		src = mkdtempSync(join(tmpdir(), "nam01-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha\n")
		writeFileSync(join(src, "b.txt"), "beta\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		commitOid = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		// The full closure of the single commit (commit + tree + 2 blobs).
		pack = (
			await spawnGit(["pack-objects", "--stdout", "--revs"], {
				cwd: src,
				input: `${commitOid}\n`,
			})
		).stdoutBytes
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("stores a name of exactly the cap and rejects one byte more, in-band", async () => {
		expect(Buffer.byteLength(refAtCap, "utf8")).toBe(MAX_REF_NAME_BYTES)
		expect(Buffer.byteLength(refOverCap, "utf8")).toBe(MAX_REF_NAME_BYTES + 1)
		const repo = "nam01-cap"
		const refs = createRefStore(db.sql)

		// At the cap: accepted, reported `ok`, and durably stored.
		const atCap = await postReceivePack(
			app,
			repo,
			receivePackRequest(
				[`${ZERO} ${commitOid} ${refAtCap}\0report-status object-format=sha1\n`],
				pack,
			),
		)
		expect(atCap.status).toBe(200)
		const atCapReport = atCap.body.toString("utf8")
		expect(atCapReport, "a name AT the cap must be accepted").toContain(`ok ${refAtCap}`)
		expect((await refs.listRefs(repo)).map((r) => r.name)).toContain(refAtCap)

		// One byte over: rejected in-band with git's `funny refname` wording, and no
		// ref written — the cap is a boundary rule, not a storage accident.
		const overCap = await postReceivePack(
			app,
			repo,
			receivePackRequest(
				[`${ZERO} ${commitOid} ${refOverCap}\0report-status object-format=sha1\n`],
				pack,
			),
		)
		expect(overCap.status).toBe(200)
		const overCapReport = overCap.body.toString("utf8")
		expect(overCapReport, "one byte over the cap must be `ng`'d").toContain(
			`ng ${refOverCap} funny refname (too long to store)`,
		)
		expect((await refs.listRefs(repo)).map((r) => r.name)).not.toContain(refOverCap)
	})

	it("answers 200 report-status (ng) and leaves no orphaned objects", async () => {
		const repo = "nam01-reflimit"
		const res = await postReceivePack(
			app,
			repo,
			receivePackRequest(
				[`${ZERO} ${commitOid} ${longRef}\0report-status object-format=sha1\n`],
				pack,
			),
		)
		const report = res.body.toString("utf8")

		// Contract 1: a storage limit on the ref name is an in-band rejection, not a
		// transport-level 500 — exactly like the file:// oracle's "cannot lock ref".
		expect(
			res.status,
			`expected HTTP 200 report-status, got ${res.status} body=${report.slice(0, 120)}`,
		).toBe(200)
		expect(report, "must not leak a 500 / internal server error").not.toContain(
			"internal server error",
		)
		// The ref must be reported as failed (ng) naming the ref and git's reason,
		// never silently dropped or ok'd.
		expect(report, "over-long ref must be reported `ng`").toContain(
			`ng ${longRef} funny refname (too long to store)`,
		)

		// Contract 2: no orphaned objects. The oracle writes NOTHING on a rejected
		// ref; pggit must not leave the committed pack closure dangling unreachable.
		const orphans = await db.sql<{ n: number }[]>`
			select count(*)::int as n
			from git_object o
			join repos r on r.id = o.repo_id
			where r.name = ${repo}
		`
		const orphanCount = orphans[0]
		if (orphanCount === undefined) throw new Error("orphan aggregate returned no row")
		expect(
			orphanCount.n,
			"failed over-long ref push left orphaned (unreachable) objects in git_object",
		).toBe(0)
	})
})

/**
 * nam02 — a SINGLE non-atomic push carrying one valid ref (`refs/heads/ok`) and one
 * unstorably-long ref: client and server must agree about what landed.
 *
 * THE CONTRACT: a non-atomic push applies each command on its own, so the valid ref
 * lands and the over-long one comes back `ng` — every command answered per-ref
 * in-band at HTTP 200, exactly as a canonical `file://` remote answers (there the
 * 2800-char name overflows the filesystem instead of a btree, and git prints
 * `! [remote rejected]` for that ref alone). The push exits non-zero because one
 * command was rejected; that is agreement, not divergence.
 *
 * ORIGINATED as the breakage probe for the un-guarded per-command apply loop: the
 * over-long name's INSERT threw the raw btree error, which escaped as HTTP 500 with
 * NO report-status — so git reported the whole push as failed ("the remote end hung
 * up") while `refs/heads/ok` was already durably committed server-side, a state the
 * client could not see. Fixed by the pre-ingest name check, which turns it into a
 * per-ref `ng`.
 */
describe("nam02 — mixed non-atomic push (valid + over-long ref) must not diverge", () => {
	/**
	 * A deterministic, INCOMPRESSIBLE ref-name tail of `len` lowercase-hex chars.
	 * Chained SHA-256 hex is high-entropy, so Postgres' btree TOAST compression
	 * cannot shrink it below the 2704-byte index-entry ceiling — the pressure that
	 * used to reach the storage layer, and the reason a repeated/compressible name of
	 * the same length is not the same fixture. No Math.random / Date.now: the bytes
	 * are a pure function of the fixed seed.
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
		const snapshots = createRepoFileProjection(db.sql)
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
		const outcome = await attemptGit(
			["push", url, "main:refs/heads/ok", `main:${longRef}`],
			src,
		)

		// Whatever the pushing client observed, read the server's durable state and
		// ask a fresh canonical client what the remote advertises. None may contradict.
		const refs = createRefStore(db.sql)
		const stored = new Set((await refs.listRefs("nam02")).map((r) => r.name))
		const okAppliedServerSide = stored.has("refs/heads/ok")
		const longRefAppliedServerSide = stored.has(longRef)
		const sourceOid = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		const advertised = (await spawnGit(["ls-remote", url])).stdout

		// The bug surfaces as an HTTP 500 with no in-band report-status: git can't
		// read a per-ref result, so it reports the whole push as failed even though
		// `refs/heads/ok` is durably in the store. Canonical git NEVER answers a push
		// with a server error — it sends `ng`/`ok` per ref at HTTP 200.
		expect(
			outcome.stderr,
			"client must not see an HTTP 500 / RPC failure — push must report per-ref status in-band",
		).not.toMatch(/HTTP 500|RPC failed|hung up/)

		// The valid half MUST land: a non-atomic push applies each command on its own,
		// so the over-long ref's rejection cannot take `refs/heads/ok` down with it.
		// The command exits non-zero for the rejected half, but its per-ref status must
		// still tell the client that `ok` succeeded.
		expect(
			okAppliedServerSide,
			`refs/heads/ok never landed — stored: ${[...stored].join(", ")}`,
		).toBe(true)
		// And the client was TOLD it landed (git prints `* [new branch] main -> ok`).
		// The push still exits non-zero because the over-long ref was rejected in-band
		// — correct, and exactly what the file:// oracle does too (a 2800-char ref
		// overflows the filesystem there); the non-zero exit is NOT the divergence. The
		// divergence was a 500 with NO report-status, leaving the client believing the
		// whole push failed while refs/heads/ok had durably landed.
		expect(
			outcome.stderr,
			"refs/heads/ok landed server-side, so the client must have been told in-band ([new branch]), not seen a wholesale failure",
		).toMatch(/\[new branch]/)
		expect(outcome.ok, "one rejected command must make git push exit non-zero").toBe(
			false,
		)
		expect(
			outcome.stderr,
			"the client must receive the over-long ref's per-ref rejection",
		).toMatch(/\[remote rejected].*funny refname \(too long to store\)/)
		expect(
			longRefAppliedServerSide,
			"the ref reported rejected must not exist in durable server state",
		).toBe(false)
		expect(advertised).toContain(`${sourceOid}\trefs/heads/ok\n`)
		expect(advertised).not.toContain(`\t${longRef}\n`)
	})
})

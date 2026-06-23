/**
 * nam01 naming / storage-error isolation — pushing a ref whose name is too long
 * to fit a Postgres btree index entry must be rejected CLEANLY in-band, and must
 * leave NO half-written state.
 *
 * BUG: `handleReceivePack` wraps `backend.ingest(pack)` in try/catch (→ in-band
 * `unpack failed`) but does NOT wrap `backend.applyRefUpdates()`. The ref CAS in
 * `casRefUpdate` (create path) inserts the ref name into `git_ref`, whose primary
 * key is a btree on `(repo_id, name)`. A sufficiently long, INCOMPRESSIBLE ref
 * name overflows the btree entry cap and Postgres throws
 *   `PostgresError: index row size NNNN exceeds btree version 4 maximum 2704
 *    for index "git_ref_pkey"`.
 * That error is uncaught: it escapes `handleReceivePack` AFTER the pack has been
 * ingested+committed, and the app's `onError` turns it into HTTP 500. Two
 * divergences from canonical git, both observed against a `file://` bare oracle:
 *   1. The oracle REJECTS the over-long ref cleanly in-band — `remote: error:
 *      cannot lock ref ...` / `! [remote rejected] ... (failed to update refs)`,
 *      push exits non-zero, NO transport-level 500. pggit answers HTTP 500.
 *   2. The oracle writes NOTHING. pggit's pack was already committed when the ref
 *      insert threw, so the repo is left with orphaned, unreachable objects (a
 *      subsequent clone reports an empty repository) — a torn half-push the
 *      client cannot see behind the opaque 500.
 *
 * CONTRACT (oracle): an over-long ref push must be answered HTTP 200 with a
 * git-report-status `ng <ref> <reason>` body — NEVER a 500 / "internal server
 * error" — and must leave the repo with ZERO objects (the failed ref means no
 * reachable history, so no objects should have been committed either).
 *
 * EXPECTED-RED until pggit guards the ref-apply storage error: today the push
 * 500s and leaves orphaned objects in `git_object`.
 *
 * Note on compressibility: the btree row-size cap is measured on the post-TOAST
 * (pglz-compressed) datum, so a repeated-character name of the same length slips
 * under the limit. The name MUST be incompressible to overflow the index — here
 * a deterministic SHA-256 hex chain (no Math.random / Date.now).
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
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)

/**
 * Deterministic incompressible hex string of exactly `len` chars: a SHA-256 chain
 * seeded by a fixed string, hex-concatenated and truncated. High-entropy hex does
 * not compress under pglz, so 2832 such chars overflow the 2704-byte btree cap.
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

function pkt(line: string): Buffer {
	const payload = Buffer.from(line, "utf8")
	const len = payload.length + 4
	return Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0")), payload])
}

function receiveBody(commands: string[], pack: Buffer): Buffer {
	const lines = commands.map((c, i) =>
		pkt(i === 0 ? `${c}\0report-status object-format=sha1\n` : `${c}\n`),
	)
	return Buffer.concat([...lines, Buffer.from("0000"), pack])
}

async function postReceivePack(
	app: ReturnType<typeof createGitApp>,
	repo: string,
	body: Buffer,
): Promise<{ status: number; text: string }> {
	const res = await app.request(`/${repo}/git-receive-pack`, {
		body: new Uint8Array(body),
		method: "POST",
	})
	return {
		status: res.status,
		text: Buffer.from(await res.arrayBuffer()).toString("utf8"),
	}
}

describe("nam01 — over-long incompressible ref name must reject in-band, not 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let src: string
	let commitOid = ""
	let pack: Buffer
	// 2832 chars overflows the btree's 2704-byte index-entry cap (matches the
	// observed `index row size 2832 exceeds ... 2704`).
	const longRef = `refs/heads/${incompressibleName(2832 - "refs/heads/".length)}`

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		// Mirror the LIVE server boot (the queryable snapshot view is wired in prod).
		const snapshots = createSnapshotStore(db.sql)
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

	it("answers 200 report-status (ng) and leaves no orphaned objects", async () => {
		const repo = "nam01-reflimit"
		const res = await postReceivePack(
			app,
			repo,
			receiveBody([`${ZERO} ${commitOid} ${longRef}`], pack),
		)

		// Contract 1: a storage limit on the ref name is an in-band rejection, not a
		// transport-level 500 — exactly like the file:// oracle's "cannot lock ref".
		expect(
			res.status,
			`expected HTTP 200 report-status, got ${res.status} body=${res.text.slice(0, 120)}`,
		).toBe(200)
		expect(res.text, "must not leak a 500 / internal server error").not.toContain(
			"internal server error",
		)
		// The ref must be reported as failed (ng), never silently dropped or ok'd.
		expect(res.text, "over-long ref must be reported `ng`").toContain("ng ")

		// Contract 2: no orphaned objects. The oracle writes NOTHING on a rejected
		// ref; pggit must not leave the committed pack closure dangling unreachable.
		const orphans = await db.sql<{ n: number }[]>`
			select count(*)::int as n
			from git_object o
			join repos r on r.id = o.repo_id
			where r.name = ${repo}
		`
		expect(
			orphans[0]?.n ?? 0,
			"failed over-long ref push left orphaned (unreachable) objects in git_object",
		).toBe(0)
	})
})

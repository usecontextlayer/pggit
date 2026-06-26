/**
 * a13 ref lifecycle — a `refs/heads/*` push whose tip is NOT a commit (a tree,
 * blob, or annotated-tag object) must NOT crash the response with HTTP 500.
 *
 * BUG: the post-commit snapshot refresh (`syncRefSnapshot` → `buildFileList` →
 * `commitTreeOid`) fires for every `refs/heads/*` ref and assumes the tip is a
 * commit. When the tip is a tree/blob/tag object, `commitTreeOid` throws
 * `GitFormatError: commit has no tree header`. That throw is NOT caught — it
 * escapes `handleReceivePack` (the snapshot loop at receive-pack.ts:201 has no
 * guard) and the app's `onError` turns it into HTTP 500 "internal server error".
 *
 * Two ways this diverges from canonical git, both observed against a `file://`
 * bare-repo oracle:
 *   1. Canonical receive-pack REJECTS a branch pointing at a non-commit with a
 *      clean in-band `ng <ref> ...` (status 200) and writes NOTHING ("invalid
 *      new value provided"). pggit answers HTTP 500 instead.
 *   2. Worse: pggit's ref CAS has ALREADY committed by the time the snapshot
 *      rebuild throws (the throw is post-commit, by design "never rolls back"),
 *      so the repo is left with an illegal branch ref pointing at a tree while
 *      the client sees only a 500 and cannot tell the push half-succeeded.
 *
 * The contract: a branch-tip-non-commit push must be answered with HTTP 200 and
 * a git-report-status body (an `ng` rejection, or — if pggit chooses to accept
 * non-commit branch tips — an `ok`), but NEVER a 500 / "internal server error".
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { encodePktLine } from "@/protocol/pkt-line"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)

function receiveBody(commands: string[], pack: Buffer): Buffer {
	const lines = commands.map((c, i) =>
		encodePktLine(
			Buffer.from(
				i === 0 ? `${c}\0report-status object-format=sha1\n` : `${c}\n`,
				"utf8",
			),
		),
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

describe("a13 — branch tip that is not a commit must not 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let src: string
	let commitOid = ""
	let treeOid = ""
	let blobOid = ""
	let tagOid = ""
	let fullPack: Buffer

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		// The LIVE server wires the queryable snapshot view — reproduce that boot so
		// the snapshot rebuild (where the bug lives) is actually exercised.
		const snapshots = createRepoFileProjection(db.sql)
		app = createGitApp({ objects, refs, snapshots })

		src = mkdtempSync(join(tmpdir(), "a13-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "f.txt"), "hello\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		commitOid = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		treeOid = (await spawnGit(["rev-parse", "HEAD^{tree}"], { cwd: src })).stdout.trim()
		blobOid = (await spawnGit(["rev-parse", "HEAD:f.txt"], { cwd: src })).stdout.trim()
		await spawnGit(["tag", "-a", "-m", "annotated", "atag", commitOid], { cwd: src })
		tagOid = (await spawnGit(["rev-parse", "atag"], { cwd: src })).stdout.trim()

		// A pack carrying the full closure of the tag (commit+tree+blob+tag), so
		// connectivity passes for any of the four oids as a branch tip.
		fullPack = (
			await spawnGit(["pack-objects", "--stdout", "--revs"], {
				cwd: src,
				input: `${tagOid}\n`,
			})
		).stdoutBytes
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("tree/blob/tag tip on refs/heads/* is answered 200 report-status, never 500", async () => {
		const cases: { name: string; tip: () => string }[] = [
			{ name: "tree", tip: () => treeOid },
			{ name: "blob", tip: () => blobOid },
			{ name: "tag", tip: () => tagOid },
		]
		for (const { name, tip } of cases) {
			const repo = `a13-${name}`
			const refs = createRefStore(db.sql)
			// First push a valid commit branch so the pack (carrying the closure) is
			// ingested and connectivity is satisfied for the non-commit tip too.
			await postReceivePack(
				app,
				repo,
				receiveBody([`${ZERO} ${commitOid} refs/heads/main`], fullPack),
			)
			// Now point a BRANCH at a non-commit object (objects already in store).
			const res = await postReceivePack(
				app,
				repo,
				receiveBody([`${ZERO} ${tip()} refs/heads/bad-${name}`], Buffer.alloc(0)),
			)

			expect(
				res.status,
				`branch->${name}: expected HTTP 200 report-status, got ${res.status} body=${res.text.slice(0, 80)}`,
			).toBe(200)
			expect(
				res.text,
				`branch->${name}: must not leak internal server error`,
			).not.toContain("internal server error")

			// If the server rejected (ng), the ref must NOT have been written; if it
			// accepted (ok), it may be present. The illegal state — ref written AND a
			// 500 returned — is the bug. Assert no torn state: a written bad ref must
			// have been reported ok.
			const stored = Object.fromEntries(
				(await refs.listRefs(repo)).map((r) => [r.name, r.oid]),
			)
			const written = stored[`refs/heads/bad-${name}`] !== undefined
			const reportedOk = res.text.includes(`ok refs/heads/bad-${name}`)
			expect(
				written ? reportedOk : true,
				`branch->${name}: ref written to store but not reported ok (torn state)`,
			).toBe(true)
		}
	})
})

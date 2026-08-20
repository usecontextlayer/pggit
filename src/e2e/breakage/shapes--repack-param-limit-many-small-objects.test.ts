/**
 * `repack` completes on a repo whose objects are MANY and SMALL — more than
 * 65,534 pending objects gathered into a single read batch — and the repo stays
 * clonable and object-identical afterwards.
 *
 * THE DEFECT THIS PINS: repack's phase-2 coverage sweep once batched only by
 * BYTES (a 16 MB window) and then read that batch with `oid in ${pg(list)}`,
 * which spends ONE bind parameter per oid. Postgres' extended protocol caps a
 * statement at 65,535 parameters (porsager enforces 65,534) and the query
 * already spends one on `repo_id`, so any repo whose objects average under
 * ~244 bytes crossed the parameter ceiling before it crossed 16 MB and the pass
 * threw `MAX_PARAMETERS_EXCEEDED` before writing anything. The sweep is now
 * bounded by oid COUNT as well as bytes, matching every other batched read in
 * the codebase.
 *
 * TWO SHAPES, both perfectly ordinary git repos:
 *
 *   A. 66,000 tiny files in ONE commit  (~0.4 MB of content)
 *   B. 66,000 commits over one file     (~13.8 MB of content, mean 209 B/object)
 *
 * Nothing adversarial about either CONTENT; the only unusual property is object
 * COUNT relative to total bytes. Neither shape is exotic: phase 1 only encodes
 * TREES that pair with a same-path predecessor, so every commit object, every
 * blob and every predecessor-less tree falls through to the sweep — meaning ANY
 * repo with ≳65.5k commits reaches it (git.git ~70k, the Linux kernel ~1.2M),
 * as does any repo of small blobs, as does the first repack of any repo whose
 * initial commit carries ≳65.5k objects.
 *
 * THE CONTRACT, asserted per shape: real git serves the shape (the control
 * `file://` remote clones it fsck-clean), pggit's wire path serves it (push and
 * the pre-repack clone are object-identical to the source), `repack` does real
 * work, an immediately repeated `repack` is a no-op — the old failure threw
 * before emitting anything and reproduced identically on every retry, so
 * convergence is the observable that separates "the pass completed" from "the
 * pass keeps failing the same way" — and the post-repack clone is still
 * fsck-clean and object-identical.
 *
 * Originated as breakage probe `shapes--repack-param-limit-many-small-objects.ts`
 * (exit 0 = correct behavior · exit 1 = bug reproduced), which reproduced the
 * bind-parameter ceiling; fixed. The retry-convergence assertion is folded in
 * from the retired `lifecycle--repack-bind-parameter-ceiling` probe, which
 * covered the same defect at the same boundary.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack, type Repack } from "@/store/repack"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const WHO = "A U Thor <author@example.com> 1700000000 +0000"

/** The fixture's object count. THE BUG LIVES AT THIS BOUNDARY (porsager's 65534
 * bind-parameter ceiling, minus the one parameter spent on `repo_id`) — shrinking
 * this makes both tests vacuously green while the defect stands. */
const N = 66_000

async function objectList(dir: string): Promise<string> {
	const r = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	return r.stdout.trim().split("\n").filter(Boolean).sort().join("\n")
}

async function rawBytes(dir: string): Promise<{ objects: number; bytes: number }> {
	const r = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectsize)"],
		{
			cwd: dir,
		},
	)
	const sizes = r.stdout.trim().split("\n").filter(Boolean).map(Number)
	return { bytes: sizes.reduce((a, b) => a + b, 0), objects: sizes.length }
}

/** A. N tiny files, one commit. */
function streamManyFiles(): string {
	const out: string[] = []
	const changes: string[] = []
	for (let i = 0; i < N; i++) {
		out.push(`blob\nmark :${i + 1}\ndata ${String(i).length + 1}\n${i}\n\n`)
		changes.push(`M 100644 :${i + 1} f/${i}.txt`)
	}
	out.push(
		`commit refs/heads/main\nmark :${N + 1}\ncommitter ${WHO}\ndata 4\nseed\n${changes.join("\n")}\n\ndone\n`,
	)
	return out.join("")
}

/** B. N commits over one file. */
function streamManyCommits(): string {
	const out: string[] = ["blob\nmark :1\ndata 2\nx\n\n"]
	let mark = 1
	let prev = 0
	for (let i = 0; i < N; i++) {
		const cm = ++mark
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nc${i % 10}\n` +
				(prev ? `from :${prev}\n` : "") +
				"M 100644 :1 f\n\n",
		)
		prev = cm
	}
	out.push("done\n")
	return out.join("")
}

describe("repack — the bind-parameter ceiling on many small objects", () => {
	let db: IsolatedDb
	let server: GitServer
	let repack: Repack

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		repack = createRepack(db.sql)
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
	})

	/**
	 * Build the shape, prove real git serves it, prove pggit's WIRE path serves it,
	 * then demand that `repack` — the only stage that fails — succeeds and leaves
	 * the repo still clonable and object-identical.
	 */
	async function runShape(tag: string, stream: string): Promise<void> {
		const scratch: string[] = []
		const mk = (suffix: string): string => {
			const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-${suffix}-`))
			scratch.push(d)
			return d
		}

		try {
			const src = join(mk("src"), "src")
			await spawnGit(["init", "-q", "-b", "main", src])
			await spawnGit(["fast-import", "--quiet", "--done"], { cwd: src, input: stream })
			const srcObjs = await objectList(src)
			const { bytes, objects } = await rawBytes(src)
			console.log(
				`shape ${tag} — source: ${objects} objects, ${bytes} raw bytes (mean ${Math.round(bytes / objects)} B/object)`,
			)
			// Fixture guard, not a claim about the code: past 65,534 pending objects is
			// the entire reproduction, so a fixture that drifted under it would turn
			// both assertions below into a green that means nothing.
			expect(objects).toBeGreaterThan(65_534)

			// Control: the same dance against a plain bare git remote.
			const mirror = join(mk("m"), "m.git")
			await spawnGit(["init", "-q", "--bare", mirror])
			await spawnGit(["push", "-q", mirror, "refs/heads/*:refs/heads/*"], { cwd: src })
			const ctl = join(mk("ctl"), "c.git")
			await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, ctl])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: ctl })
			expect(await objectList(ctl)).toBe(srcObjs)

			// pggit's wire path: push + pre-repack clone are already correct today.
			const url = repoUrl(server, tag)
			await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: src })
			const pre = join(mk("pre"), "c.git")
			await spawnGit(["clone", "-q", "--bare", url, pre])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: pre })
			expect(await objectList(pre)).toBe(srcObjs)

			// THE DEFECT LANDED HERE: the phase-2 coverage sweep threw
			// `MAX_PARAMETERS_EXCEEDED` on a repo real git serves fine. The contract is
			// a completed pass that encodes the whole pending inventory.
			const res = await repack.repack(tag)
			console.log(`shape ${tag} — repack: ${res.wholes} wholes + ${res.deltas} deltas`)
			expect(res.wholes + res.deltas).toBeGreaterThan(0)

			// The old failure threw before emitting anything and reproduced identically
			// on every retry, so it never self-healed. A completed pass converges: the
			// pending set is empty, and a second call encodes nothing.
			expect(await repack.repack(tag)).toEqual({ deltas: 0, wholes: 0 })

			const post = join(mk("post"), "c.git")
			await spawnGit(["clone", "-q", "--bare", url, post])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: post })
			expect(await objectList(post)).toBe(srcObjs)
		} finally {
			for (const d of scratch) rmSync(d, { force: true, recursive: true })
		}
	}

	it("many-small-files: 66,000 tiny blobs in one commit repack and still clone clean", async () => {
		await runShape("many-small-files", streamManyFiles())
	}, 600_000)

	it("many-commits: 66,000 ~200-byte commits repack and still clone clean", async () => {
		await runShape("many-commits", streamManyCommits())
	}, 600_000)
})

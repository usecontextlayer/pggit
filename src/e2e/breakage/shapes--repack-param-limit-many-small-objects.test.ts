/**
 * BREAKAGE — `createRepack().repack()` throws on any repo whose objects are many
 * and small: >65,533 pending objects inside one 16 MB read window.
 *
 * Converted from `breakage/shapes--repack-param-limit-many-small-objects.ts`
 * (exit 0 = correct behavior · exit 1 = bug reproduced). The verdict is a pure
 * CORRECTNESS property over a hermetically-built repo, so it lands here as a
 * plain e2e test. The assertions encode the CORRECT outcome, so this file is RED
 * today: `repack` throws `MAX_PARAMETERS_EXCEEDED` before either `it` can reach
 * its post-repack clone.
 *
 * TWO SHAPES, both perfectly ordinary git repos:
 *
 *   A. 66,000 tiny files in ONE commit  (~0.4 MB of content)
 *   B. 66,000 commits over one file     (~13.8 MB of content, mean 209 B/object)
 *
 * Nothing adversarial about either CONTENT; the only unusual property is object
 * COUNT relative to total bytes. Real git handles both (the control `file://`
 * remote clones them fsck-clean), and so does pggit's wire path — push and the
 * PRE-repack clone both succeed and are object-identical to the source. Only
 * `repack` fails.
 *
 * THE DEFECT — `src/store/repack.ts`, phase-2 coverage sweep:
 *
 *     for (const p of [...pendingByOid.values()]) {
 *         sweep.push(p)
 *         sweepBytes += p.size
 *         if (sweepBytes >= READ_BATCH_BYTES) await flushSweep()   // 16 MB
 *     }
 *
 * and `flushSweep` issues `... where oid in ${pg(sweep.map(...))}` — one bind
 * PARAMETER per oid. Postgres' extended protocol caps a statement at 65535
 * parameters (porsager enforces 65534) and the query already spends one on
 * `repo_id`. The batch is bounded by BYTES and never by COUNT, so the sweep is
 * safe only while pending objects average more than ~244 bytes each.
 *
 * WHY IT IS NOT EXOTIC: phase 1 only ever encodes TREES that pair with a same-path
 * predecessor. Every commit object, every blob, and every tree with no predecessor
 * falls through to this sweep. Commit objects are ~200 bytes — so ANY repo with
 * ≳65.5k commits trips it (git.git ~70k, the Linux kernel ~1.2M), as does any repo
 * whose blobs are small (generated records, i18n keys, fixtures, empty files, the
 * per-run `stderr` files in a ContextLayer workspace repo), as does the first
 * repack of any repo whose initial commit carries ≳65.5k objects.
 *
 * BLAST RADIUS: the pass throws before writing anything, and throws again at
 * exactly the same point on every retry — the repo never gets an encoding tier.
 * Wired to the drain (design W1) it is a permanently failing background task.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack, type Repack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
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
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		repack = createRepack(db.sql)
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
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
			const url = `http://127.0.0.1:${server.port}/${tag}`
			await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: src })
			const pre = join(mk("pre"), "c.git")
			await spawnGit(["clone", "-q", "--bare", url, pre])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: pre })
			expect(await objectList(pre)).toBe(srcObjs)

			// THE DEFECT LANDS HERE: today this throws `MAX_PARAMETERS_EXCEEDED` out of
			// the phase-2 coverage sweep, on a repo real git serves fine. Correct
			// behavior is a completed pass that encodes the whole pending inventory.
			const res = await repack.repack(tag)
			console.log(`shape ${tag} — repack: ${res.wholes} wholes + ${res.deltas} deltas`)
			expect(res.wholes + res.deltas).toBeGreaterThan(0)

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

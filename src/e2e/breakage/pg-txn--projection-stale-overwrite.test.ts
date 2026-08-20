/**
 * BREAKAGE (pg-txn) — two concurrent pushes leave repo_file on a superseded tip.
 * Converted from `breakage/pg-txn--projection-stale-overwrite.ts`; its rationale
 * verbatim:
 *
 * FINDING: the `repo_file` projection is written OUTSIDE the ref CAS that decides
 * it, with no version guard — so two ordinary concurrent pushes to the same
 * branch can leave the public read surface permanently describing a tip that is
 * no longer the tip.
 *
 * `handleReceivePack` applies the ref CAS, then (post-commit, best-effort) calls
 * `syncRefSnapshot(ref, c.newOid)` with the oid from ITS OWN command. That call
 * walks the tip's trees (one point-read per tree — slow for a wide tree) and then
 * replaces the branch's `repo_file` rows in a transaction. Nothing serializes two
 * such rebuilds, and nothing checks that `newOid` is still what the ref holds.
 *
 * So for pushes A (advance to X) and B (advance X→Y):
 *   A: CAS main → X commits ······································ (ref = X)
 *   B: CAS main → Y commits ······································ (ref = Y)
 *   B: rebuild repo_file from Y ·································· (proj = Y)  ✓
 *   A: rebuild repo_file from X ·································· (proj = X)  ✗
 * Both clients are told `ok`. The ref is Y. The projection is X, forever — no GC,
 * repack, or clone repairs it; only a later push to that same branch does.
 *
 * pggit's own optimistic-git-writes model makes concurrent pushes to one branch
 * the EXPECTED case, and `repo_file ⋈ git_object` is the documented public read
 * surface, so this is the read surface silently serving a superseded tree.
 *
 * FAULT INJECTED: none needed — only real concurrency. The window is widened
 * honestly: A's tip has many directories (its tree walk is one round-trip per
 * tree), B's tip has few. Both are ordinary pushes over real HTTP with real git.
 *
 * The source script exits non-zero the first attempt it reproduces; the
 * assertions below encode the CORRECT contract (the projection always describes
 * the ref tip, and any divergence is repaired by gc+repack), so a reproduction is
 * a red test. The 3000-directory wide tip and the 4-attempt loop are the source's
 * — the race window is the width of A's tree walk.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { parseLsTree } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

const WHEN = "1700000000 +0000"
const COMMITTER = `pggit oracle <oracle@pggit.test> ${WHEN}`
const DIRS = 3000
const ATTEMPTS = 4

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A revision's worktree as sorted `path\0mode\0oid` — the same shape `repo_file`
 * stores, so the projection and a real clone are directly comparable. */
async function lsTree(dir: string, rev: string): Promise<string[]> {
	const out = await spawnGit(["ls-tree", "-r", rev], { cwd: dir })
	return parseLsTree(out.stdout)
		.map((e) => `${e.path}\0${e.mode}\0${e.oid}`)
		.sort()
}

/** c0 (a one-file seed), X (WIDE: `dirs` directories, so buildFileList costs
 * `dirs`+1 point reads), then Y (NARROW: drops the wide tree, so its rebuild is
 * two point reads). */
function history(dirs: number): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (s: string) => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(s)}\n${s}\n`)
		return m
	}
	const r0 = blob("readme v0\n")
	const c0 = next()
	out.push(
		`commit refs/heads/main\nmark :${c0}\ncommitter ${COMMITTER}\ndata 2\nc0\nM 100644 :${r0} README.md\n`,
	)
	const adds: string[] = []
	for (let i = 0; i < dirs; i++) {
		const b = blob(`payload ${i}\n`)
		adds.push(`M 100644 :${b} wide/d${String(i).padStart(5, "0")}/f.txt`)
	}
	const cx = next()
	out.push(
		`commit refs/heads/main\nmark :${cx}\ncommitter ${COMMITTER}\ndata 1\nX\nfrom :${c0}\n${adds.join("\n")}\n`,
	)
	const r2 = blob("readme v2\n")
	const cy = next()
	out.push(
		`commit refs/heads/main\nmark :${cy}\ncommitter ${COMMITTER}\ndata 1\nY\nfrom :${cx}\nD wide\nM 100644 :${r2} README.md\n`,
	)
	return out.join("")
}

type AttemptResult = {
	repo: string
	pushA: boolean
	pushB: boolean
	refTip: string
	projection: string[]
	expected: string[]
}

describe("breakage/pg-txn — repo_file must never describe a superseded tip", () => {
	let db: IsolatedDb
	let admin: Sql
	let appSql: Sql
	let server: GitServer
	let src = ""
	let root = ""
	const attempts: AttemptResult[] = []
	let reproduced: AttemptResult | null = null
	/** After gc + repack + a fresh clone, does repo_file agree with the clone's
	 * worktree? `null` when nothing diverged in the first place. */
	let convergenceGap: { clone: number; projection: number } | null = null

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		root = mkdtempSync(join(tmpdir(), "pggit-txn-proj-"))
		src = join(root, "src")
		appSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 8,
			onnotice: () => {},
		})
		admin = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 2,
			onnotice: () => {},
		})
		server = await serveOnPort(createGitApp(createGitDeps(appSql)), 0)

		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: history(DIRS) })
		const rev = async (r: string) =>
			(await spawnGit(["rev-parse", r], { cwd: src })).stdout.trim()
		const y = await rev("main")
		const x = await rev("main~1")
		const c0 = await rev("main~2")
		const treeX = await lsTree(src, x)
		const treeY = await lsTree(src, y)

		const tipOf = async (repo: string) => {
			const [row] = await admin<{ oid: string | null }[]>`
				select encode(oid, 'hex') as oid from git_ref
				where name = 'refs/heads/main'
					and repo_id = (select id from repos where name = ${repo})`
			if (row?.oid == null) throw new Error(`main ref is missing for ${repo}`)
			return row.oid
		}
		const projectionOf = async (repo: string) => {
			const rows = await admin<{ path: string; mode: string; oid: string }[]>`
				select path, mode, encode(blob_oid, 'hex') as oid from repo_file
				where ref_name = 'refs/heads/main'
					and repo_id = (select id from repos where name = ${repo})`
			return rows.map((r) => `${r.path}\0${r.mode}\0${r.oid}`).sort()
		}

		for (let i = 0; i < ATTEMPTS && reproduced === null; i++) {
			const repo = `txn/proj-race-${i}`
			const url = `http://127.0.0.1:${server.port}/${repo}`
			const seed = await attemptGit(["push", "-q", url, `${c0}:refs/heads/main`], src)
			if (!seed.ok) throw new Error(`seed push failed: ${seed.stderr}`)

			// Fire A (wide tip → slow tree walk in its post-CAS projection rebuild).
			const a = attemptGit(["push", url, `${x}:refs/heads/main`], src)
			// The instant A's CAS commits, fire B. Both are ordinary pushes.
			const t0 = Date.now()
			for (;;) {
				if ((await tipOf(repo)) === x) break
				if (Date.now() - t0 > 60_000) throw new Error("timed out waiting for A's CAS")
				await sleep(2)
			}
			const b = await attemptGit(["push", url, `${y}:refs/heads/main`], src)
			const aRes = await a

			const refTip = await tipOf(repo)
			const projection = await projectionOf(repo)
			const expected = refTip === y ? treeY : refTip === x ? treeX : []
			const result: AttemptResult = {
				expected,
				projection,
				pushA: aRes.ok,
				pushB: b.ok,
				refTip,
				repo,
			}
			attempts.push(result)
			if (
				result.pushA &&
				result.pushB &&
				JSON.stringify(projection) !== JSON.stringify(expected)
			) {
				reproduced = result
			}
		}

		// CONVERGENCE: gc + repack + a fresh clone must reconcile the read surface.
		if (reproduced) {
			const url = `http://127.0.0.1:${server.port}/${reproduced.repo}`
			await createGc(admin).gc(reproduced.repo, { graceSeconds: 0, maintain: false })
			await createRepack(admin).repack(reproduced.repo)
			const dest = join(root, "clone")
			rmSync(dest, { force: true, recursive: true })
			const cl = await attemptGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
			if (!cl.ok) throw new Error(`clone failed: ${cl.stderr}`)
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			const cloneTree = await lsTree(dest, "HEAD")
			const after = await projectionOf(reproduced.repo)
			if (JSON.stringify(cloneTree) !== JSON.stringify(after)) {
				convergenceGap = { clone: cloneTree.length, projection: after.length }
			}
		}
	}, 1_200_000)

	afterAll(async () => {
		await server?.close()
		await appSql?.end()
		await admin?.end()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("ran the race at least once", () => {
		expect(attempts.length).toBeGreaterThan(0)
	})

	it("the projection describes the ref tip after two concurrent pushes", () => {
		const r = reproduced
		expect(
			r === null
				? null
				: `${r.repo}: both pushes reported OK; refs/heads/main = ${r.refTip.slice(0, 8)}, repo_file = ${r.projection.length} rows, the tip's real worktree = ${r.expected.length} files; rows NOT at the tip (first 3): ${JSON.stringify(
						r.projection.filter((p) => !r.expected.includes(p)).slice(0, 3),
					)}`,
		).toBeNull()
	})

	it("any divergence is repaired by gc + repack — the read surface converges", () => {
		const gap = convergenceGap
		expect(
			gap === null
				? null
				: `NO CONVERGENCE: a fresh clone's worktree has ${gap.clone} files but repo_file still has ${gap.projection} rows`,
		).toBeNull()
	})
})

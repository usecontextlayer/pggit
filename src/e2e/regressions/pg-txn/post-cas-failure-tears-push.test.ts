/**
 * Postgres transaction regression — a failure after the ref CAS must preserve a truthful push result.
 *
 * FINDING: receive-pack's "the ref CAS never rolls back" has a torn tail. Any
 * failure inside `backend.applyRefUpdates` AFTER a CAS has committed escapes
 * `handleReceivePack` — that call has NO try/catch — and Hono turns it into an
 * HTTP 500. The client is told the push failed; the server kept the ref move, and
 * skipped everything the handler does after it.
 *
 * `refs-store.applyRefUpdates` has two such after-a-commit steps on the DEFAULT
 * (non-atomic) push path:
 *
 *   FAULT POINT A — the post-commit activity stamp. The CAS commits, then
 *     `stampRepoPush` updates `repos.last_pushed_at` as
 *     a SEPARATE statement outside that transaction (deliberately: an in-txn
 *     stamp would lose garbage). If that statement fails, the ref has already
 *     moved.
 *   FAULT POINT B — the next ref in a multi-ref push. Non-atomic mode applies each
 *     CAS in its own autocommit statement, in input order. A failure on command 2
 *     leaves command 1 applied and reports total failure.
 *
 * In BOTH cases the observable damage is the same three-way tear:
 *   1. the ref advanced but `git push` exited non-zero (HTTP 500),
 *   2. the `repo_file` projection was never refreshed — the post-commit refresh
 *      loop lives AFTER the throw — so pggit's public read surface still
 *      describes the previous tip,
 *   3. `repos.last_pushed_at` was never stamped, so the self-scheduling GC drain
 *      never learns the previous tip's objects became garbage.
 *
 * And it does not converge. The client's natural retry finds the ref already at
 * its commit ("Everything up-to-date"), so no CAS runs, so no projection rebuild
 * runs. gc and repack do not touch `repo_file`. The read surface stays wrong.
 *
 * FAULT INJECTED: a `statement_timeout` abort — produced by an unrelated session
 * holding the row the post-CAS statement must write (a plain `SELECT … FOR
 * UPDATE`, i.e. any concurrent writer of that row), with `statement_timeout` set
 * on the server's own connection. Nothing in pggit is modified.
 *
 * The push in fault point A carries an EMPTY pack (its objects were already
 * ingested by an earlier push to a side branch — the ordinary "same commit
 * pushed to two branches" case), so `insertObjects` early-returns before ITS own
 * post-commit stamp and the abort lands exactly on the ref stamp.
 *
 * The assertions below encode the contract: a
 * non-atomic multi-ref push MAY partially apply (canonical git: per-ref ok/ng,
 * exit 1 when any ref fails), so the binding rule is that the per-ref REPORT is
 * truthful, the projection matches the served tip, the watermark tracks the
 * orphan, and a retry+gc+repack+clone converges. The fixes preserve the committed
 * ref's successful report while logging a post-CAS stamp failure, and turn a
 * per-ref CAS failure into that ref's `ng` instead of an HTTP 500 after earlier
 * refs already moved.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import { lsTreeSnapshot } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

const FAULT_POINTS = ["A-post-commit-stamp", "B-second-ref-in-batch"] as const
type FaultPoint = (typeof FAULT_POINTS)[number]

function refMapOf(stdout: string): Map<string, string> {
	return new Map(
		stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [oid, name] = line.split("\t")
				if (!oid || !name) throw new Error(`bad ls-remote line: ${line}`)
				return [name, oid] as const
			}),
	)
}

type PointResult = {
	point: FaultPoint
	pushOk: boolean
	targeted: string[]
	rejectedRefs: string[]
	pushTail: string
	/** refs whose oid changed across the "failed" push. */
	advanced: string[]
	unchanged: string[]
	projectionTorn: string | null
	watermarkLost: boolean
	cloneError: string | null
	convergenceGap: { clone: string[]; projection: string[] } | null
}

describe("regressions/pg-txn — a post-CAS failure must not tear the push", () => {
	let db: IsolatedDb
	let admin: Sql
	let src = ""
	let root = ""
	const results: PointResult[] = []

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		root = mkdtempSync(join(tmpdir(), "pggit-txn-postcas-"))
		src = join(root, "src")
		admin = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 3,
			onnotice: () => {},
		})

		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], {
			cwd: src,
			input: [
				"blob\nmark :1\ndata 6\nalpha\n\n",
				"blob\nmark :2\ndata 5\nbeta\n\n",
				`commit refs/heads/main\nmark :3\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nc1\nM 100644 :1 a.txt\nM 100644 :2 b.txt\n`,
				"blob\nmark :4\ndata 8\ngamma-2\n\n",
				"blob\nmark :5\ndata 8\ndelta-2\n\n",
				`commit refs/heads/main\nmark :6\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nc2\nfrom :3\nM 100644 :4 a.txt\nM 100644 :5 c.txt\nD b.txt\n`,
			].join(""),
		})
		const c2 = (await spawnGit(["rev-parse", "main"], { cwd: src })).stdout.trim()
		const c1 = (await spawnGit(["rev-parse", "main~1"], { cwd: src })).stdout.trim()
		const treeC2 = await lsTreeSnapshot(src, c2)

		for (const point of FAULT_POINTS) {
			const repo = `txn/postcas-${point}`
			const appSql = postgres(baseUrl, {
				connection: { search_path: db.schema, statement_timeout: 900 },
				max: 1,
				onnotice: () => {},
			})
			const server = await serveOnPort(createGitApp(createGitDeps(appSql)), 0)
			const url = `http://127.0.0.1:${server.port}/${repo}`
			try {
				// Setup: main at c1 (projection built), and every c2 object already
				// ingested via a side branch (so the faulted push ships an empty pack).
				for (const spec of [`${c1}:refs/heads/main`, `${c2}:refs/heads/side`]) {
					const r = await attemptGit(["push", "-q", url, spec], src)
					if (!r.ok) throw new Error(`setup push ${spec} failed: ${r.stderr}`)
				}
				if (point === "B-second-ref-in-batch") {
					const r = await attemptGit(["push", "-q", url, `${c1}:refs/heads/zz`], src)
					if (!r.ok) throw new Error(`setup push zz failed: ${r.stderr}`)
				}

				const projection = async (ref: string) => {
					const rows = await admin<{ path: string; mode: string; oid: string }[]>`
						select path, mode, encode(blob_oid, 'hex') as oid from repo_file
						where ref_name = ${ref}
							and repo_id = (select id from repos where name = ${repo})`
					return rows.map((r) => `${r.path}\0${r.mode}\0${r.oid}`).sort()
				}
				const refsBefore = refMapOf(
					(await spawnGit(["ls-remote", url], { cwd: src })).stdout,
				)
				const [stampBefore] = await admin<{ t: string }[]>`
					select last_pushed_at::text as t from repos where name = ${repo}`

				// Hold the row the post-CAS statement must write.
				let release: () => void = () => {}
				const held = new Promise<void>((r) => {
					release = r
				})
				const locker = admin.begin(async (tx) => {
					if (point === "A-post-commit-stamp") {
						await tx`select id from repos where name = ${repo} for update`
					} else {
						await tx`select oid from git_ref
							where name = 'refs/heads/zz'
								and repo_id = (select id from repos where name = ${repo}) for update`
					}
					await held
				})
				await sleep(150)

				const targeted =
					point === "A-post-commit-stamp"
						? ["refs/heads/main"]
						: ["refs/heads/main", "refs/heads/zz"]
				const args = ["push", url, ...targeted.map((t) => `${c2}:${t}`)]
				const push = await attemptGit(args, src)
				// Per-ref verdicts straight from the client's report-status echo.
				const rejectedRefs = [
					...push.stderr.matchAll(/\[remote rejected\] \S+ -> (\S+)/g),
				].map((m) => `refs/heads/${(m[1] as string).replace(/^refs\/heads\//, "")}`)
				release()
				await locker

				const refMap = refMapOf((await spawnGit(["ls-remote", url], { cwd: src })).stdout)
				const after = await projection("refs/heads/main")
				const [stampAfter] = await admin<{ t: string }[]>`
					select last_pushed_at::text as t from repos where name = ${repo}`

				const advanced = [...refMap.entries()]
					.filter(([n, o]) => refsBefore.get(n) !== o)
					.map(([n, o]) => `${n} ${refsBefore.get(n)?.slice(0, 8)}→${o.slice(0, 8)}`)
				const unchanged = [...refMap.entries()]
					.filter(([n, o]) => refsBefore.get(n) === o && n.startsWith("refs/heads/"))
					.map(([n, o]) => `${n}@${o.slice(0, 8)}`)

				if (push.ok) {
					// The push reported success — no torn state to observe at this point.
					results.push({
						advanced: [],
						cloneError: null,
						convergenceGap: null,
						point,
						projectionTorn: null,
						pushOk: true,
						pushTail: "",
						rejectedRefs,
						targeted,
						unchanged,
						watermarkLost: false,
					})
					continue
				}

				const projectionTorn =
					refMap.get("refs/heads/main") === c2 &&
					JSON.stringify(after) !== JSON.stringify(treeC2)
						? `refs/heads/main serves ${c2.slice(0, 8)} but repo_file still describes ${c1.slice(0, 8)}`
						: null
				const watermarkLost = stampAfter?.t === stampBefore?.t && advanced.length > 0

				// CONVERGENCE: retry, then gc + repack + a fresh clone.
				await attemptGit(args, src)
				await createGc(admin).gc(repo, { graceSeconds: 0, maintain: false })
				await createRepack(admin).repack(repo)
				const dest = join(root, `clone-${point}`)
				rmSync(dest, { force: true, recursive: true })
				const cl = await attemptGit([
					"-c",
					"protocol.version=2",
					"clone",
					"-q",
					url,
					dest,
				])
				let cloneError: string | null = null
				let convergenceGap: { clone: string[]; projection: string[] } | null = null
				if (!cl.ok) {
					cloneError = `clone failed after convergence attempt: ${cl.stderr.trim().slice(0, 200)}`
				} else {
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
					const cloneTree = await lsTreeSnapshot(dest, "HEAD")
					const finalProj = await projection("refs/heads/main")
					if (JSON.stringify(cloneTree) !== JSON.stringify(finalProj)) {
						convergenceGap = { clone: cloneTree, projection: finalProj }
					}
				}

				results.push({
					advanced,
					cloneError,
					convergenceGap,
					point,
					projectionTorn,
					pushOk: false,
					pushTail: push.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" | "),
					rejectedRefs,
					targeted,
					unchanged,
					watermarkLost,
				})
			} finally {
				await server.close()
				await appSql.end({ timeout: 5 }).catch(() => {})
			}
		}
	}, 600_000)

	afterAll(async () => {
		await admin?.end()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("exercised both post-CAS fault points", () => {
		expect(results.map((r) => r.point)).toEqual([...FAULT_POINTS])
	})

	it("the per-ref report is truthful: rejected refs stayed put, accepted refs moved", () => {
		// A non-atomic multi-ref push MAY partially apply — that is canonical git
		// (per-ref ok/ng, exit 1 when any ref fails). The tear this file pins is the
		// REPORT LYING: a ref that moved with no ok line, or an unmoved targeted ref
		// with no ng line (the pre-fix behavior: a post-CAS throw became an HTTP 500
		// with refs already moved and nothing reported at all).
		expect(
			results
				.filter((r) => !r.pushOk)
				.flatMap((r) => {
					const advancedNames = r.advanced
						.map((a) => a.split(" ")[0] as string)
						.filter((n) => n.startsWith("refs/heads/"))
					const unmovedNames = r.unchanged.map((u) => u.split("@")[0] as string)
					const lies: string[] = []
					for (const n of advancedNames) {
						if (r.rejectedRefs.includes(n)) {
							lies.push(`${r.point}: ${n} was reported REJECTED but the server moved it`)
						}
					}
					for (const n of r.targeted) {
						if (unmovedNames.includes(n) && !r.rejectedRefs.includes(n)) {
							lies.push(
								`${r.point}: ${n} did not move but the push never reported it rejected ("${r.pushTail}")`,
							)
						}
					}
					return lies
				}),
		).toEqual([])
	})

	it("the repo_file projection never describes a superseded tip", () => {
		expect(
			results
				.filter((r) => r.projectionTorn !== null)
				.map((r) => `${r.point} — projection torn: ${r.projectionTorn}`),
		).toEqual([])
	})

	it("a ref move always stamps the GC activity watermark", () => {
		expect(
			results
				.filter((r) => r.watermarkLost)
				.map(
					(r) =>
						`${r.point}: the ref move orphaned the previous tip's objects, but repos.last_pushed_at is unchanged`,
				),
		).toEqual([])
	})

	it("a retry + gc + repack converges the read surface onto a fresh clone", () => {
		expect(
			results.filter((r) => r.cloneError).map((r) => `${r.point}: ${r.cloneError}`),
		).toEqual([])
		expect(
			results
				.filter((r) => r.convergenceGap !== null)
				.map(
					(r) =>
						`${r.point} — NO CONVERGENCE: after retry + gc + repack, repo_file still disagrees with a fresh clone's worktree — clone: ${JSON.stringify(r.convergenceGap?.clone)} repo_file: ${JSON.stringify(r.convergenceGap?.projection)}`,
				),
		).toEqual([])
	})
})

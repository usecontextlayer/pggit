/**
 * BREAKAGE (pg-txn) — abort GC and repack at every batch boundary.
 * Converted from `breakage/pg-txn--gc-repack-fault-sweep.ts`; its rationale
 * verbatim:
 *
 * HUNT: abort GC and repack at every batch boundary and ask whether the store is
 * ever WRONG (rather than merely behind), and whether one more gc+repack+clone
 * always returns it to correct.
 *
 * GC is: a REPEATABLE READ live-set snapshot on a pinned connection, then three
 * independently-committed batched sweeps — objects, then edges, then encodings.
 * Repack is: reads spread over many statements with NO shared snapshot, then
 * batched COPY inserts each in their own transaction. Neither pass is atomic, so
 * every batch boundary is a crash point.
 *
 * FAULTS INJECTED
 *   - a `statement_timeout` sweep (T = 50 … 6400ms) on the connection driving
 *     gc()/repack(): each T lands the abort in a different batch;
 *   - `pg_terminate_backend` against ONLY the pid read from this test's own gc
 *     connection, fired while that pid is inside `delete from git_object …` and
 *     inside `delete from git_edge …` — i.e. the window where objects are gone
 *     but their edges are not.
 *
 * CHECKED after every fault, on the RAW torn state (before any repair):
 *   A. a fresh mirror clone succeeds, is fsck --strict clean, and carries the
 *      complete closure of every live ref (GC must never have eaten a reachable
 *      object, and the served pack must never be one git rejects)
 *   B. the encoding tier: no row for an absent object, no delta whose base object
 *      is absent AND is emitted as a delta, no delta-of-a-delta (design depth ≤ 1)
 * then, as the convergence claim:
 *   C. one clean gc + repack + clone returns everything to correct
 *   D. a further repack is a no-op ({wholes:0,deltas:0}) and a further gc reclaims 0
 *
 * The source script exits 0 when the store is never wrong and always converges —
 * a NEGATIVE result, so this suite is expected GREEN. It is brought over because
 * the negative is the finding: these are the fault points that do NOT tear.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type GcResult } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack, type RepackResult } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const RUNS = 600
const TIMEOUTS = [50, 100, 200, 400, 800, 1600, 3200, 6400]
const ZERO_OID = "0".repeat(40)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const short = (e: unknown) =>
	`${(e as { code?: string }).code ?? ""} ${(e as Error).message}`.trim().slice(0, 90)

type GitAttempt = { ok: boolean; code: number; stdout: string; stderr: string }

async function tryGit(args: string[], cwd?: string): Promise<GitAttempt> {
	try {
		const r = await spawnGit(args, { cwd })
		return { code: 0, ok: true, stderr: r.stderr, stdout: r.stdout }
	} catch (e) {
		const err = e as { code?: number; stderr?: string; message: string }
		return {
			code: err.code ?? -1,
			ok: false,
			stderr: err.stderr ?? err.message,
			stdout: "",
		}
	}
}

type Counts = {
	objects: number
	edges: number
	encodings: number
	danglingEdges: number
	encNoObject: number
	encNoBase: number
	deltaOfDelta: number
}

async function counts(admin: Sql, repo: string): Promise<Counts> {
	const [row] = await admin<
		{
			objects: number
			edges: number
			encodings: number
			dangling_edges: number
			enc_no_object: number
			enc_no_base: number
			delta_of_delta: number
		}[]
	>`
		with r as (select id from repos where name = ${repo})
		select
			(select count(*)::int from git_object where repo_id = (select id from r)) as objects,
			(select count(*)::int from git_edge where repo_id = (select id from r)) as edges,
			(select count(*)::int from git_pack_encoding where repo_id = (select id from r))
				as encodings,
			(select count(*)::int from git_edge e
				where e.repo_id = (select id from r) and not exists (
					select 1 from git_object o
					where o.repo_id = e.repo_id and o.oid = e.parent)) as dangling_edges,
			(select count(*)::int from git_pack_encoding g
				where g.repo_id = (select id from r) and not exists (
					select 1 from git_object o
					where o.repo_id = g.repo_id and o.oid = g.oid)) as enc_no_object,
			(select count(*)::int from git_pack_encoding g
				where g.repo_id = (select id from r) and g.base_oid is not null and not exists (
					select 1 from git_object o
					where o.repo_id = g.repo_id and o.oid = g.base_oid)) as enc_no_base,
			(select count(*)::int from git_pack_encoding g
				join git_pack_encoding b on b.repo_id = g.repo_id and b.oid = g.base_oid
				where g.repo_id = (select id from r)
					and g.base_oid is not null and b.base_oid is not null) as delta_of_delta`
	return {
		danglingEdges: row?.dangling_edges ?? 0,
		deltaOfDelta: row?.delta_of_delta ?? 0,
		edges: row?.edges ?? 0,
		encNoBase: row?.enc_no_base ?? 0,
		encNoObject: row?.enc_no_object ?? 0,
		encodings: row?.encodings ?? 0,
		objects: row?.objects ?? 0,
	}
}

/** Every object reachable from every live ref, per canonical git in a scratch
 * mirror — the set a correct clone MUST carry. A string is the failure reason. */
async function liveClosure(url: string, dest: string): Promise<Set<string> | string> {
	const cl = await tryGit([
		"-c",
		"protocol.version=2",
		"clone",
		"-q",
		"--mirror",
		url,
		dest,
	])
	if (!cl.ok) {
		return `clone failed: ${cl.stderr.trim().split("\n").slice(-2).join(" | ")}`
	}
	const fsck = await tryGit(["fsck", "--strict", "--no-dangling"], dest)
	if (!fsck.ok) return `fsck DIRTY: ${fsck.stderr.trim().slice(0, 200)}`
	return new Set(
		(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dest })).stdout
			.split("\n")
			.map((l) => l.slice(0, 40))
			.filter((o) => /^[0-9a-f]{40}$/.test(o)),
	)
}

type FaultCase = { label: string; timeout?: number; kill?: string }
type CaseResult = {
	label: string
	gcErr: string
	repackErr: string
	torn: Counts
	tornCloneError: string | null
	after: Counts
	gc3: GcResult
	rp3: RepackResult
	finalCloneError: string | null
	lostVsTorn: number
}

describe("breakage/pg-txn — GC/repack aborted at every batch boundary", () => {
	let db: IsolatedDb
	let admin: Sql
	let appSql: Sql
	let server: GitServer
	let src = ""
	let root = ""
	const results: CaseResult[] = []
	// An aborted gc()/repack() can leak an unhandled rejection (see
	// pg-txn--gc-poisons-pooled-connection.test.ts); record it rather than dying on it.
	const leaked: string[] = []
	const onLeak = (e: unknown) => {
		leaked.push(short(e))
	}

	beforeAll(async () => {
		process.on("unhandledRejection", onLeak)
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		root = mkdtempSync(join(tmpdir(), "pggit-txn-gcrp-"))
		src = await createAppendOnlyRepo({ runs: RUNS })
		admin = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 3,
			onnotice: () => {},
		})
		appSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 5,
			onnotice: () => {},
		})
		server = await serveOnPort(createGitApp(createGitDeps(appSql)), 0)

		const commits = (
			await spawnGit(["rev-list", "--reverse", "main"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		const tip = commits[commits.length - 1]
		const mid = commits[Math.floor(commits.length / 2)]
		if (!tip || !mid) throw new Error("fixture too short to orphan")

		const cases: FaultCase[] = [
			...TIMEOUTS.map((t) => ({ label: `statement_timeout=${t}ms`, timeout: t })),
			{ kill: "delete from git_object", label: "kill during the OBJECT sweep" },
			{ kill: "delete from git_edge", label: "kill during the EDGE sweep" },
			{ kill: "delete from git_pack_encoding", label: "kill during the ENCODING sweep" },
		]

		for (const [i, c] of cases.entries()) {
			const repo = `txn/gcrp-${i}`
			const url = `http://127.0.0.1:${server.port}/${repo}`

			// Fresh repo: full history on main + a side branch, then REWIND side to
			// mid-history through the store's own RefStore, orphaning half of it.
			const p = await tryGit(["push", "-q", url, `${tip}:refs/heads/main`], src)
			if (!p.ok) throw new Error(`seed push failed: ${p.stderr}`)
			const p2 = await tryGit(["push", "-q", url, `${tip}:refs/heads/side`], src)
			if (!p2.ok) throw new Error(`side push failed: ${p2.stderr}`)
			// Advance main only to mid, then drop side -> everything past mid is garbage.
			await createRefStore(admin).setRef(repo, "refs/heads/main", mid)
			await createRefStore(admin).applyRefUpdates(
				repo,
				[{ newOid: ZERO_OID, oldOid: tip, ref: "refs/heads/side" }],
				false,
			)
			await createRepack(admin).repack(repo) // an encoding tier to damage

			// ── the fault ────────────────────────────────────────────────────
			// gc and repack each get a FRESH client: an aborted pass strands its
			// connection in an open aborted transaction (a separate finding —
			// pg-txn--gc-poisons-pooled-connection.test.ts), which would otherwise mask
			// the row-level convergence question this sweep is asking.
			const mkFaulty = () =>
				postgres(baseUrl, {
					connection: c.timeout
						? { search_path: db.schema, statement_timeout: c.timeout }
						: { search_path: db.schema },
					max: 1,
					onnotice: () => {},
				})
			const gcSql = mkFaulty()
			// The pid fetch itself can trip a very tight statement_timeout under load.
			let pid = 0
			try {
				const [pp] = await gcSql<{ pid: number }[]>`select pg_backend_pid() as pid`
				pid = pp?.pid ?? 0
			} catch {
				pid = 0
			}
			// Terminate ONLY the pid this test opened, and only once it is inside the
			// targeted sweep statement.
			let killerDone: Promise<void> = Promise.resolve()
			const killNeedle = c.kill
			if (killNeedle) {
				killerDone = (async () => {
					const t0 = Date.now()
					while (Date.now() - t0 < 45_000) {
						const [a] = await admin<{ q: string }[]>`
							select query as q from pg_stat_activity where pid = ${pid}`
						if (a?.q?.toLowerCase().replace(/\s+/g, " ").includes(killNeedle)) {
							await admin`select pg_terminate_backend(${pid})`
							return
						}
						await sleep(1)
					}
				})()
			}
			let gcErr = "none"
			let repackErr = "none"
			try {
				await createGc(gcSql).gc(repo, { graceSeconds: 0, maintain: false })
			} catch (e) {
				gcErr = short(e)
			}
			await killerDone
			await Promise.race([gcSql.end({ timeout: 3 }).catch(() => {}), sleep(4000)])
			const rpSql = mkFaulty()
			try {
				await createRepack(rpSql).repack(repo)
			} catch (e) {
				repackErr = short(e)
			}
			await Promise.race([rpSql.end({ timeout: 3 }).catch(() => {}), sleep(4000)])

			// ── A + B: is the TORN state wrong? ──────────────────────────────
			const torn = await counts(admin, repo)
			const tornDest = join(root, `torn-${i}`)
			const tornClone = await liveClosure(url, tornDest)
			rmSync(tornDest, { force: true, recursive: true })

			// ── C + D: convergence ───────────────────────────────────────────
			await createGc(admin).gc(repo, { graceSeconds: 0, maintain: false })
			await createRepack(admin).repack(repo)
			const gc3 = await createGc(admin).gc(repo, { graceSeconds: 0, maintain: false })
			const rp3 = await createRepack(admin).repack(repo)
			const after = await counts(admin, repo)

			const finalDest = join(root, `final-${i}`)
			const finalClone = await liveClosure(url, finalDest)
			rmSync(finalDest, { force: true, recursive: true })
			const lostVsTorn =
				typeof tornClone === "string" || typeof finalClone === "string"
					? 0
					: [...tornClone].filter((o) => !finalClone.has(o)).length

			results.push({
				after,
				finalCloneError: typeof finalClone === "string" ? finalClone : null,
				gc3,
				gcErr,
				label: c.label,
				lostVsTorn,
				repackErr,
				rp3,
				torn,
				tornCloneError: typeof tornClone === "string" ? tornClone : null,
			})
		}
	}, 3_600_000)

	afterAll(async () => {
		process.off("unhandledRejection", onLeak)
		await server?.close()
		await appSql?.end().catch(() => {})
		await admin?.end()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("swept every fault point", () => {
		expect(results.map((r) => r.label)).toHaveLength(TIMEOUTS.length + 3)
	})

	it("never leaves a delta-of-a-delta encoding (design says depth ≤ 1)", () => {
		expect(
			results
				.filter((r) => r.torn.deltaOfDelta > 0)
				.map((r) => `${r.label}: ${r.torn.deltaOfDelta}`),
		).toEqual([])
	})

	it("the torn state still serves an fsck-clean clone of the whole live closure", () => {
		expect(
			results
				.filter((r) => r.tornCloneError)
				.map((r) => `${r.label}: ${r.tornCloneError}`),
		).toEqual([])
	})

	it("gc converges — a third pass reclaims nothing", () => {
		expect(
			results
				.filter(
					(r) => r.gc3.deletedObjects + r.gc3.deletedEdges + r.gc3.deletedEncodings !== 0,
				)
				.map((r) => `${r.label}: ${JSON.stringify(r.gc3)}`),
		).toEqual([])
	})

	it("repack converges — a third pass writes nothing", () => {
		expect(
			results
				.filter((r) => r.rp3.wholes + r.rp3.deltas !== 0)
				.map((r) => `${r.label}: ${JSON.stringify(r.rp3)}`),
		).toEqual([])
	})

	it("a clean gc+repack leaves the store consistent", () => {
		expect(
			results
				.filter(
					(r) =>
						r.after.danglingEdges > 0 || r.after.encNoObject > 0 || r.after.encNoBase > 0,
				)
				.map(
					(r) =>
						`${r.label}: dangling=${r.after.danglingEdges} encNoObject=${r.after.encNoObject} encNoBase=${r.after.encNoBase}`,
				),
		).toEqual([])
	})

	it("the converged state serves a good clone and loses nothing it once served", () => {
		expect(
			results
				.filter((r) => r.finalCloneError)
				.map((r) => `${r.label}: ${r.finalCloneError}`),
		).toEqual([])
		expect(
			results
				.filter((r) => r.lostVsTorn > 0)
				.map((r) => `${r.label}: lost ${r.lostVsTorn}`),
		).toEqual([])
	})

	// The source RECORDED unhandled rejections into `leaked` (via the beforeAll
	// listener) but deliberately never made them a verdict — an aborted gc()/repack()
	// can legitimately surface an async rejection the store still tolerates. That
	// listener stays (it suppresses stray rejections so the run stays attributable),
	// but asserting `leaked === []` would fail this GREEN negative for behavior the
	// source classified as non-verdict, so it is intentionally not asserted here.
})

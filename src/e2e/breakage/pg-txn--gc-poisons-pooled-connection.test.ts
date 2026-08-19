/**
 * BREAKAGE (pg-txn) — an aborted GC walk poisons the pooled connection.
 * Converted from `breakage/pg-txn--gc-poisons-pooled-connection.ts`; its rationale
 * verbatim:
 *
 * FINDING: an aborted GC live-set walk PERMANENTLY POISONS the pooled connection
 * it borrowed — it is released back into the pool still inside an open, aborted
 * REPEATABLE READ transaction. Every later user of that connection fails with
 * `25P02 current transaction is aborted, commands ignored until end of
 * transaction block`, forever, and if the pool is shared with the git app that
 * means clones and pushes fail.
 *
 * `store/gc.ts liveSet()` pins one connection for the multi-statement closure
 * walk (it must: the walk needs ONE MVCC snapshot):
 *
 *     const conn = await pg.reserve()
 *     try {
 *       await conn`begin isolation level repeatable read`
 *       …
 *       await conn`commit`          // ← only reached on the happy path
 *       return present
 *     } finally {
 *       conn.release()              // ← no ROLLBACK on the error path
 *     }
 *
 * `postgres`'s `reserve()/release()` does not reset session state, so any failure
 * between the BEGIN and the COMMIT — a `statement_timeout`, a `lock_timeout`, a
 * cancel, an OOM, a malformed object thrown out of the tree walk — leaks an open
 * aborted transaction into the pool. Nothing in pggit ever rolls it back.
 *
 * Three consequences, all pinned below (mechanism as ORIGINALLY found — the fix
 * reshaped gc onto a reserved connection with an in-try ROLLBACK, D12, so the
 * specific `gc_live_<id>` finally-drop named here no longer exists; the test now
 * pins that the poisoning CANNOT recur):
 *   1. the very error the operator sees was WRONG: the cleanup drop ran on the
 *      poisoned connection and its 25P02 REPLACED the real cause, so the log said
 *      "current transaction is aborted" and never mentioned the timeout;
 *   2. GC is dead from then on — every subsequent pass that lands on that
 *      connection fails the same way, and the drain has a pool of only
 *      `concurrency + 1` connections to lose (`server.ts`);
 *   3. on a shared pool — the natural composition for a host that mounts
 *      `createGitApp(createGitDeps(pg))` and starts `createGcScheduler(pg)` over
 *      the same client — ordinary CLONES AND PUSHES start failing, intermittently,
 *      with a Postgres error that has nothing to do with what they were doing.
 *
 * It never converges: no gc, repack, or clone repairs it, because the damage is
 * session state in a live connection, not rows. Only a process restart (or pool
 * recycle) clears it.
 *
 * FAULT INJECTED: a `statement_timeout` abort of the closure walk — set as a
 * connection parameter on the test's own pool. No pggit code is modified. The
 * deterministic producer of the abort is ordinary lock contention on `git_ref` (a
 * REINDEX, a VACUUM FULL, a migration, or gc's own `maintain()` all take
 * conflicting locks) meeting that statement_timeout.
 *
 * THE CONTRACT, in order: the fault fires at all (the walk aborts with 57014, a
 * cancelled statement — everything after it is vacuous over an undisturbed pool),
 * gc reports that REAL cause rather than a 25P02 from its own cleanup, the
 * borrowed connection returns to the pool with no open transaction, gc and repack
 * keep working on that pool, ordinary clones through it are untouched, and a clean
 * gc+repack leaves it serving.
 *
 * Originated as breakage probe `pg-txn--gc-poisons-pooled-connection.ts`, which
 * reproduced the poisoning (exit non-zero); fixed by reshaping gc onto a reserved
 * connection with an in-try ROLLBACK (D12).
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const RUNS = 700
const PROBES = 8
const REPO = "txn/poison"
/** Tags the shared pool's backends, so `pg_stat_activity` reads only our own. */
const appName = `pggit-poison-${randomUUID().slice(0, 8)}`

const short = (e: unknown) =>
	`${(e as { code?: string }).code ?? ""} ${(e as Error).message}`.trim().slice(0, 110)

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

describe("breakage/pg-txn — an aborted GC pass must not poison its pool", () => {
	let db: IsolatedDb
	let admin: Sql
	let shared: Sql
	let server: GitServer
	let src = ""
	let root = ""

	let gcErr = "none"
	let strandedState: string | null = null
	let secondGcErr = "none"
	let repackErr = "none"
	let brokenProbes = 0
	let probeMessages: string[] = []
	let freshPoolErr: string | null = null
	let stillBrokenProbes = 0

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		root = mkdtempSync(join(tmpdir(), "pggit-txn-poison-"))
		src = await createAppendOnlyRepo({ runs: RUNS })
		admin = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 2,
			onnotice: () => {},
		})

		// THE SHARED POOL: one `Sql` behind BOTH the git app and the GC — the natural
		// composition for a host that mounts createGitApp and runs its own scheduler.
		// `statement_timeout` is the abort lever; it is a normal server-side setting
		// (Azure Postgres and pgbouncer deployments commonly set one).
		// `application_name` tags the shared pool's backends so the idle-in-transaction
		// probe below reads only connections THIS test opened — the source script had a
		// container to itself; here the globalSetup container is shared with every
		// other test file.
		shared = postgres(baseUrl, {
			connection: {
				application_name: appName,
				search_path: db.schema,
				statement_timeout: 1200,
			},
			max: 2,
			onnotice: () => {},
		})
		server = await serveOnPort(createGitApp(createGitDeps(shared)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		// Seed through a HEALTHY pool so the setup is not itself timing out.
		const seedSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 4,
			onnotice: () => {},
		})
		const seedServer = await serveOnPort(createGitApp(createGitDeps(seedSql)), 0)
		const seeded = await tryGit(
			[
				"push",
				"-q",
				`http://127.0.0.1:${seedServer.port}/${REPO}`,
				"refs/heads/main:refs/heads/main",
			],
			src,
		)
		if (!seeded.ok) throw new Error(`seed push failed: ${seeded.stderr}`)
		await createRepack(seedSql).repack(REPO)
		await seedServer.close()
		await seedSql.end()

		// Baseline: the shared pool serves a clone fine before the fault.
		const base = join(root, "base")
		const baseline = await tryGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			"--mirror",
			url,
			base,
		])
		if (!baseline.ok) {
			throw new Error(
				`baseline clone failed — the timeout is too tight for this repo size: ${baseline.stderr.trim().slice(0, 200)}`,
			)
		}
		rmSync(base, { force: true, recursive: true })

		// ── FAULT POINT: an abort INSIDE gc()'s REPEATABLE READ transaction ──
		let release: () => void = () => {}
		const held = new Promise<void>((r) => {
			release = r
		})
		const locker = admin.begin(async (tx) => {
			await tx`lock table git_ref in access exclusive mode`
			await held
		})
		await new Promise((r) => setTimeout(r, 200))
		try {
			await createGc(shared).gc(REPO, { graceSeconds: 0, maintain: false })
		} catch (e) {
			gcErr = short(e)
		}
		release()
		await locker

		// 1. is a connection sitting in an aborted transaction?
		const stuck = await admin<{ pid: number; state: string; q: string }[]>`
			select pid, state, left(query, 60) as q from pg_stat_activity
			where datname = current_database()
				and application_name = ${appName}
				and state like 'idle in transaction%'`
		strandedState = stuck.find((s) => s.state.includes("aborted"))?.state ?? null

		// 2. is GC itself dead now?
		try {
			await createGc(shared).gc(REPO, { graceSeconds: 0, maintain: false })
		} catch (e) {
			secondGcErr = short(e)
		}
		try {
			await createRepack(shared).repack(REPO)
		} catch (e) {
			repackErr = short(e)
		}

		// 3. do ordinary git operations through the shared pool now fail?
		const seen = new Set<string>()
		for (let i = 0; i < PROBES; i++) {
			const dest = join(root, `probe-${i}`)
			const c = await tryGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--mirror",
				url,
				dest,
			])
			if (!c.ok) {
				brokenProbes++
				seen.add(
					c.stderr.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 90) ?? "",
				)
			}
			rmSync(dest, { force: true, recursive: true })
		}
		probeMessages = [...seen]

		// 4. convergence: nothing repairs it short of a new pool.
		const freshSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 4,
			onnotice: () => {},
		})
		try {
			await createGc(freshSql).gc(REPO, { graceSeconds: 0, maintain: false })
			await createRepack(freshSql).repack(REPO)
		} catch (e) {
			freshPoolErr = short(e)
		} finally {
			await freshSql.end().catch(() => {})
		}
		for (let i = 0; i < PROBES; i++) {
			const dest = join(root, `after-${i}`)
			const c = await tryGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--mirror",
				url,
				dest,
			])
			if (!c.ok) stillBrokenProbes++
			rmSync(dest, { force: true, recursive: true })
		}
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await shared?.end({ timeout: 5 }).catch(() => {})
		await admin?.end()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("the fault fired at all: the live-set walk was aborted mid-transaction", () => {
		// The barrier for everything below. If the `access exclusive` lock on git_ref
		// plus statement_timeout=1200 did not abort the walk, gc simply completed:
		// `strandedState` is null, no probe breaks, and all four tests below pass
		// having injected nothing.
		expect(
			gcErr,
			"the statement_timeout never aborted the live-set walk — nothing below is exercised",
		).not.toBe("none")
		expect(gcErr).toMatch(/57014|canceling statement/i)
	})

	it("reports the REAL cause of an aborted pass, not a 25P02 from its own cleanup", () => {
		const masked =
			gcErr.includes("25P02") || gcErr.includes("current transaction is aborted")
		expect(
			masked,
			`the error gc() reports is 25P02 from its own cleanup, NOT the real cause — the statement_timeout is invisible to the operator: "${gcErr}"`,
		).toBe(false)
	})

	it("releases the borrowed connection clean — no open aborted transaction in the pool", () => {
		expect(
			strandedState,
			`a pooled connection was released back into the pool in state "${strandedState}" — an open aborted transaction, holding a snapshot`,
		).toBeNull()
	})

	it("GC and repack still work on the same pool after an aborted pass", () => {
		expect(
			secondGcErr.includes("aborted"),
			`GC is dead: a fresh pass on the same pool fails with "${secondGcErr}"`,
		).toBe(false)
		expect(
			repackErr.includes("aborted"),
			`repack on the same pool fails with "${repackErr}"`,
		).toBe(false)
	})

	it("ordinary clones through the shared pool are untouched", () => {
		expect(
			brokenProbes,
			`${brokenProbes}/${PROBES} ordinary clones through the shared pool now fail — the aborted GC transaction leaked into request traffic: ${probeMessages.join(" | ")}`,
		).toBe(0)
	})

	it("a clean gc+repack converges the pool back to serving", () => {
		// The rows were always fine — a FRESH pool gc+repacks without complaint.
		expect(freshPoolErr, `even a fresh pool cannot gc/repack: ${freshPoolErr}`).toBeNull()
		expect(
			stillBrokenProbes,
			`NO CONVERGENCE: ${stillBrokenProbes}/${PROBES} clones still fail after gc+repack — the damage is live session state, not rows, so only a process restart clears it`,
		).toBe(0)
	})
})

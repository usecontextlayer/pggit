/**
 * BREAKAGE (pg-txn) — a cancelled ingest COPY hangs the push forever.
 * Converted from `breakage/pg-txn--copy-cancel-hangs-push-forever.ts`; its
 * rationale verbatim:
 *
 * FINDING: when Postgres cancels the COPY that `copy-insert.ts` is streaming, the
 * ingest promise NEVER SETTLES. The `git push` hangs forever with no error, the
 * HTTP handler never returns, and the pooled connection is stranded in an open
 * aborted transaction and never returned to the pool.
 *
 * `copyInsert` drives the COPY through a `writable()` stream:
 *
 *     await new Promise<void>((resolve, reject) => {
 *       writable.on("error", reject)
 *       writable.on("finish", () => resolve())
 *       writable.write(payload, (err) => { if (err) reject(err); else writable.end() })
 *     })
 *
 * A server-side cancel of the COPY (a `statement_timeout`, a `pg_cancel_backend`,
 * an admin cancel, a `lock_timeout`) makes the backend abort the transaction and
 * go to `idle in transaction (aborted)` waiting on Client — but `postgres@3.4.9`
 * emits NEITHER 'error' NOR 'finish' on that writable. The promise stays pending
 * for the life of the process. Every guard pggit has is downstream of a settled
 * promise, so none of them fire: no `pg.begin` rollback, no `unpack` error, no
 * `ng` line, no 500.
 *
 * The store stays CONSISTENT — no rows land, the transaction never commits — so
 * this is not corruption. It is an availability failure with no timeout anywhere:
 *   - `git push` blocks indefinitely (observed >9 minutes before being killed);
 *   - the Node handler never returns, so `server.close()` never resolves either
 *     (a clean SIGTERM shutdown hangs too);
 *   - the connection is stranded mid-transaction, so the pool loses it
 *     permanently — N such pushes take a `max: N` pool to zero and every later
 *     request queues forever.
 *
 * A `statement_timeout` is ordinary production configuration (Azure Postgres
 * deployments and pgbouncer front-ends commonly set one), and pggit's own ingest
 * COPY is the longest single statement it ever issues — exactly the statement a
 * timeout is most likely to hit.
 *
 * FAULT INJECTED: a `statement_timeout` on the server's own connection. No pggit
 * code is modified. (A `pg_cancel_backend` against the same pid does the same.)
 *
 * The source script exits non-zero when the hang reproduces; the assertions below
 * encode the CORRECT contract (the push settles, the connection comes back, the
 * pool keeps serving, shutdown completes), so a reproduction is a red test.
 */
import { spawn } from "node:child_process"
import { rmSync } from "node:fs"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { buildGitEnv } from "@/testing/spawn-git"

const RUNS = 700
const WAIT_S = 25
const REPO = "txn/copy-hang"

type BoundedGit = { settled: boolean; code: number | null; ms: number; out: string }

/** Run git with a hard wall-clock bound; report whether it settled on its own.
 * `spawnGit` cannot be used here — it waits for `close` forever, which is exactly
 * the failure mode under test. */
function gitBounded(args: string[], cwd: string, limitMs: number): Promise<BoundedGit> {
	return new Promise((resolve) => {
		const t0 = Date.now()
		const child = spawn("git", ["-c", "gc.auto=0", ...args], {
			cwd,
			env: buildGitEnv(),
		})
		let out = ""
		child.stdout.on("data", (d) => {
			out += d
		})
		child.stderr.on("data", (d) => {
			out += d
		})
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve({ code: null, ms: Date.now() - t0, out, settled: false })
		}, limitMs)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, ms: Date.now() - t0, out, settled: true })
		})
	})
}

describe("breakage/pg-txn — a cancelled ingest COPY must not hang the push", () => {
	let db: IsolatedDb
	let admin: Sql
	let appSql: Sql
	let server: GitServer
	let src = ""
	let pid = 0

	let push: BoundedGit
	let backendState = ""
	let backendQuery = ""
	let probe: BoundedGit
	let closed = false
	/** Diagnostic the source printed: nothing lands, so this is availability, not
	 * corruption. Kept as evidence, not as a verdict — a push that settles cleanly
	 * may legitimately land everything or nothing. */
	let storedObjects = 0
	let storedRefs = 0

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		src = await createAppendOnlyRepo({ runs: RUNS })
		admin = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 2,
			onnotice: () => {},
		})
		// The server's connection: max 1 so the capacity consequence is visible, with
		// an ordinary statement_timeout.
		appSql = postgres(baseUrl, {
			connection: { search_path: db.schema, statement_timeout: 500 },
			max: 1,
			onnotice: () => {},
		})
		const [p] = await appSql<{ pid: number }[]>`select pg_backend_pid() as pid`
		pid = p?.pid ?? 0
		server = await serveOnPort(createGitApp(createGitDeps(appSql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		// FAULT POINT: statement_timeout cancels the ingest COPY. The push is large
		// enough that its COPY outlives the timeout.
		push = await gitBounded(
			["push", url, "refs/heads/main:refs/heads/main"],
			src,
			WAIT_S * 1000,
		)

		const [act] = await admin<{ state: string; q: string }[]>`
			select state, left(query, 55) as q
			from pg_stat_activity where pid = ${pid}`
		backendState = act?.state ?? ""
		backendQuery = act?.q ?? ""

		const [rows] = await admin<{ n: number }[]>`
			select count(*)::int as n from git_object`
		storedObjects = rows?.n ?? 0
		storedRefs = (await admin<{ name: string }[]>`select name from git_ref`).length

		// The capacity consequence: the pool is gone, so every later request queues.
		probe = await gitBounded(["ls-remote", url], src, 10_000)

		// And a graceful shutdown cannot complete either.
		closed = await Promise.race([
			server.close().then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
		])
	}, 600_000)

	afterAll(async () => {
		// Teardown must not inherit the hang: the stranded backend holds locks that
		// would block `drop schema cascade` forever. Terminate ONLY the pid this test
		// opened, then tear down as the source script did.
		if (pid > 0) {
			await admin`select pg_terminate_backend(${pid})`.catch(() => {})
		}
		await Promise.race([
			appSql?.end({ timeout: 3 }).catch(() => {}),
			new Promise((r) => setTimeout(r, 4000)),
		])
		await admin?.end().catch(() => {})
		await db?.drop().catch(() => {})
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("the push settles instead of blocking forever with no output", () => {
		expect(
			push.settled,
			`git push produced NO output and NO error for ${WAIT_S}s — the ingest promise never settles, so nothing downstream (pg.begin rollback, unpack error, ng line, HTTP 500) ever fires; git said: ${push.out.trim().slice(-200)}`,
		).toBe(true)
	})

	it("the pooled connection is not stranded in an aborted transaction", () => {
		expect(
			backendState.includes("aborted"),
			`the server's only pooled connection is stranded in "${backendState}" on "${backendQuery}…" — never rolled back, never returned to the pool (store held ${storedObjects} git_object rows / ${storedRefs} refs at the time)`,
		).toBe(false)
	})

	it("an unrelated ls-remote through the same pool still answers", () => {
		expect(
			probe.settled,
			"an unrelated ls-remote also hangs — the stranded connection took the pool to zero and every later request queues forever",
		).toBe(true)
	})

	it("server.close() resolves — the process can still shut down cleanly", () => {
		expect(
			closed,
			"server.close() never resolves — the process cannot shut down cleanly either",
		).toBe(true)
	})
})

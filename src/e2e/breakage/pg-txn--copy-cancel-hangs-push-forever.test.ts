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
 * FAULT INJECTED: `pg_cancel_backend` against the server's own connection, fired
 * the moment that connection is inside the ingest COPY. No pggit code is modified.
 *
 * WHY NOT A `statement_timeout`, which is what the source script used and what the
 * paragraph above calls the realistic production trigger: a wall-clock timeout
 * cannot be AIMED. Measured on this fixture (RUNS=700), the whole push completes
 * in ~1.9 s and its COPY finishes far inside the 500 ms timeout the suite used to
 * set — so the fault never fired, the push exited 0, and every assertion below was
 * satisfied by a plainly successful push. Sizing the fixture until a COPY outlives
 * a fixed timeout would make the whole suite a hardware race. Polling
 * `pg_stat_activity` for the COPY itself lands the abort exactly where the finding
 * is, on any machine, and raises the SAME error class a timeout would (SQLSTATE
 * 57014, `canceling statement …`) — which is why the assertion accepts either
 * wording. `copyCancelled` is the barrier that keeps this honest.
 *
 * The source script exits non-zero when the hang reproduces; the assertions below
 * encode the CORRECT contract (the push settles and reports the cancel, the
 * connection comes back, the pool keeps serving, shutdown completes), so a
 * reproduction is a red test.
 */
import { rmSync } from "node:fs"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { type SpawnGitBoundedResult, spawnGitBounded } from "@/testing/spawn-git"

const RUNS = 700
const WAIT_S = 25
const REPO = "txn/copy-hang"
/**
 * The ingest COPY, as `pg_stat_activity.query` shows it. `copyInsert` stages into
 * `copy_stg_<target>`, and `git_object` is the largest target a push COPYs into —
 * but the staging table's NAME appears in three consecutive statements (the
 * `create temp table`, the COPY, then `insert into git_object … from copy_stg_…`),
 * and only the middle one is the finding's subject. The QUOTED form is what tells
 * them apart: `copyInto` interpolates the table through `sql(table)`, so the COPY
 * — and nothing around it — reads `copy "copy_stg_git_object" (…) from stdin`.
 * Measured on this fixture: the create is gone within ~2 ms (a cancel aimed at it
 * lands on an idle backend and does nothing, which is exactly how this suite first
 * came back with the fault "fired" and the push still exiting 0), while the COPY
 * itself stays active for a few hundred ms.
 */
const COPY_NEEDLE = 'copy "copy_stg_git_object"'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll `pid` until it is executing the ingest COPY, then cancel THAT statement;
 * report whether it ever fired. Bounded by `WAIT_S` so a push that never reaches
 * the COPY ends the watch instead of hanging the suite — and reports `false`, which
 * the barrier turns into a failure rather than a silent green. */
async function cancelIngestCopy(admin: Sql, pid: number): Promise<boolean> {
	const t0 = Date.now()
	while (Date.now() - t0 < WAIT_S * 1000) {
		const [act] = await admin<{ q: string }[]>`
			select query as q from pg_stat_activity where pid = ${pid} and state = 'active'`
		if (act?.q?.includes(COPY_NEEDLE)) {
			await admin`select pg_cancel_backend(${pid})`
			return true
		}
		await sleep(1)
	}
	return false
}

describe("breakage/pg-txn — a cancelled ingest COPY must not hang the push", () => {
	type BackendObservation =
		| { kind: "gone" }
		| { kind: "present"; state: string; query: string }
	let db: IsolatedDb
	let admin: Sql
	let appSql: Sql
	let server: GitServer
	let src = ""
	let pid: number

	let push: SpawnGitBoundedResult
	let copyCancelled = false
	let backend: BackendObservation
	let probe: SpawnGitBoundedResult
	let closed = false
	/** Diagnostic the source printed: nothing lands, so this is availability, not
	 * corruption. Kept as evidence, not as a verdict — the ingest runs in ONE
	 * transaction, so "the cancelled push stored nothing" restates the rollback
	 * rather than testing the settle behaviour this suite exists for. */
	let storedObjects: number
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
		// The server's connection: max 1 so the capacity consequence is visible, and so
		// the pid read here is the one the push will run on.
		appSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 1,
			onnotice: () => {},
		})
		const [p] = await appSql<{ pid: number }[]>`select pg_backend_pid() as pid`
		if (p === undefined) throw new Error("pg_backend_pid returned no row")
		pid = p.pid
		server = await serveOnPort(createGitApp(createGitDeps(appSql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		// FAULT POINT: the watcher cancels the ingest COPY as soon as the server is
		// inside it. Started BEFORE the push so it cannot miss a fast COPY.
		const watcher = cancelIngestCopy(admin, pid)
		push = await spawnGitBounded(
			["push", url, "refs/heads/main:refs/heads/main"],
			src,
			WAIT_S * 1000,
		)
		copyCancelled = await watcher

		const [act] = await admin<{ state: string; q: string }[]>`
			select state, left(query, 55) as q
			from pg_stat_activity where pid = ${pid}`
		backend =
			act === undefined
				? { kind: "gone" }
				: { kind: "present", query: act.q, state: act.state }

		const [rows] = await admin<{ n: number }[]>`
			select count(*)::int as n from git_object`
		if (rows === undefined) throw new Error("git_object count returned no row")
		storedObjects = rows.n
		storedRefs = (await admin<{ name: string }[]>`select name from git_ref`).length

		// The capacity consequence: the pool is gone, so every later request queues.
		probe = await spawnGitBounded(["ls-remote", url], src, 10_000)

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

	// The fault barrier. Everything below is a claim about how a CANCELLED COPY
	// settles; with no cancel they are all claims about a successful push, which is
	// how this suite ran green while proving nothing.
	it("the ingest COPY was actually cancelled", () => {
		expect(
			copyCancelled,
			`pid ${pid} was never observed inside \`${COPY_NEEDLE}\` within ${WAIT_S}s — the fault never fired, so every assertion below would be judging an ordinary successful push (git said: ${push.out.trim().slice(-200)})`,
		).toBe(true)
	})

	it("the push settles instead of blocking forever with no output", () => {
		expect(
			push.settled,
			`git push produced NO output and NO error for ${WAIT_S}s — the ingest promise never settles, so nothing downstream (pg.begin rollback, unpack error, ng line, HTTP 500) ever fires; git said: ${push.out.trim().slice(-200)}`,
		).toBe(true)
	})

	it("the push reports the cancel rather than exiting 0", () => {
		// A settled push is only half the contract: a cancelled ingest must reach the
		// client as a failure carrying the reason (receive-pack turns the ingest error
		// into its `unpack <status>` line), never as a success that silently stored
		// nothing. 57014 is worded "canceling statement due to …" whether the abort
		// came from a statement_timeout or a cancel request.
		if (!push.settled) {
			throw new Error(`git push did not settle: ${push.out.trim().slice(-300)}`)
		}
		expect(
			push.code,
			`git push exited 0 with the ingest COPY cancelled: ${push.out.trim().slice(-300)}`,
		).not.toBe(0)
		expect(push.out).toMatch(/statement timeout|canceling statement/i)
	})

	it("the pooled connection is not stranded in an aborted transaction", () => {
		const stranded = backend.kind === "present" && backend.state.includes("aborted")
		const observed =
			backend.kind === "gone"
				? "the original backend exited"
				: `backend is "${backend.state}" on "${backend.query}…"`
		expect(
			stranded,
			`the server's only pooled connection is stranded: ${observed} — never rolled back, never returned to the pool (store held ${storedObjects} git_object rows / ${storedRefs} refs at the time)`,
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

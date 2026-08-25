/**
 * Postgres transaction regression — a cancelled ingest COPY must not hang the push.
 *
 * A cancelled COPY must settle through the patched stream/final-error path so the
 * transaction can roll back, receive-pack can report the failure, the connection
 * can return to the pool, and server shutdown can complete.
 *
 * Server-side cancellation can come from `statement_timeout`, `pg_cancel_backend`,
 * an administrator, or `lock_timeout`. The patched postgres stream reports its
 * final error so every guard downstream of settlement can run.
 *
 * FAULT INJECTED: `pg_cancel_backend` against the server's own connection, fired
 * the moment that connection is inside the ingest COPY. No pggit code is modified.
 *
 * WHY NOT A `statement_timeout`: a wall-clock timeout cannot be AIMED. The COPY
 * may finish before the bound, satisfying every assertion with a successful push;
 * sizing it to outlive a fixed timeout would make the suite a hardware race. Polling
 * `pg_stat_activity` lands the abort at the COPY on any machine and raises the same
 * error class a timeout would (SQLSTATE
 * 57014, `canceling statement …`) — which is why the assertion accepts either
 * wording. `copyCancelled` is the barrier that keeps this honest.
 *
 * The assertions require the push to settle and report the cancellation, the
 * connection to return, the pool to keep serving, and shutdown to complete.
 */
import { rmSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { abortBackendWhenActive } from "@/testing/pg-fault"
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

describe("regressions/pg-txn — a cancelled ingest COPY must not hang the push", () => {
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
		const watcher = abortBackendWhenActive(
			admin,
			pid,
			{ kind: "cancel", needle: COPY_NEEDLE, skip: 0 },
			{ limitMs: WAIT_S * 1000 },
		)
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
		closed = await Promise.race([server.close().then(() => true), sleep(5000, false)])
	}, 600_000)

	afterAll(async () => {
		// Teardown must not inherit the hang: the stranded backend holds locks that
		// would block `drop schema cascade` forever. Terminate ONLY the pid this test
		// opened, then tear down.
		if (pid > 0) {
			await admin`select pg_terminate_backend(${pid})`.catch(() => {})
		}
		await Promise.race([appSql?.end({ timeout: 3 }).catch(() => {}), sleep(4000)])
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
		if (!probe.settled) throw new Error("ls-remote did not settle")
		expect(
			probe.code,
			`the pool answered, but ls-remote failed instead of serving normally: ${probe.out.trim().slice(-300)}`,
		).toBe(0)
	})

	it("server.close() resolves — the process can still shut down cleanly", () => {
		expect(
			closed,
			"server.close() never resolves — the process cannot shut down cleanly either",
		).toBe(true)
	})
})

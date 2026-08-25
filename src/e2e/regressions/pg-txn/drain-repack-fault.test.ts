/**
 * SCH-R6 (docs/2026-08-25-drain-repack-wiring.md) — repack failure isolation at
 * the DRAIN level. A repack phase killed mid-pass must: (a) surface as a drain
 * entry carrying the real GC result with `repack: null` — completed work is
 * reported, the failure lives in the log line; (b) leave `last_repack_at`
 * unstamped, so the union predicate re-selects the repo; and (c) let the NEXT
 * `drainOnce()` complete coverage over the torn tier — the committed flush
 * prefix is subtree-closed (repack's post-order emission), so the resumed walk
 * covers every hole. The retry-via-watermark mechanism itself is pinned by
 * SCH-R4; this file's unique content is the entry shape and recovery after a
 * MID-PASS death.
 *
 * The fault is AIMED, never timed (the gc-repack-fault-sweep lesson: timeout
 * rungs are a property of the machine, aimed cancels land identically anywhere):
 * a watcher polls `pg_stat_activity` for the drain connection's first statement
 * naming `copy_stg_git_pack_encoding` — copyInsert's staging table, so the
 * needle matches all three statements of every encoding flush transaction
 * (create-temp, COPY, insert) and nothing else the drain runs — and
 * `pg_cancel_backend`s it. That flush rolls back, earlier flushes stay
 * committed, and repack throws into the drain's per-phase catch. Vacuousness is
 * LOUD by construction: a missed aim lets repack complete, the entry then
 * carries `repack: {…}`, and the assertion fails naming the miss — this file
 * can never go green over an untorn store. Solo placement (vitest.config.ts):
 * the aim targets sub-second statement windows that parallel load makes
 * unhittable.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGcScheduler, type DrainEntry } from "@/store/gc-scheduler"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { encodingViolations, repoRepackStamp } from "@/testing/gc-helpers"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const RUNS = 600
const REPO = "txn/drain-repack-fault"
const COPY_NEEDLE = "copy_stg_git_pack_encoding"
const AIM_TIMEOUT_MS = 45_000

/** Poll ONE pid until it is inside repack's COPY staging work, then cancel that statement. Bounded;
 * `stop.now` ends the watch the moment the drain settles, so a miss costs one
 * poll — and reports false, which the entry-shape assertion turns into a loud
 * failure instead of a vacuous pass. */
async function cancelRepackCopyWhenActive(
	admin: Sql,
	pid: number,
	stop: { now: boolean },
): Promise<boolean> {
	const t0 = Date.now()
	while (!stop.now && Date.now() - t0 < AIM_TIMEOUT_MS) {
		const [act] = await admin<{ q: string }[]>`
			select query as q from pg_stat_activity
			where pid = ${pid} and state = 'active'`
		if (act?.q.toLowerCase().replace(/\s+/g, " ").includes(COPY_NEEDLE)) {
			await admin`select pg_cancel_backend(${pid})`
			return true
		}
		await sleep(1)
	}
	return false
}

describe("regressions/pg-txn — the drain isolates a repack killed mid-pass (SCH-R6)", () => {
	let db: IsolatedDb
	let admin: Sql
	let appSql: Sql
	let drainSql: Sql
	let server: GitServer
	let src = ""
	let root = ""

	let aimHit = false
	let firstEntry: DrainEntry | undefined
	let stampAfterFault: Date | null = null
	let violationsAfterFault: string[] = []
	let secondEntry: DrainEntry | undefined
	let violationsAfterRecovery: string[] = []
	let stampAfterRecovery: Date | null = null
	let thirdSummaryRepos: string[] = []
	let finalClone: TestResult<void>

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		root = mkdtempSync(join(tmpdir(), "pggit-drain-rp-fault-"))
		src = await createAppendOnlyRepo({ runs: RUNS })
		admin = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 2,
			onnotice: () => {},
		})
		appSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 5,
			onnotice: () => {},
		})
		server = await serveOnPort(createGitApp(createGitDeps(appSql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		const commits = await commitsOldestFirst(src, "main")
		const tip = commits[commits.length - 1]
		if (!tip) throw new Error("fixture produced no commits")
		await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })

		// max: 1 — every drain statement (both phases) runs on ONE backend, so the
		// watcher's pid is deterministic. Both primitives are proven on max:1
		// clients by the gc-repack-fault-sweep fixture.
		drainSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 1,
			onnotice: () => {},
		})
		const scheduler = createGcScheduler(drainSql, {
			concurrency: 1,
			graceSeconds: 0,
			intervalMs: 30_000,
			repackEnabled: true,
		})

		// ── pass 1: GC completes, the aimed cancel kills repack mid-COPY ──────
		const [pidRow] = await drainSql<{ pid: number }[]>`select pg_backend_pid() as pid`
		if (pidRow === undefined) throw new Error("pg_backend_pid returned no row")
		const stop = { now: false }
		const aimed = cancelRepackCopyWhenActive(admin, pidRow.pid, stop)
		const first = await scheduler.drainOnce()
		stop.now = true
		aimHit = await aimed
		firstEntry = first.find((e) => e.repo === REPO)
		stampAfterFault = await repoRepackStamp({ sql: admin }, REPO)
		violationsAfterFault = await encodingViolations({ sql: admin }, REPO)

		// ── pass 2: recovery — the union re-selects the repo on the repack arm ─
		const second = await scheduler.drainOnce()
		secondEntry = second.find((e) => e.repo === REPO)
		violationsAfterRecovery = await encodingViolations({ sql: admin }, REPO)
		stampAfterRecovery = await repoRepackStamp({ sql: admin }, REPO)

		// ── pass 3: both watermarks caught up — the repo is no longer selected ─
		thirdSummaryRepos = (await scheduler.drainOnce()).map((e) => e.repo)

		const dest = join(root, "final")
		finalClone = await captureTestResult(async () => {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
		})
		rmSync(dest, { force: true, recursive: true })
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await drainSql?.end()
		await appSql?.end()
		await admin?.end()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("the faulted pass reports the real GC result with repack: null", () => {
		if (firstEntry === undefined) throw new Error(`faulted drain omitted ${REPO}`)
		if (firstEntry.gc === null) {
			throw new Error(`faulted drain entry carries no GC result`)
		}
		expect(firstEntry.gc.settled).toBe(true)
		// THE BARRIER: a non-null repack here means the aimed cancel missed and the
		// pass completed — this file's whole subject (a torn tier) never existed.
		if (firstEntry.repack !== null) {
			throw new Error(
				`the aimed cancel missed (aimHit=${aimHit}): repack completed ${JSON.stringify(firstEntry.repack)} — nothing was torn, the case is vacuous; raise RUNS or investigate load`,
			)
		}
		expect(aimHit).toBe(true)
	})

	it("the failed phase leaves its watermark behind, with the tier genuinely torn", () => {
		expect(stampAfterFault).toBeNull()
		// Coverage holes are what pass 2 exists to repair. (The committed flush
		// prefix MAY be empty if the cancel landed in the very first COPY — holes
		// are guaranteed either way, a nonempty prefix is not.)
		expect(violationsAfterFault.length).toBeGreaterThan(0)
	})

	it("the next drain completes coverage on the repack arm alone", () => {
		if (secondEntry === undefined) throw new Error(`recovery drain omitted ${REPO}`)
		expect(secondEntry.gc).toBeNull() // settled in pass 1; nothing re-pushed
		if (secondEntry.repack === null) {
			throw new Error(`recovery entry carries no repack result`)
		}
		expect(secondEntry.repack.wholes + secondEntry.repack.deltas).toBeGreaterThan(0)
		expect(violationsAfterRecovery).toEqual([])
		expect(stampAfterRecovery).not.toBeNull()
	})

	it("a third drain omits the repo, and the recovered repo serves a clean clone", () => {
		expect(thirdSummaryRepos).not.toContain(REPO)
		expect(finalClone.kind, testResultContext(finalClone, "final clone")).toBe(
			"succeeded",
		)
	})
})

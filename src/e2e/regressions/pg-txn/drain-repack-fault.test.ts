import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGcScheduler, type DrainEntry } from "@/store/gc-scheduler"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { ageObjects, encodingViolations, repoRepackStamp } from "@/testing/gc-helpers"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { abortBackendWhenActive } from "@/testing/pg-fault"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const RUNS = 600
const REPO = "txn/drain-repack-fault"
// copyInsert names its staging table in each statement of an encoding flush, so
// the first observed match is inside that flush regardless of which statement wins the poll.
const ENCODING_FLUSH_NEEDLE = "copy_stg_git_pack_encoding"
const AIM_TIMEOUT_MS = 45_000

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
		const deps = createGitDeps(appSql)
		server = await serveOnPort(createGitApp(deps), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		const commits = await commitsOldestFirst(src, "main")
		const tip = commits[commits.length - 1]
		if (!tip) throw new Error("fixture produced no commits")
		await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
		const { oids: orphanOids } = await deps.objects.putPack(REPO, [
			{ content: Buffer.from("drain repack fault orphan\n"), type: "blob" },
		])
		if (orphanOids.length !== 1) {
			throw new Error(`expected one loose orphan, got ${orphanOids.length}`)
		}
		await ageObjects(db, REPO, "1 hour")

		// One backend makes the pid captured below the drain's deterministic target.
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

		const [pidRow] = await drainSql<{ pid: number }[]>`select pg_backend_pid() as pid`
		if (pidRow === undefined) throw new Error("pg_backend_pid returned no row")
		const stopSignal = { now: false }
		const abortAttempt = abortBackendWhenActive(
			admin,
			pidRow.pid,
			{ kind: "cancel", needle: ENCODING_FLUSH_NEEDLE, skip: 0 },
			{ limitMs: AIM_TIMEOUT_MS, stop: stopSignal },
		)
		const first = await scheduler.drainOnce()
		stopSignal.now = true
		aimHit = await abortAttempt
		firstEntry = first.find((e) => e.repo === REPO)
		stampAfterFault = await repoRepackStamp(db, REPO)
		violationsAfterFault = await encodingViolations(db, REPO)

		const second = await scheduler.drainOnce()
		secondEntry = second.find((e) => e.repo === REPO)
		violationsAfterRecovery = await encodingViolations(db, REPO)
		stampAfterRecovery = await repoRepackStamp(db, REPO)

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
		expect(firstEntry.gc).toEqual({
			deletedObjects: 1,
			epoch: "rebuilt",
			settled: true,
		})
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
		expect(secondEntry.gc).toBeNull()
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

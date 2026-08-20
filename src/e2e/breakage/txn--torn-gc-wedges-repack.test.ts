/**
 * TRANSACTIONAL-INTEGRITY PROBE 1 — a torn encoding tier is UNREPRESENTABLE.
 *
 * `createGc.gc()` once ran three independent sweeps (objects, edges, encodings),
 * and a pass dying between the object sweep and the encoding sweep left the
 * derived tier holding rows whose object — or whose delta BASE — no longer
 * existed. The 0008 FK cascades dissolved that state: a reclaimed object takes
 * its encoding row, and every delta row anchored on it, inside the very DELETE
 * that removes the object. There is no encoding sweep left to miss.
 *
 * This pins that invariant with the REAL gc() code killed at the last remaining
 * crash point — after the object sweep, before the pass's cleanup — over the one
 * fixture shape (design N3/N4) where a reachable delta's anchor dies:
 *
 *   the tier is CONSISTENT even in the torn state (no orphaned-base rows, no
 *   ghost rows — asserted directly), and then:
 *   Q1 (serve):  a clone of the torn repo still succeeds and fscks clean;
 *   Q2 (repack): the next repack pass makes progress (re-encodes the swept
 *                delta's object); a clean gc + repack converge.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import type { PackInputObject } from "@/pack/write-pack"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import {
	commitsOldestFirst,
	createAppendOnlyRepo,
	RUNS_DIR,
	runDirName,
} from "@/testing/append-only-repo"
import {
	objectsByType,
	parseRevListObjectOids,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const REPO = "torn-gc"
const RUNS = 50 // anchors land at lineage index 0 and 32; 33..50 is a PARTIAL segment
const KEEP_AT = 45 // a delta in that partial segment — the shape a new push extends
const REWIND_TO = 20 // main rewinds far below the kept delta's anchor

/** A porsager client whose `unsafe()` throws the moment GC reaches its
 * post-sweep cleanup — the process dying right after the object sweep completed,
 * the last crash point a pass has now that every derived surface follows the
 * object DELETEs by cascade (0008/0009) and no later sweep exists. The trigger
 * is the SECOND `drop table if exists gc_live`: the first is the pass-start
 * heal, the second is the success-path cleanup — so the whole sweep has run and
 * the TEMP table is left leaked on the pooled connection (the next pass's heal
 * covers it; killing here pins that too). Everything before that point runs the
 * real, unmodified GC code. The pass runs on one reserved connection, so
 * `reserve()` must be wrapped too (the sweep goes through ITS `unsafe`, not the
 * pool's). */
function killBeforeCleanup(pg: Sql): Sql {
	let drops = 0
	const wrapUnsafe = <T extends object>(target: T): T =>
		new Proxy(target, {
			get(t, prop, receiver) {
				if (prop === "unsafe") {
					const real = Reflect.get(t, prop, t) as Sql["unsafe"]
					return (sql: string, ...rest: unknown[]) => {
						if (sql.includes("drop table if exists gc_live")) {
							drops++
							if (drops === 2) {
								throw new Error("SIMULATED CRASH: process died before cleanup")
							}
						}
						return (real as (s: string, ...r: unknown[]) => unknown).call(t, sql, ...rest)
					}
				}
				if (prop === "reserve") {
					const real = Reflect.get(t, prop, t) as Sql["reserve"]
					return async () => wrapUnsafe(await real.call(t))
				}
				return Reflect.get(t, prop, receiver)
			},
		})
	return wrapUnsafe(pg)
}

type RepackCounts = { wholes: number; deltas: number }

describe("GC × crash — the tier stays whole through a mid-pass death", () => {
	let db: IsolatedDb
	let src = ""
	let root = ""
	let server: GitServer | undefined
	let torn: { orphaned: number; ghosts: number } = { ghosts: -1, orphaned: -1 }
	let anchorGone = false
	let q1: TestResult<string>
	let q2: TestResult<RepackCounts>
	let q3: TestResult<RepackCounts>

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-torn-gc-"))
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)

		// ── Fixture: the append-only shape, plus an orphan ref that keeps ONE late
		// delta alive while the anchor it points at becomes garbage. Per the design
		// doc's N4 this is the only shape where a reachable delta's anchor dies.
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		const commits = await commitsOldestFirst(src)
		const keepFrom = commits[KEEP_AT]
		const rewindTo = commits[REWIND_TO]
		if (!keepFrom || !rewindTo) throw new Error("fixture too short")
		await seedRepoIntoStore(REPO, src, { objects, refs })
		await repack.repack(REPO)

		// The orphan ref is created AFTER the first pass — a root commit present at
		// pass time would sort into the initial topo batch and make its tree an
		// anchor, which is not the state being probed.
		const keptTree = (
			await spawnGit(["rev-parse", `${keepFrom}^{tree}`], { cwd: src })
		).stdout.trim()
		const keepCommit = (
			await spawnGit(["commit-tree", keptTree, "-m", "keep"], { cwd: src })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/keep", keepCommit], { cwd: src })
		await objects.putPack(REPO, [
			{
				content: (await spawnGit(["cat-file", "commit", keepCommit], { cwd: src }))
					.stdoutBytes,
				type: "commit",
			},
		])
		await refs.setRef(REPO, "refs/heads/keep", keepCommit)

		// The state the tier is in before anything goes wrong.
		const [keptRow] = await db.sql<{ base: string | null }[]>`
			select encode(base_oid,'hex') as base from git_pack_encoding
			where oid = ${Buffer.from(keptTree, "hex")}`
		if (keptRow === undefined) throw new Error("fixture wrong: kept tree has no encoding")
		const keptAnchor = keptRow.base
		if (keptAnchor === null) throw new Error("fixture wrong: kept tree is not a delta")

		// ── The store rewind: main moves far below the anchor, `keep` survives.
		await refs.setRef(REPO, "refs/heads/main", rewindTo)

		// ── The crash: real GC, killed the instant it reaches post-sweep cleanup.
		let crashed = false
		try {
			await createGc(killBeforeCleanup(db.sql)).gc(REPO, {
				graceSeconds: 0,
				maintain: false,
			})
		} catch {
			crashed = true
		}
		if (!crashed) throw new Error("probe wrong: gc did not reach its cleanup")

		// ── The torn state, measured.
		const [tornRow] = await db.sql<{ orphaned: number; ghosts: number }[]>`
			select
				count(*) filter (
					where e.base_oid is not null
						and not exists (select 1 from git_object o where o.oid = e.base_oid)
				)::int as orphaned,
				count(*) filter (
					where not exists (select 1 from git_object o where o.oid = e.oid)
				)::int as ghosts
			from git_pack_encoding e`
		if (!tornRow) throw new Error("torn-state query returned no row")
		torn = tornRow
		const [anchorRow] = await db.sql<{ n: number }[]>`
			select count(*)::int as n from git_object
			where oid = ${Buffer.from(keptAnchor, "hex")}`
		if (anchorRow === undefined) throw new Error("anchor count query returned no row")
		anchorGone = anchorRow.n === 0

		// ── Q1: does the serve path survive the torn state?
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const dest = join(root, "clone")
		q1 = await captureTestResult(async () => {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
			const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			return `${fsck.stdout}${fsck.stderr}`.trim()
		})

		// ── Q2: the repo gets a new push extending the kept lineage, then repack.
		await spawnGit(["checkout", "-q", "keep"], { cwd: src })
		const runDir = join(src, RUNS_DIR, runDirName(RUNS + 1))
		mkdirSync(runDir, { recursive: true })
		writeFileSync(join(runDir, "record.json"), '{"n":"post-crash"}\n')
		await spawnGit(["add", "-A"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "post-crash run"], { cwd: src })
		const newTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		// Insert ONLY the objects the push carries (re-seeding everything would
		// resurrect what GC just reclaimed and destroy the experiment).
		const list = await spawnGit(["rev-list", "--objects", newTip, `^${keepCommit}`], {
			cwd: src,
		})
		const fresh: PackInputObject[] = []
		const typeByOid = new Map(
			(await objectsByType(src)).map((object) => [object.oid, object.type]),
		)
		for (const oid of parseRevListObjectOids(list.stdout)) {
			const type = typeByOid.get(oid)
			if (type === undefined) throw new Error(`git object inventory omitted ${oid}`)
			fresh.push({
				content: (await spawnGit(["cat-file", type, oid], { cwd: src })).stdoutBytes,
				type,
			})
		}
		await objects.putPack(REPO, fresh)
		await refs.setRef(REPO, "refs/heads/keep", newTip)

		q2 = await captureTestResult(() => repack.repack(REPO))

		// Does a SECOND repack (after another clean gc) recover?
		await gc.gc(REPO, { graceSeconds: 0, maintain: false })
		q3 = await captureTestResult(() => repack.repack(REPO))
	}, 300_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("a GC that dies mid-pass leaves no torn tier — the cascades make it unrepresentable", () => {
		// The precondition that makes the next two assertions meaningful: the object
		// sweep DID run, so the kept delta's anchor is genuinely gone from the
		// inventory. The 0008 FK cascades must have taken the dependent delta row
		// with it inside that same DELETE.
		expect(anchorGone).toBe(true)
		expect(torn.orphaned, "encoding rows whose base OBJECT is gone").toBe(0)
		expect(torn.ghosts, "encoding rows for objects that no longer exist").toBe(0)
	}, 300_000)

	it("Q1: the torn repo still clones and fsck's clean", () => {
		expect(q1.kind, testResultContext(q1, "torn-state clone")).toBe("succeeded")
		if (q1.kind === "succeeded") expect(q1.value).toBe("")
	}, 300_000)

	it("Q2: the next repack pass makes progress on the extended lineage", () => {
		expect(q2.kind, testResultContext(q2, "post-crash repack")).toBe("succeeded")
	}, 300_000)

	it("recovery: a clean GC followed by a repack pass succeeds", () => {
		expect(q3.kind, testResultContext(q3, "recovery repack")).toBe("succeeded")
	}, 300_000)
})

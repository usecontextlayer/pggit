/**
 * TRANSACTIONAL-INTEGRITY PROBE 1 — GC is not atomic across its three sweeps.
 *
 * `createGc.gc()` runs: sweepObjects → sweepEdges → sweepEncodings, each an
 * independent batched loop of short transactions. Nothing makes the trio atomic
 * and nothing records how far it got. If the pass dies anywhere after the object
 * sweep and before the encoding sweep finishes (deploy, connection loss, OOM,
 * statement timeout — and sweepEdges is the SLOWEST sweep on a real repo:
 * 1.1M kind-3 rows per the design doc's W5), the derived tier is left holding
 * encoding rows whose base object no longer exists.
 *
 * This reproduces exactly that state using the REAL gc() code — only the encoding
 * sweep is made to fail, which is what a crash in sweepEdges looks like from the
 * tier's point of view — and then asks the two questions that matter:
 *
 *   Q1 (serve):  does a clone of the torn repo still succeed and fsck clean?
 *   Q2 (repack): does the next repack pass make progress?
 *
 * How WIDE that crash window actually is — the share of a GC pass that runs before
 * the encoding sweep starts — is measured by `perf/breakage/txn--gc-sweep-window.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import type { GitObjectType } from "@/object/object"
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
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "torn-gc"
const RUNS = 50 // anchors land at lineage index 0 and 32; 33..50 is a PARTIAL segment
const KEEP_AT = 45 // a delta in that partial segment — the shape a new push extends
const REWIND_TO = 20 // main rewinds far below the kept delta's anchor

/** A porsager client whose `unsafe()` throws the moment GC reaches the ENCODING
 * sweep — i.e. the process dies during the (long) edge sweep that precedes it.
 * Everything before that point runs the real, unmodified GC code. */
function killAtEncodingSweep(pg: Sql): Sql {
	return new Proxy(pg, {
		get(target, prop, receiver) {
			if (prop !== "unsafe") return Reflect.get(target, prop, receiver)
			const real = Reflect.get(target, prop, target) as Sql["unsafe"]
			return (sql: string, ...rest: unknown[]) => {
				if (sql.includes("git_pack_encoding")) {
					throw new Error("SIMULATED CRASH: process died before the encoding sweep")
				}
				return (real as (s: string, ...r: unknown[]) => unknown).call(
					target,
					sql,
					...rest,
				)
			}
		},
	}) as Sql
}

/** Whether a repack pass survived, and what it reported. */
type PassOutcome = { ok: boolean; detail: string }

async function repackOutcome(run: () => Promise<{ wholes: number; deltas: number }>) {
	try {
		const r = await run()
		return { detail: `${r.wholes} wholes, ${r.deltas} deltas`, ok: true }
	} catch (err) {
		return { detail: `*** REPACK THREW: ${(err as Error).message}`, ok: false }
	}
}

describe("GC × crash — a torn sweep and the tier it leaves behind", () => {
	let db: IsolatedDb
	let src = ""
	let root = ""
	let server: GitServer | undefined
	let torn: { orphaned: number; ghosts: number } = { ghosts: -1, orphaned: -1 }
	let anchorGone = false
	let q1Fsck = ""
	let q2: PassOutcome = { detail: "not run", ok: false }
	let cleanSweptEncodings = -1
	let q3: PassOutcome = { detail: "not run", ok: false }

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-torn-gc-"))
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)

		// ── Fixture: the append-only shape, plus an orphan ref that keeps ONE late
		// delta alive while the anchor it points at becomes garbage. Per the design
		// doc's N4 this is the only shape that exercises the dangling-base sweep.
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
		const keptAnchor = keptRow?.base ?? null
		if (keptAnchor === null) throw new Error("fixture wrong: kept tree is not a delta")

		// ── The force push: main rewinds far below the anchor, `keep` survives.
		await refs.setRef(REPO, "refs/heads/main", rewindTo)

		// ── The crash: real GC, killed the instant it reaches the encoding sweep.
		let crashed = false
		try {
			await createGc(killAtEncodingSweep(db.sql)).gc(REPO, {
				graceSeconds: 0,
				maintain: false,
			})
		} catch {
			crashed = true
		}
		if (!crashed) throw new Error("probe wrong: gc did not reach the encoding sweep")

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
		anchorGone = anchorRow?.n === 0

		// ── Q1: does the serve path survive the torn state?
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const dest = join(root, "clone")
		try {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
			const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			q1Fsck = `${fsck.stdout}${fsck.stderr}`.trim() || "clean"
		} catch (err) {
			q1Fsck = `*** CLONE FAILED: ${(err as Error).message}`
		}

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
		const fresh: { type: GitObjectType; content: Buffer }[] = []
		for (const line of list.stdout.trim().split("\n").filter(Boolean)) {
			const oid = line.slice(0, 40)
			const type = (
				await spawnGit(["cat-file", "-t", oid], { cwd: src })
			).stdout.trim() as GitObjectType
			fresh.push({
				content: (await spawnGit(["cat-file", type, oid], { cwd: src })).stdoutBytes,
				type,
			})
		}
		await objects.putPack(REPO, fresh)
		await refs.setRef(REPO, "refs/heads/keep", newTip)

		q2 = await repackOutcome(() => repack.repack(REPO))

		// Does a SECOND repack (after another clean gc) recover?
		const clean = await gc.gc(REPO, { graceSeconds: 0, maintain: false })
		cleanSweptEncodings = clean.deletedEncodings
		q3 = await repackOutcome(() => repack.repack(REPO))
	}, 300_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("a GC that dies before its encoding sweep leaves no torn tier", () => {
		// The precondition that makes the next two assertions meaningful: the object
		// sweep DID run, so the kept delta's anchor is genuinely gone from the
		// inventory. The tier is what must not be left inconsistent by that.
		expect(anchorGone).toBe(true)
		expect(torn.orphaned, "encoding rows whose base OBJECT is gone").toBe(0)
		expect(torn.ghosts, "encoding rows for objects that no longer exist").toBe(0)
	}, 300_000)

	it("Q1: the torn repo still clones and fsck's clean", () => {
		expect(q1Fsck).toBe("clean")
	}, 300_000)

	it("Q2: the next repack pass makes progress on the extended lineage", () => {
		expect(q2.ok, q2.detail).toBe(true)
	}, 300_000)

	it("recovery: a clean GC followed by a repack pass succeeds", () => {
		expect(cleanSweptEncodings).toBeGreaterThanOrEqual(0)
		expect(q3.ok, q3.detail).toBe(true)
	}, 300_000)
})

/**
 * BREAKAGE (pg-txn) — abort GC and repack at every batch boundary.
 * Converted from `breakage/pg-txn--gc-repack-fault-sweep.ts`; its rationale
 * verbatim:
 *
 * HUNT: abort GC and repack at every batch boundary and ask whether the store is
 * ever WRONG (rather than merely behind), and whether one more gc+repack+clone
 * always returns it to correct.
 *
 * GC is: a REPEATABLE READ live-set snapshot on a pinned connection, then ONE
 * independently-committed batched sweep of objects — whose DELETEs also take
 * every derived row (`git_pack_encoding` per 0008, `git_commit`/`git_tag` per
 * 0009) via FK cascades.
 * Repack is: reads spread over many statements with NO shared snapshot, then
 * batched COPY inserts each in their own transaction. Neither pass is atomic, so
 * every batch boundary is a crash point.
 *
 * FAULTS INJECTED — every one against ONLY the pid this test opened, and every one
 * required to have actually ABORTED the pass (`it("every fault point actually
 * fired")`). Two kinds:
 *   - a short `statement_timeout` on the connection driving gc()/repack();
 *   - an AIMED abort: poll `pg_stat_activity` until that pid is inside a NAMED
 *     statement (having already run `skip` of them) and then `pg_cancel_backend`
 *     it — the statement dies, its batch rolls back, the batches before it stay
 *     committed — or `pg_terminate_backend` it, which kills the connection under
 *     the pass instead.
 *
 * WHY AIMED, when the source script swept `statement_timeout` T = 50 … 6400ms and
 * called each T "a different batch": a statement_timeout fires when a SINGLE
 * statement outlives T, never when the PASS does. gc's longest statement here is
 * one sweep DELETE, so the whole ladder collapses onto that one statement, and
 * measured at RUNS=600 every rung from 400ms up never fired AT ALL — those five
 * cases asserted their "does not tear" negative over a completely undisturbed
 * store. Worse, WHICH rungs fire is a property of the hardware: on an idle box
 * 100ms and 200ms stopped firing too. Naming the statement and its occurrence
 * index expresses the intended axis ("every batch boundary") directly and lands
 * identically whatever the machine is doing; ONE wall-clock rung survives (see
 * `TIMEOUTS`) for the abort this file does not aim.
 *
 * WHAT THIS FIXTURE DOES *NOT* FAULT: repack. The priming `repack()` below encodes
 * every object in the store, and GC only ever removes objects, so the faulted
 * repack pass has NOTHING pending — measured, 6 statements in ~200ms with no COPY
 * and no insert. Its abort points are therefore unreachable here whatever fault is
 * injected, and this suite exercises repack as the RECOVERY pass (C/D below), not
 * as a fault site. Faulting repack needs a fixture that leaves it real work
 * (objects pushed AFTER the priming pass) — a different fixture, not a different
 * timeout.
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
import { setTimeout as sleep } from "node:timers/promises"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { ZERO_OID } from "@/object/oid"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type GcResult } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack, type RepackResult } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { parseRevListObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

const RUNS = 600
/**
 * The one wall-clock rung. It is the only case whose abort point this file does
 * NOT choose — the clock picks whichever statement it lands on — which is worth
 * exactly one case and cannot be worth more: a `statement_timeout` fires only when
 * a SINGLE statement outlives T, so the rungs are not independent fault points,
 * they are one question ("is any statement slower than T?") asked at eight
 * thresholds. Measured here: at RUNS=600 under load, 50/100/200 fired and 400+
 * never did; on the same box IDLE, only 50 fired. Every rung above the machine's
 * slowest statement asserts this file's whole negative over a store that nothing
 * touched — which is what five of the original nine were doing. 50ms fired in
 * every run measured; if a faster box outgrows it, the barrier below says so out
 * loud instead of quietly passing, and the aimed cases carry the file regardless.
 */
const TIMEOUTS = [50]
/** Per-batch DELETE cap for the faulted sweep. Stated, not defaulted (10_000),
 * because the aimed cases below index sweep batches: at this fixture's orphan
 * count the default sweeps everything in one DELETE, and "abort at batch 2" would
 * have no batch 2 to abort at. */
const SWEEP_BATCH_LIMIT = 500
/** `pg_stat_activity.query` fragments, lowercased and whitespace-collapsed. */
const SWEEP = "delete from git_object"
const ANALYZE = "analyze git_object"
const short = (e: unknown) =>
	`${(e as { code?: string }).code ?? ""} ${(e as Error).message}`.trim().slice(0, 90)

type Counts = {
	orphanRows: number
	encNoObject: number
	encNoBase: number
	deltaOfDelta: number
}

async function counts(admin: Sql, repo: string): Promise<Counts> {
	const [row] = await admin<
		{
			orphan_rows: number
			enc_no_object: number
			enc_no_base: number
			delta_of_delta: number
		}[]
	>`
	with r as (select id from repos where name = ${repo})
		select
			((select count(*) from git_commit c
				where c.repo_id = (select id from r) and not exists (
					select 1 from git_object o
					where o.repo_id = c.repo_id and o.oid = c.oid))
				+ (select count(*) from git_tag t
					where t.repo_id = (select id from r) and not exists (
						select 1 from git_object o
						where o.repo_id = t.repo_id and o.oid = t.oid)))::int as orphan_rows,
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
	if (row === undefined) throw new Error(`counts: aggregate returned no row for ${repo}`)
	return {
		deltaOfDelta: row.delta_of_delta,
		encNoBase: row.enc_no_base,
		encNoObject: row.enc_no_object,
		orphanRows: row.orphan_rows,
	}
}

/** Every object reachable from every live ref, per canonical git in a scratch
 * mirror — the set a correct clone MUST carry. A string is the failure reason. */
async function liveClosure(url: string, dest: string): Promise<Set<string> | string> {
	const cl = await attemptGit([
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
	const fsck = await attemptGit(["fsck", "--strict", "--no-dangling"], dest)
	if (!fsck.ok) return `fsck DIRTY: ${fsck.stderr.trim().slice(0, 200)}`
	return new Set(
		parseRevListObjectOids(
			(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dest })).stdout,
		),
	)
}

/**
 * How one case's abort is delivered. `timeout` sets a `statement_timeout` on the
 * pass's connection and lets the wall clock decide which statement dies. The two
 * AIMED kinds instead wait for the pass to be inside `needle` for the
 * (`skip`+1)-th time and then kill the statement (`cancel`) or the whole
 * connection (`terminate`).
 */
type Fault =
	| { kind: "timeout"; ms: number }
	| { kind: "cancel" | "terminate"; needle: string; skip: number }
type FaultCase = { label: string; fault: Fault }
type CaseResult = {
	label: string
	/** The aimed watcher reached its target and issued the abort (always false for
	 * a `timeout` case, which has no watcher). Attribution only. */
	aimHit: boolean
	/** THE BARRIER: the pass actually aborted. Every assertion in this file is a
	 * claim about a TORN store, so a case that ran to completion has been asserting
	 * its negative over an undisturbed one. */
	faultObserved: boolean
	torn: Counts
	tornCloneError: string | null
	after: Counts
	gc3: GcResult
	rp3: RepackResult
	finalCloneError: string | null
	lostVsTorn: number
}

/**
 * Watch ONE pid and abort it once it is inside the targeted statement. Statements
 * are told apart by `query_start` — each sweep batch is its own statement, so
 * counting distinct starts is what makes "abort at the Nth batch boundary"
 * expressible at all. Returns whether the abort was issued; `stop.now` lets the
 * caller end the watch the moment the pass settles, so a miss costs one poll
 * rather than the whole bound.
 */
async function abortWhenInside(
	admin: Sql,
	pid: number,
	fault: { kind: "cancel" | "terminate"; needle: string; skip: number },
	stop: { now: boolean },
	limitMs: number,
): Promise<boolean> {
	const starts = new Set<string>()
	const t0 = Date.now()
	while (!stop.now && Date.now() - t0 < limitMs) {
		const [act] = await admin<{ s: string; q: string }[]>`
			select query_start::text as s, query as q
			from pg_stat_activity where pid = ${pid} and state = 'active'`
		if (act?.s && act.q.toLowerCase().replace(/\s+/g, " ").includes(fault.needle)) {
			starts.add(act.s)
			if (starts.size > fault.skip) {
				if (fault.kind === "cancel") await admin`select pg_cancel_backend(${pid})`
				else await admin`select pg_terminate_backend(${pid})`
				return true
			}
		}
		await sleep(1)
	}
	return false
}

// No encoding/commit/tag kill points: since the 0008/0009 FK cascades, GC
// issues no statement touching those tables to be killed inside — their rows
// die atomically within the object sweep's own DELETEs. The aimed cases walk
// the sweep instead: batch 0 has committed nothing, batch 1 and 2 leave a
// PARTIALLY swept inventory, and `analyze git_object` dies before the sweep
// starts at all.
const CASES: FaultCase[] = [
	...TIMEOUTS.map<FaultCase>((ms) => ({
		fault: { kind: "timeout", ms },
		label: `statement_timeout=${ms}ms`,
	})),
	{
		fault: { kind: "cancel", needle: ANALYZE, skip: 0 },
		label: "cancel during ANALYZE, before the sweep",
	},
	{
		fault: { kind: "cancel", needle: SWEEP, skip: 0 },
		label: "cancel during sweep batch 0",
	},
	{
		fault: { kind: "cancel", needle: SWEEP, skip: 1 },
		label: "cancel during sweep batch 1",
	},
	{
		fault: { kind: "cancel", needle: SWEEP, skip: 2 },
		label: "cancel during sweep batch 2",
	},
	{
		fault: { kind: "terminate", needle: SWEEP, skip: 0 },
		label: "kill during the OBJECT sweep",
	},
	{
		fault: { kind: "terminate", needle: SWEEP, skip: 1 },
		label: "kill mid-sweep, after a batch committed",
	},
]

describe("regressions/pg-txn — GC/repack aborted at every batch boundary", () => {
	let db: IsolatedDb
	let admin: Sql
	let appSql: Sql
	let server: GitServer
	let src = ""
	let root = ""
	const results: CaseResult[] = []

	beforeAll(async () => {
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

		const commits = await commitsOldestFirst(src, "main")
		const tip = commits[commits.length - 1]
		const mid = commits[Math.floor(commits.length / 2)]
		if (!tip || !mid) throw new Error("fixture too short to orphan")

		for (const [i, c] of CASES.entries()) {
			const repo = `txn/gcrp-${i}`
			const url = `http://127.0.0.1:${server.port}/${repo}`

			// Fresh repo: full history on main + a side branch, then REWIND side to
			// mid-history through the store's own RefStore, orphaning half of it.
			const p = await attemptGit(["push", "-q", url, `${tip}:refs/heads/main`], src)
			if (!p.ok) throw new Error(`seed push failed: ${p.stderr}`)
			const p2 = await attemptGit(["push", "-q", url, `${tip}:refs/heads/side`], src)
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
			// gc and repack each get a FRESH client so one case's injected timeout or
			// connection termination cannot contaminate the next case. Connection cleanup
			// itself is pinned by gc-poisons-pooled-connection.test.ts; this sweep
			// isolates the row-level convergence question.
			const mkFaulty = () =>
				postgres(baseUrl, {
					connection:
						c.fault.kind === "timeout"
							? { search_path: db.schema, statement_timeout: c.fault.ms }
							: { search_path: db.schema },
					max: 1,
					onnotice: () => {},
				})
			const gcSql = mkFaulty()
			// Abort ONLY the pid this test opened, and only once it is inside the
			// targeted statement. `stop` ends the watch as soon as the pass settles, so a
			// case whose target never appears costs one more poll, not the whole bound —
			// and reports `aimHit: false`, which the barrier below turns into a failure.
			const stop = { now: false }
			let aimed: Promise<boolean>
			if (c.fault.kind === "timeout") {
				aimed = Promise.resolve(false)
			} else {
				const [pidRow] = await gcSql<{ pid: number }[]>`select pg_backend_pid() as pid`
				if (pidRow === undefined) throw new Error("pg_backend_pid returned no row")
				aimed = abortWhenInside(admin, pidRow.pid, c.fault, stop, 45_000)
			}
			let gcErr = "none"
			let repackErr = "none"
			try {
				await createGc(gcSql).gc(repo, {
					batchLimit: SWEEP_BATCH_LIMIT,
					graceSeconds: 0,
					maintain: false,
				})
			} catch (e) {
				gcErr = short(e)
			}
			stop.now = true
			const aimHit = await aimed
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
				aimHit,
				faultObserved: gcErr !== "none" || repackErr !== "none",
				finalCloneError: typeof finalClone === "string" ? finalClone : null,
				gc3,
				label: c.label,
				lostVsTorn,
				rp3,
				torn,
				tornCloneError: typeof tornClone === "string" ? tornClone : null,
			})
		}
	}, 3_600_000)

	afterAll(async () => {
		await server?.close()
		await appSql?.end()
		await admin?.end()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("swept every fault point", () => {
		expect(results.map((r) => r.label)).toEqual(CASES.map((c) => c.label))
	})

	// THE BARRIER. Every other assertion in this file is a claim about a store that
	// a fault TORE, and each is satisfied trivially by a store nothing happened to —
	// which is how five of the nine original rungs passed while never firing. A case
	// that reaches here without an aborted pass is not a negative result, it is an
	// unrun experiment.
	it("every fault point actually fired", () => {
		expect(
			results
				.filter((r) => !r.faultObserved)
				.map(
					(r) =>
						`${r.label}: gc and repack both completed (aimHit=${r.aimHit}) — nothing was torn, so this case's negative is vacuous`,
				),
		).toEqual([])
	})

	// And the aimed cases fired where they were AIMED: a `cancel during sweep batch 2`
	// that never found batch 2, yet aborted somewhere else, would satisfy the barrier
	// above while sweeping a fault point that does not exist.
	it("every aimed fault reached its target statement", () => {
		const aimedLabels = CASES.filter((c) => c.fault.kind !== "timeout").map(
			(c) => c.label,
		)
		expect(
			results
				.filter((r) => aimedLabels.includes(r.label) && !r.aimHit)
				.map((r) => `${r.label}: the watcher never saw its target statement`),
		).toEqual([])
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
				.filter((r) => r.gc3.deletedObjects !== 0)
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
						r.after.orphanRows > 0 || r.after.encNoObject > 0 || r.after.encNoBase > 0,
				)
				.map(
					(r) =>
						`${r.label}: orphanRows=${r.after.orphanRows} encNoObject=${r.after.encNoObject} encNoBase=${r.after.encNoBase}`,
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
})

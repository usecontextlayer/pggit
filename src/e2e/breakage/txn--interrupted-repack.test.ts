/**
 * TRANSACTIONAL-INTEGRITY PROBE 2 — repack is many transactions, not one.
 *
 * `createRepack.repack()` accumulates encoding rows and flushes every WRITE_BATCH
 * (1000) rows in its OWN `pg.begin`. A pass over a real repo is therefore many
 * independent commits with no pass-level watermark and no resume record. The
 * design's D4 ("frozen, deterministic policy") claims a pass can be interrupted
 * and resumed safely because rows are never rewritten and bases finalize before
 * dependents.
 *
 * This kills the pass at every flush boundary in turn, resumes with a fresh
 * Repack, and then checks — through the tier's own invariants AND through canonical
 * git — whether the survivor is sound:
 *
 *   I1  no delta references an encoding row that does not exist
 *   I2  no delta's base is itself a delta (design D9: depth <= 1)
 *   I3  no self-referential delta
 *   I4  coverage: every object under the cap ends with exactly one row
 *   I5  a real `git clone` is fsck-clean and object-identical to the source
 *   I6  convergence: the resumed tier matches an uninterrupted single-pass tier
 *
 * I1–I3 are asserted on the HALF-BUILT tier too (a crashed pass must not leave a
 * topologically broken tier); I4 is not, because a partial pass is incomplete by
 * design — coverage is only owed once a pass finishes.
 *
 * The cost of I6 failing — what a customer pays in permanent clone bytes for a
 * crash they never saw — is measured by `perf/breakage/txn--interrupted-repack-cost.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { allObjectOids, seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const RUNS = 400 // ~3.4k objects => several WRITE_BATCH flushes per pass
/** Flush boundaries to die on. Each is < the pass's flush count at this scale, so
 * every one of them genuinely interrupts. */
const KILL_AT = [1, 2, 3]

/** A client whose `begin()` throws on the Nth call — the pass dies with N-1
 * flushes committed, exactly what a killed process or a dropped connection
 * leaves behind. */
function dieAtFlush(pg: Sql, n: number): Sql {
	let seen = 0
	return new Proxy(pg, {
		get(target, prop, receiver) {
			if (prop !== "begin") return Reflect.get(target, prop, receiver)
			const real = Reflect.get(target, prop, target) as Sql["begin"]
			return (...args: unknown[]) => {
				seen++
				if (seen === n) throw new Error(`SIMULATED CRASH at flush #${n}`)
				return (real as (...a: unknown[]) => unknown).apply(target, args)
			}
		},
	}) as Sql
}

/** oid -> base oid (null for a whole encoding) — the tier's whole topology. */
type Topo = Map<string, string | null>

async function topology(db: IsolatedDb): Promise<Topo> {
	const rows = await db.sql<{ oid: string; base: string | null }[]>`
		select encode(oid,'hex') as oid, encode(base_oid,'hex') as base from git_pack_encoding`
	return new Map(rows.map((r) => [r.oid, r.base]))
}

/** I1–I3: properties of the tier's own shape, readable from the topology alone. */
function topoViolations(topo: Topo): string[] {
	const bad: string[] = []
	let danglingRow = 0
	let depth2 = 0
	let self = 0
	for (const [oid, base] of topo) {
		if (base === null) continue
		if (base === oid) self++
		if (!topo.has(base)) danglingRow++
		else if (topo.get(base) !== null) depth2++
	}
	if (danglingRow) bad.push(`I1 ${danglingRow} deltas whose base has NO encoding row`)
	if (depth2) bad.push(`I2 ${depth2} deltas whose base is ITSELF a delta (depth > 1)`)
	if (self) bad.push(`I3 ${self} self-referential deltas`)
	return bad
}

/** I4: coverage of the inventory, which only a FINISHED pass owes. */
async function coverageViolations(db: IsolatedDb): Promise<string[]> {
	const bad: string[] = []
	const [cov] = await db.sql<{ uncovered: number; orphaned: number }[]>`
		select
			(select count(*) from git_object o where not exists (
				select 1 from git_pack_encoding e where e.repo_id=o.repo_id and e.oid=o.oid))::int
				as uncovered,
			(select count(*) from git_pack_encoding e where e.base_oid is not null
				and not exists (select 1 from git_object o where o.oid = e.base_oid))::int
				as orphaned`
	if (!cov) throw new Error("coverage query returned no row")
	if (cov.uncovered) bad.push(`I4 ${cov.uncovered} objects with NO encoding row`)
	if (cov.orphaned) bad.push(`I4 ${cov.orphaned} deltas whose base OBJECT is missing`)
	return bad
}

/** What one clone of the served repo observed. */
type CloneVerdict = { fsck: string; identical: boolean }

type KillOutcome = {
	killAt: number
	partialRows: number
	partialTopo: string[]
	halfBuilt: CloneVerdict
	resumedTopo: string[]
	resumedCoverage: string[]
	resumed: CloneVerdict
	/** I6: rows whose base disagrees with the uninterrupted reference tier. */
	divergentRows: number
	totalRows: number
}

describe("repack × crash — an interrupted pass and what it leaves behind", () => {
	let src = ""
	let root = ""
	const outcomes: KillOutcome[] = []

	beforeAll(async () => {
		const pgBaseUrl = inject("pgBaseUrl")
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-interrupted-repack-"))
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		const srcOids = await allObjectOids(src)

		/** Run `fn` against a fresh isolated schema, dropping it afterwards. Each kill
		 * point needs its own schema: they start from the same pristine seed. */
		async function withSchema<T>(fn: (db: IsolatedDb) => Promise<T>): Promise<T> {
			const db = await createIsolatedSchema(pgBaseUrl)
			try {
				return await fn(db)
			} finally {
				await db.drop()
			}
		}

		async function cloneVerdict(url: string, dest: string): Promise<CloneVerdict> {
			try {
				await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
				const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				const out = `${fsck.stdout}${fsck.stderr}`.trim()
				return {
					fsck: out || "clean",
					identical: (await allObjectOids(dest)).join() === srcOids.join(),
				}
			} catch (err) {
				return { fsck: `*** CLONE FAILED: ${(err as Error).message}`, identical: false }
			}
		}

		// Reference: one uninterrupted pass, for the convergence check (I6).
		const reference = await withSchema(async (db) => {
			await seedRepoIntoStore("ref", src, {
				objects: createObjectStore(db.sql),
				refs: createRefStore(db.sql),
			})
			await createRepack(db.sql).repack("ref")
			return await topology(db)
		})

		for (const killAt of KILL_AT) {
			const outcome = await withSchema(async (db) => {
				const objects = createObjectStore(db.sql)
				const refs = createRefStore(db.sql)
				await seedRepoIntoStore("r", src, { objects, refs })

				let died = false
				try {
					await createRepack(dieAtFlush(db.sql, killAt)).repack("r")
				} catch {
					died = true
				}
				if (!died) {
					throw new Error(
						`fixture too small: the pass finished with fewer than ${killAt} flushes`,
					)
				}
				const partial = await topology(db)
				const partialTopo = topoViolations(partial)

				let server: GitServer | undefined
				try {
					server = await serveOnPort(createGitApp({ objects, refs }), 0)
					const url = `http://127.0.0.1:${server.port}/r`
					// Serving from a HALF-BUILT tier, before any resume.
					const halfBuilt = await cloneVerdict(url, join(root, `mid-${killAt}`))

					await createRepack(db.sql).repack("r") // the resume
					const after = await topology(db)
					const resumed = await cloneVerdict(url, join(root, `full-${killAt}`))

					let divergentRows = 0
					for (const [oid, base] of after)
						if (reference.get(oid) !== base) divergentRows++

					return {
						divergentRows,
						halfBuilt,
						killAt,
						partialRows: partial.size,
						partialTopo,
						resumed,
						resumedCoverage: await coverageViolations(db),
						resumedTopo: topoViolations(after),
						totalRows: after.size,
					}
				} finally {
					await server?.close()
				}
			})
			outcomes.push(outcome)
		}
	}, 600_000)

	afterAll(() => {
		if (src) rmSync(src, { force: true, recursive: true })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("I1–I3: a crashed pass leaves a topologically sound partial tier", () => {
		expect(outcomes).toHaveLength(KILL_AT.length)
		for (const o of outcomes) {
			expect(o.partialRows).toBeGreaterThan(0)
			expect(o.partialTopo, `kill@${o.killAt}`).toEqual([])
		}
	}, 300_000)

	it("I5: a clone from the HALF-BUILT tier is fsck-clean and object-identical", () => {
		for (const o of outcomes) {
			expect(o.halfBuilt.fsck, `kill@${o.killAt}`).toBe("clean")
			expect(o.halfBuilt.identical, `kill@${o.killAt}`).toBe(true)
		}
	}, 300_000)

	it("I1–I4: the resumed tier holds every invariant, coverage included", () => {
		for (const o of outcomes) {
			expect(o.resumedTopo, `kill@${o.killAt}`).toEqual([])
			expect(o.resumedCoverage, `kill@${o.killAt}`).toEqual([])
		}
	}, 300_000)

	it("I5: a clone after the resume is fsck-clean and object-identical", () => {
		for (const o of outcomes) {
			expect(o.resumed.fsck, `kill@${o.killAt}`).toBe("clean")
			expect(o.resumed.identical, `kill@${o.killAt}`).toBe(true)
		}
	}, 300_000)

	it("I6: the resumed tier converges on the uninterrupted one", () => {
		// Rows are never rewritten (D4), so whatever the resume decided is PERMANENT:
		// a crash nobody saw becomes a tier the repo keeps forever. Convergence is the
		// property that makes "interrupt and resume" safe rather than merely survivable.
		for (const o of outcomes) {
			expect(
				o.divergentRows,
				`kill@${o.killAt}: ${o.divergentRows} of ${o.totalRows} rows differ`,
			).toBe(0)
		}
	}, 300_000)
})

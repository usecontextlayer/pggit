/**
 * RACE: two `createGc().gc()` passes on the SAME repo, concurrently.
 *
 * Under D12, the live set is a TEMP table on the pass's own reserved connection —
 * session-private and collision-proof by construction. This test pins that
 * property: `gc()` is still exported with no lock, so any two callers (an
 * operator script, a second process, a retry) may overlap, and must not be able
 * to destroy anything reachable.
 *
 * NOTHING here is unreachable-object trickery: the repo's ref is at the FULL tip
 * and every object is live, so a correct GC — at any concurrency — must delete
 * NOTHING and every clone must keep working. The verdict is a real `git clone`
 * plus `git fsck --strict`, and whether the clone's HEAD still matches the ref.
 *
 * Probabilistic — the observed defect reproduced
 * roughly 1 iteration in 10–30, so unlike the serve-window races the iteration
 * count here is a measured detection-power budget against a regression of a
 * specific fixed bug, and it is deliberately NOT trimmed (ruling-5 trims were
 * applied to the rest of the family; this file holds at 25 until a mutation
 * experiment — re-introducing the shared-live-set defect and measuring the
 * catch rate — says a smaller count keeps the pin). The swept pass-stagger IS
 * calibrated: absolute milliseconds would tie
 * the overlap shapes to one machine's gc speed; each run instead times one
 * un-raced pass and sweeps the second pass's start across FRACTIONS of that
 * measured wall. The per-iteration pre-race state (full history, tier built,
 * every object reachable) is COPIED from a template proven canonical AND
 * byte-faithful on its first copy.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseOid } from "@/object/oid"
import type { GitServer } from "@/server"
import { createGc, type Gc, type GcResult } from "@/store/gc"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	type GitObjectWithOid,
	loadReachableObjects,
	repackEligibleObjects,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { assertTemplateCopyFaithful, copyTemplateRepo } from "@/testing/template-repo"

const ITERS = 25
const RUNS = 150
const PASSES = 2
const TEMPLATE = "race/gcgc/template"
/** Where in the measured un-raced pass wall the second pass starts — the same
 * overlap shapes the source's absolute spread swept, made box-independent. */
const SPREAD_FRACTIONS = [
	0, 0.002, 0.004, 0.008, 0.015, 0.025, 0.04, 0.06, 0.09, 0.14,
] as const
/** Watchdog: a pass that has not settled in this long is HUNG, not slow — a
 * concurrent round on this fixture completes in well under a second, and an
 * observed hang sat at zero CPU with zero in-flight queries for 25 minutes. */
const HANG_MS = 60_000

const msg = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""

type PassOutcome = { ok: true; v: GcResult } | { ok: false; e: unknown }

describe("race — two concurrent gc() passes on one repo", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let gc: Gc
	let src = ""
	let objects: GitObjectWithOid[] = []
	let tip = ""
	let gcMs = 0
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		gc = createGc(db.sql)
		repack = createRepack(db.sql)

		// Template: full history, tier built, every object reachable from the ref
		// — the per-iteration pre-race state, built once and copied per iteration.
		await store.putPack(TEMPLATE, objects)
		await refs.setRef(TEMPLATE, "refs/heads/main", tip)
		await refs.setSymref(TEMPLATE, "HEAD", "refs/heads/main")
		await repack.repack(TEMPLATE)
		const proof = `${TEMPLATE}/copy-proof`
		await copyTemplateRepo(db.sql, TEMPLATE, proof)
		await assertCanonicalStoreFixture(db.sql, proof, {
			encodings: { kind: "exact", objects: repackEligibleObjects(objects) },
			objects,
			refs: [
				{ kind: "direct", name: "refs/heads/main", oid: parseOid(tip) },
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			],
		})
		await assertTemplateCopyFaithful(db.sql, TEMPLATE, proof)

		// Calibrate: one un-raced pass over a copy, timed wall-to-wall — it
		// deletes nothing (every object is reachable), so it is pure measurement.
		// The second pass's stagger is a fraction of this.
		const calRepo = "race/gcgc/cal"
		await copyTemplateRepo(db.sql, TEMPLATE, calRepo)
		const calStart = Date.now()
		await gc.gc(calRepo, { batchLimit: 5, graceSeconds: 0, maintain: false })
		gcMs = Date.now() - calStart
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	// Every object is reachable from the ref, so a correct GC deletes ZERO at any
	// concurrency, never hangs, and leaves the repo clonable at the same tip.
	it("concurrent gc() passes delete no reachable object and leave the repo clonable", async () => {
		const breaks: string[] = []
		const rounds: string[] = []
		let totalDeleted = 0
		// Overlap telemetry — recorded, not asserted: iterations where the second
		// pass started while the first was still running (the collision the pin
		// exists for).
		let secondPassOverlapped = 0

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const repo = `race/gcgc/${i}`
			const url = repoUrl(server, repo)
			// Pre-race state in one copy: full history, tier built, all reachable.
			await copyTemplateRepo(db.sql, TEMPLATE, repo)

			const fraction = SPREAD_FRACTIONS[i % SPREAD_FRACTIONS.length] as number
			const spread = Math.round(fraction * gcMs)
			const HUNG = Symbol("hung")
			const raceStart = Date.now()
			const passSettleMs: number[] = []
			const settled = await Promise.all(
				Array.from({ length: PASSES }, (_, k) =>
					Promise.race([
						sleep(k * spread)
							.then(() =>
								// batchLimit 5 ⇒ many short sweep transactions ⇒ a long window in
								// which the sibling pass's truncate/drop can land mid-sweep.
								gc
									.gc(repo, { batchLimit: 5, graceSeconds: 0, maintain: false })
									.then((v) => ({ ok: true as const, v }))
									.catch((e) => ({ e, ok: false as const })),
							)
							.finally(() => {
								passSettleMs[k] = Date.now() - raceStart
							}),
						sleep(HANG_MS).then(() => HUNG),
					]),
				),
			)
			const firstSettle = passSettleMs[0]
			if (firstSettle !== undefined && spread < firstSettle) secondPassOverlapped++
			const hung = settled.filter((s) => s === HUNG).length
			const results = settled.filter((s) => s !== HUNG) as PassOutcome[]
			const deleted = results
				.map((s) => (s.ok ? s.v.deletedObjects : 0))
				.reduce((a, b) => a + b, 0)
			const errs = results.filter((s) => !s.ok).map((s) => msg((s as { e: unknown }).e))
			totalDeleted += deleted

			const problems: string[] = []
			if (deleted > 0) {
				problems.push(`GC DELETED ${deleted} REACHABLE OBJECTS (must be 0)`)
			}
			if (hung > 0) {
				problems.push(`${hung}/${PASSES} gc() calls NEVER SETTLED in ${HANG_MS}ms`)
			}
			const dest = join(mkdtempSync(join(tmpdir(), "gcgc-dest-")), "c")
			scratch.push(dest)
			try {
				await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				const h = (await spawnGit(["rev-parse", "HEAD"], { cwd: dest })).stdout.trim()
				if (h !== tip) problems.push(`clone HEAD ${h} != ${tip}`)
			} catch (e) {
				problems.push(`CLONE BROKEN: ${msg(e)}`)
			}
			rmSync(dest, { force: true, recursive: true })

			rounds.push(
				`iter ${i} passes=${PASSES} spread=${spread}ms deleted=${deleted} hung=${hung} ` +
					`gcErrs=${errs.length}${errs.length > 0 ? ` (${errs[0]})` : ""}`,
			)
			if (problems.length > 0) {
				breaks.push(`iteration ${i} (spread ${spread}ms): ${problems.join(" | ")}`)
			}
		}

		console.log(
			`overlap telemetry (recorded, not asserted): second gc pass started inside the first pass's window in ${secondPassOverlapped}/${ITERS} iterations`,
		)
		expect(breaks, rounds.join("\n")).toEqual([])
		// The sharper form of the same property: across every iteration, a GC over a
		// fully reachable repo must destroy nothing at all.
		expect(totalDeleted).toBe(0)
	}, 1_800_000)
})

/**
 * RACE: a repack committing MID-CLONE of a PARTLY-repacked repo — the delta-pack
 * design's central safety claim (D1: "benign BY CONSTRUCTION, the served set
 * comes from the canonical inventory and encodings are only additive"). This
 * tries to falsify it for the `half` mode: the encoding tier already covers the
 * OLD history while the newly pushed history is still pending, so a racing pass
 * adds encodings for exactly the objects a full clone is mid-flight on — the
 * mixed raw/deltified serve the claim says must still compose a valid pack.
 *
 * Why a LARGE repo: `buildPack` reads content in batches of PACK_BATCH=1000 and
 * joins `git_pack_encoding` fresh in EVERY batch. Only a repo whose served set
 * spans multiple batches gives a concurrent repack a window to change the tier
 * between one batch's read and the next. RUNS=600 (~5k objects, ~5 batch reads)
 * keeps 4 inter-batch seams; the property is seam EXISTENCE, not seam count
 * (docs/2026-08-20-test-efficiency.md, ruling 6 — halved from the source
 * script's 1200).
 *
 * Verdict is git's: clone exit status, `git fsck --strict`, and the client's
 * object set vs the source repo's.
 *
 * The three modes are split so they parallelize across workers instead of
 * anchoring the gate's wall time as one serial file. Frozen absolute delays would tie the sweep to one machine's serve
 * speed — on a slower or loaded box they crowd into the serve's head and the
 * late batch seams are never raced. Each run instead times one un-raced
 * calibration clone and sweeps the repack's start across FRACTIONS of that
 * measured wall (0–97%), so the arms land between different batch-read pairs on
 * any box. That calibration is also why 12 iterations carry the coverage the
 * source spread over 30: one full 12-arm sweep that mostly HITS the serve
 * window beats 2.5 sweeps of absolute delays that mostly miss it
 * (docs/2026-08-20-test-efficiency.md, ruling 5). Each iteration's pre-race
 * state is assembled by COPYING a template repo's rows instead of re-seeding
 * through `putPack`; the template's first copy is proven against the canonical
 * object/ref identity its seeding established.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	branchAndTagRefsOf,
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

const ITERS = 12
const RUNS = 600
const TEMPLATE = "race/clone-repack/template/half"
/** Where in the measured serve each iteration's repack lands. 0 races the serve
 * from its first batch read; 0.97 races its last. No arm is spent past the end
 * of the serve — a repack that starts after the clone finished exercises
 * nothing. */
const DELAY_FRACTIONS = [
	0, 0.03, 0.08, 0.15, 0.22, 0.3, 0.4, 0.5, 0.6, 0.72, 0.85, 0.97,
] as const

describe("race — repack committing mid-clone (half-repacked repo)", () => {
	let db: IsolatedDb
	let server: GitServer
	let repack: Repack
	let srcOidsFull: string[] = []
	let serveMs = 0
	const scratch: string[] = []

	beforeAll(async () => {
		// Two fast-import builds of the SAME deterministic history: `full` strictly
		// extends `base` (same pinned identity + clock ⇒ the shared prefix is
		// byte-identical), so the template's pending tail is a real incremental push.
		const srcBase = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		const src = await createAppendOnlyRepo({ docs: 4, runs: RUNS + 40 })
		scratch.push(srcBase, src)
		const baseObjects = await loadReachableObjects(srcBase, ["--all"])
		const baseRefs = await branchAndTagRefsOf(srcBase)
		const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()
		const fullObjects = await loadReachableObjects(src, ["--all"])
		const fullRefs = await branchAndTagRefsOf(src)
		srcOidsFull = await allObjectOids(src)
		const baseTip = (
			await spawnGit(["rev-parse", "HEAD"], { cwd: srcBase })
		).stdout.trim()
		const ancestor = await spawnGit(["merge-base", "--is-ancestor", baseTip, "HEAD"], {
			cwd: src,
		}).then(
			() => true,
			() => false,
		)
		if (!ancestor)
			throw new Error("fixture: base history is not a prefix of full history")

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const store = fixture.deps.objects
		const refs = fixture.deps.refs
		repack = createRepack(db.sql)

		const setRefs = async (entries: { name: string; oid: string }[]): Promise<void> => {
			for (const entry of entries) {
				await refs.setRef(TEMPLATE, entry.name, entry.oid)
			}
			await refs.setSymref(TEMPLATE, "HEAD", head)
		}

		// Tier already covers the OLD history; the new history is pending, so a racing
		// pass adds encodings for objects a read is mid-flight on. The second push
		// carries the DELTA only: a real push sends the history that arrived, not
		// every base object re-sent to be conflict-skipped.
		await store.putPack(TEMPLATE, baseObjects)
		await setRefs(baseRefs)
		await repack.repack(TEMPLATE)
		const baseOids = new Set(baseObjects.map((object) => object.oid))
		await store.putPack(
			TEMPLATE,
			fullObjects.filter((object) => !baseOids.has(object.oid)),
		)
		await setRefs(fullRefs)

		// The anchored identity proof (docs/2026-08-20-test-efficiency.md): one copy,
		// checked against the same canonical identity the seeding established. The
		// repack ran over the base state ALONE and repack only ever adds rows, so
		// exactly the base objects carry an encoding here.
		const proof = `${TEMPLATE}/copy-proof`
		await copyTemplateRepo(db.sql, TEMPLATE, proof)
		await assertCanonicalStoreFixture(db.sql, proof, {
			encodings: { kind: "exact", objects: repackEligibleObjects(baseObjects) },
			objects: fullObjects,
			refs: [
				...fullRefs.map(({ name, oid }) => ({ kind: "direct" as const, name, oid })),
				{ kind: "symbolic", name: "HEAD", target: head },
			],
		})
		await assertTemplateCopyFaithful(db.sql, TEMPLATE, proof)

		// Calibrate: one un-raced clone of the template state, timed wall-to-wall.
		// The raced delays are fractions of this measurement.
		const calDest = join(mkdtempSync(join(tmpdir(), "race-cr-half-cal-")), "c")
		scratch.push(calDest)
		const calStart = Date.now()
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			repoUrl(server, TEMPLATE),
			calDest,
		])
		serveMs = Date.now() - calStart
	}, 900_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("a clone of a half-repacked repo raced by a repack lands complete and fsck-clean", async () => {
		const breaks: string[] = []
		// Overlap telemetry — recorded, not asserted: whether each iteration's
		// repack ran inside the serve it races ("in"), spilled past its end
		// ("straddle"), or started after the serve finished ("late", a wasted arm).
		const overlaps = { in: 0, late: 0, straddle: 0 }

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const fraction = DELAY_FRACTIONS[i % DELAY_FRACTIONS.length] as number
			const delay = Math.round(fraction * serveMs)
			const repo = `race/clone-repack/half/${i}`
			const dest = join(mkdtempSync(join(tmpdir(), "race-cr-half-")), "c")
			scratch.push(dest)
			const problems: string[] = []

			try {
				// Objects, derived rows, encodings and refs all land in one copy.
				await copyTemplateRepo(db.sql, TEMPLATE, repo)

				const raceStart = Date.now()
				let serveSettleMs = 0
				let racerSettleMs = 0
				const settled = await Promise.allSettled([
					spawnGit([
						"-c",
						"protocol.version=2",
						"clone",
						"-q",
						repoUrl(server, repo),
						dest,
					]).finally(() => {
						serveSettleMs = Date.now() - raceStart
					}),
					sleep(delay)
						.then(() => repack.repack(repo))
						.finally(() => {
							racerSettleMs = Date.now() - raceStart
						}),
				])
				overlaps[
					delay >= serveSettleMs
						? "late"
						: racerSettleMs <= serveSettleMs
							? "in"
							: "straddle"
				]++
				for (const s of settled) {
					if (s.status === "rejected") problems.push(`${s.reason}`)
				}

				if (problems.length === 0) {
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
					const got = await allObjectOids(dest)
					if (got.join(",") !== srcOidsFull.join(",")) {
						problems.push(
							`object set mismatch: client ${got.length} vs source ${srcOidsFull.length}`,
						)
					}
				}
			} catch (err) {
				problems.push(err instanceof Error ? err.message : String(err))
			}

			if (problems.length > 0) {
				breaks.push(
					`iteration ${i}, repack at +${delay}ms (${fraction} of ${serveMs}ms serve): ${problems.join(" | ")}`,
				)
			}
			rmSync(dest, { force: true, recursive: true })
		}

		console.log(
			`overlap telemetry (recorded, not asserted): repack vs clone serve — in=${overlaps.in} straddle=${overlaps.straddle} late=${overlaps.late}`,
		)
		expect(breaks).toEqual([])
	}, 1_800_000)
})

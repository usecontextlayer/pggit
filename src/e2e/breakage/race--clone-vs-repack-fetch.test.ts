/**
 * RACE: a repack committing MID-FETCH — the delta-pack design's central safety
 * claim (D1: "benign BY CONSTRUCTION, the served set comes from the canonical
 * inventory and encodings are only additive"). This tries to falsify it for the
 * `fetch` mode: a real INCREMENTAL fetch (the client holds the old tip and
 * sends haves) racing a repack, so the racing pass changes the tier under the
 * smallest, haves-narrowed served set the negotiation path produces.
 *
 * The server state is the `half` template: the encoding tier covers the OLD
 * history (exactly what the client already has), the newly pushed tail is
 * pending, and the raced repack encodes that tail mid-serve. RUNS=600 (~5k
 * objects) halves the source script's fixture per ruling 6 of
 * docs/2026-08-20-test-efficiency.md — the served increment still spans the
 * batch seam the hunt needs; the property is seam EXISTENCE, not seam count.
 *
 * Verdict is git's: fetch + ff-merge exit status, `git fsck --strict`, and the
 * client's object set vs the source repo's.
 *
 * Converted from `breakage/race--clone-vs-repack.ts` (`--iters=30 --runs=1200
 * --mode=all`), split per mode so the three modes parallelize across workers
 * instead of anchoring the gate's wall time as one serial file. The source (and
 * the first conversion) swept absolute delays but CLAMPED them to
 * `min(delay, 60)` in this mode, because an incremental serve is far shorter
 * than a clone serve — which silently collapsed 8 of the 12 sweep arms onto
 * 60 ms. Calibration replaces the clamp with its intent: one un-raced
 * incremental fetch is timed, and the repack's start sweeps FRACTIONS of that
 * measured wall (0–97%), so all 12 arms are distinct and inside the serve on
 * any box. That calibration is also why 12 iterations carry the coverage the
 * source spread over 30: one full 12-arm sweep that mostly HITS the serve
 * window beats 2.5 sweeps of a clamped spread (ruling 5). Each iteration's
 * pre-race state is assembled by COPYING a template repo's rows; the template's
 * first copy is proven against the canonical identity its seeding established.
 * Only the un-raced setup is deduplicated (the base client is cloned once and
 * `cp`'d per iteration); the raced fetch is a fresh, fully real one every time.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs"
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
import { copyTemplateRepo } from "@/testing/template-repo"

const ITERS = 12
const RUNS = 600
const TEMPLATE = "race/clone-repack/template/half"
/** Where in the measured incremental serve each iteration's repack lands. 0
 * races the serve from its start; 0.97 races its tail. No arm is spent past the
 * end of the serve. */
const DELAY_FRACTIONS = [
	0, 0.03, 0.08, 0.15, 0.22, 0.3, 0.4, 0.5, 0.6, 0.72, 0.85, 0.97,
] as const

describe("race — repack committing mid-incremental-fetch", () => {
	let db: IsolatedDb
	let server: GitServer
	let repack: Repack
	let srcOidsFull: string[] = []
	let serveMs = 0
	/** A client cloned from the template while it was still at the BASE state —
	 * the un-raced setup, deduplicated across iterations. */
	let fetchClientBase = ""
	const scratch: string[] = []

	beforeAll(async () => {
		// Two fast-import builds of the SAME deterministic history: `full` strictly
		// extends `base` (same pinned identity + clock ⇒ the shared prefix is
		// byte-identical), which is what makes the fetch a real incremental one with
		// haves rather than a disjoint second repo.
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

		// Tier covers the OLD history; the new history is pending.
		await store.putPack(TEMPLATE, baseObjects)
		await setRefs(baseRefs)
		await repack.repack(TEMPLATE)
		// The client, cloned WHILE the template is still at base — that is what makes
		// the per-iteration fetch incremental (the client sends haves).
		fetchClientBase = join(mkdtempSync(join(tmpdir(), "race-cr-fetch-base-")), "c")
		scratch.push(fetchClientBase)
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			repoUrl(server, TEMPLATE),
			fetchClientBase,
		])
		// The DELTA only: a real second push carries the history that arrived, not
		// every base object re-sent to be conflict-skipped.
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

		// Calibrate: one un-raced incremental fetch of the same shape the raced
		// iterations run, timed wall-to-wall. The raced delays are fractions of
		// this measurement — this is what replaces the old `min(delay, 60)` clamp.
		const calDest = join(mkdtempSync(join(tmpdir(), "race-cr-fetch-cal-")), "c")
		scratch.push(calDest)
		cpSync(fetchClientBase, calDest, { recursive: true })
		await spawnGit(["remote", "set-url", "origin", repoUrl(server, TEMPLATE)], {
			cwd: calDest,
		})
		const calStart = Date.now()
		await spawnGit(["-c", "protocol.version=2", "fetch", "-q", "origin"], {
			cwd: calDest,
		})
		serveMs = Date.now() - calStart
	}, 900_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("an incremental fetch raced by a repack lands complete and fsck-clean", async () => {
		const breaks: string[] = []

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const fraction = DELAY_FRACTIONS[i % DELAY_FRACTIONS.length] as number
			const delay = Math.round(fraction * serveMs)
			const repo = `race/clone-repack/fetch/${i}`
			const dest = join(mkdtempSync(join(tmpdir(), "race-cr-fetch-")), "c")
			scratch.push(dest)
			const url = repoUrl(server, repo)
			const problems: string[] = []

			try {
				// Objects, derived rows, encodings and refs all land in one copy.
				await copyTemplateRepo(db.sql, TEMPLATE, repo)

				// A real incremental fetch: the client holds the OLD tip (so it sends
				// haves) while the server is already advanced; race it against a repack.
				cpSync(fetchClientBase, dest, { recursive: true })
				await spawnGit(["remote", "set-url", "origin", url], { cwd: dest })
				const settled = await Promise.allSettled([
					spawnGit(["-c", "protocol.version=2", "fetch", "-q", "origin"], {
						cwd: dest,
					}),
					sleep(delay).then(() => repack.repack(repo)),
				])
				for (const s of settled) {
					if (s.status === "rejected") problems.push(`${s.reason}`)
				}
				if (problems.length === 0) {
					await spawnGit(["merge", "-q", "--ff-only", "origin/main"], { cwd: dest })
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

		expect(breaks).toEqual([])
	}, 1_800_000)
})

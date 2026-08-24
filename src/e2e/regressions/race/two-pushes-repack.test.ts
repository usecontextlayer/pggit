/**
 * RACE: wire pushes into the SAME delta lineage while a repack pass is running.
 *
 * Two shapes, both aimed at the encoder's base-selection policy (design D4:
 * "frozen, deterministic — bases finalize before dependents, existing rows are
 * never rewritten"). That policy is a claim about ONE pass over a FIXED commit
 * set; a push landing mid-pass changes the commit set the walk is derived from,
 * and the walk's topological order is recomputed from scratch on the next pass.
 *
 *   same-path  one push appending to the append-only directory whose successive
 *              tree versions ARE the lineage the encoder deltifies, fired at a
 *              swept offset into a concurrent repack; then a clone.
 *   two-push   two clients racing to move refs/heads/main to DIFFERENT commits
 *              while a repack runs. Exactly one must win; the repo must then
 *              serve the winner's tip, fsck-clean.
 *
 * Verdict is git's: push exit status, clone, `git fsck --strict`, and that the
 * clone's HEAD equals whatever `git ls-remote` says the ref is — both with the
 * tier as the race left it AND after one more converging repack.
 *
 * Probabilistic. Fractional repack-start delays avoid tying the race to one machine's push
 * speed — the window under attack is the wire push's server-side ingest, and
 * frozen offsets crowd into its head on any slower or loaded box. Each run
 * instead times one un-raced calibration push of the same shape and sweeps the
 * repack's start across FRACTIONS of that measured wall (0–97%), so the arms
 * land across the whole ingest on any box. That calibration is also why 12
 * iterations carry the coverage the source spread over 25: one full 12-arm
 * sweep that lands in-window beats 2.5 sweeps of absolute delays
 * (docs/2026-08-20-test-efficiency.md, ruling 5). The per-round pre-race state
 * (full history, tier covering it) is assembled by COPYING a template repo's
 * rows instead of re-seeding and re-repacking per round; the template's first
 * copy is proven canonical AND byte-faithful.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseOid } from "@/object/oid"
import type { GitServer } from "@/server"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo, RUNS_DIR, runDirName } from "@/testing/append-only-repo"
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

const ITERS = 12
const RUNS = 400
const MODES = ["same-path", "two-push"] as const
const TEMPLATE = "race/tpr/template"
/** Where in the measured un-raced push wall each iteration's repack starts. 0
 * races the ingest from its first statement; 0.97 races its tail. */
const DELAY_FRACTIONS = [
	0, 0.03, 0.08, 0.15, 0.22, 0.3, 0.4, 0.5, 0.6, 0.72, 0.85, 0.97,
] as const

const msg = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""

/** Add one run directory to the append-only lineage and commit it. */
async function commitRun(dir: string, n: number, salt: string): Promise<string> {
	const run = join(dir, RUNS_DIR, runDirName(n))
	mkdirSync(run, { recursive: true })
	writeFileSync(join(run, "record.json"), `{"run":${n},"salt":"${salt}"}\n`)
	writeFileSync(join(run, "stderr"), `err ${n} ${salt}\n`)
	await spawnGit(["add", "-A"], { cwd: dir })
	await spawnGit(["commit", "-q", "-m", `run ${n} ${salt}`], { cwd: dir })
	return (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
}

describe("race — wire pushes into the delta lineage while a repack runs", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let src = ""
	let a = ""
	let b = ""
	let objects: GitObjectWithOid[] = []
	let tip = ""
	let pushMs = 0
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		// Two independent working checkouts of the same history.
		a = join(mkdtempSync(join(tmpdir(), "tpr-a-")), "c")
		b = join(mkdtempSync(join(tmpdir(), "tpr-b-")), "c")
		scratch.push(a, b)
		await spawnGit(["clone", "-q", src, a])
		await spawnGit(["clone", "-q", src, b])

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		repack = createRepack(db.sql)

		// Template: the per-round pre-race state — full history seeded, refs set,
		// tier covering the old history — built once, copied per round.
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

		// Calibrate: one un-raced wire push of the same shape the raced rounds
		// use, timed wall-to-wall. The raced repack delays are fractions of this.
		const calRepo = "race/tpr/cal"
		await copyTemplateRepo(db.sql, TEMPLATE, calRepo)
		await spawnGit(["reset", "-q", "--hard", tip], { cwd: a })
		await commitRun(a, RUNS + 100, "cal")
		const calStart = Date.now()
		await spawnGit(["push", "-q", repoUrl(server, calRepo), "HEAD:refs/heads/main"], {
			cwd: a,
		})
		pushMs = Date.now() - calStart
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("exactly one push wins and the repo serves that tip, fsck-clean, before and after a converging repack", async () => {
		const breaks: string[] = []
		const tally: Record<string, number> = {}
		const bump = (k: string) => {
			tally[k] = (tally[k] ?? 0) + 1
		}
		// Overlap telemetry — recorded, not asserted: whether each round's repack
		// ran inside the push window it races ("in"), spilled past it ("straddle"),
		// or started after every push settled ("late", a wasted arm).
		const overlaps = { in: 0, late: 0, straddle: 0 }

		outer: for (let i = 0; i < ITERS; i++) {
			for (const mode of MODES) {
				const repo = `race/tpr/${mode}/${i}`
				const url = repoUrl(server, repo)
				// Pre-race state in one copy: full history, tier covering the OLD
				// history — the pushes are not encoded.
				await copyTemplateRepo(db.sql, TEMPLATE, repo)

				await spawnGit(["reset", "-q", "--hard", tip], { cwd: a })
				await spawnGit(["reset", "-q", "--hard", tip], { cwd: b })
				await commitRun(a, RUNS + i, `a${i}`)
				await commitRun(b, RUNS + i, `b${i}`)

				const fraction = DELAY_FRACTIONS[i % DELAY_FRACTIONS.length] as number
				const delay = Math.round(fraction * pushMs)
				const problems: string[] = []
				let errA: unknown
				let errB: unknown
				let repackErr: unknown
				const raceStart = Date.now()
				let pushSettleMs = 0
				let racerSettleMs = 0
				const timedPush = (cwd: string, onErr: (e: unknown) => void) =>
					spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd })
						.catch(onErr)
						.finally(() => {
							pushSettleMs = Math.max(pushSettleMs, Date.now() - raceStart)
						})
				const timedRepack = () =>
					sleep(delay)
						.then(() =>
							repack.repack(repo).catch((e) => {
								repackErr = e
							}),
						)
						.finally(() => {
							racerSettleMs = Date.now() - raceStart
						})

				if (mode === "same-path") {
					await Promise.allSettled([
						timedPush(a, (e) => {
							errA = e
						}),
						timedRepack(),
					])
					if (errA !== undefined) problems.push(`push rejected: ${msg(errA)}`)
				} else {
					await Promise.allSettled([
						timedPush(a, (e) => {
							errA = e
						}),
						timedPush(b, (e) => {
							errB = e
						}),
						timedRepack(),
					])
					const winners = [errA === undefined, errB === undefined].filter(Boolean).length
					// Both pushes are siblings of the same parent, so at most one can be a
					// fast-forward; the other must be refused.
					if (winners !== 1)
						problems.push(`expected exactly 1 push to win, got ${winners}`)
					bump(`two-push winners=${winners}`)
				}
				overlaps[
					delay >= pushSettleMs
						? "late"
						: racerSettleMs <= pushSettleMs
							? "in"
							: "straddle"
				]++
				if (repackErr !== undefined) problems.push(`repack threw: ${msg(repackErr)}`)

				// Whatever the ref says now, the repo must serve it soundly — with the
				// tier as the race left it AND after one more converging repack.
				const ls = await spawnGit(["ls-remote", url, "refs/heads/main"], { cwd: a })
				const serverTip = ls.stdout.trim().split(/\s+/)[0] ?? ""
				for (const [tag, pre] of [
					["as-raced", async () => undefined],
					["after-repack", async () => void (await repack.repack(repo))],
				] as const) {
					await pre()
					const dest = join(mkdtempSync(join(tmpdir(), `tpr-${tag}-`)), "c")
					scratch.push(dest)
					try {
						await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
						await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
						const h = (await spawnGit(["rev-parse", "HEAD"], { cwd: dest })).stdout.trim()
						if (h !== serverTip)
							problems.push(`${tag}: clone HEAD ${h} != ref ${serverTip}`)
					} catch (e) {
						problems.push(`${tag}: ${msg(e)}`)
					}
					rmSync(dest, { force: true, recursive: true })
				}

				if (problems.length > 0) {
					breaks.push(
						`iteration ${i}, mode ${mode}, repack at +${delay}ms: ${problems.join(" | ")}`,
					)
					break outer
				}
			}
		}

		console.log(
			`overlap telemetry (recorded, not asserted): repack vs push window — in=${overlaps.in} straddle=${overlaps.straddle} late=${overlaps.late}`,
		)
		expect(breaks, JSON.stringify(tally, null, 2)).toEqual([])
	}, 1_800_000)
})

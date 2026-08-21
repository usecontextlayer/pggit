/**
 * RACE: a real wire `git push` + `gc()` + `repack()` all in flight on one repo,
 * with a real `git clone` reading through the middle of it.
 *
 * Four actors, no lock between any of them:
 *   push    — canonical git over the HTTP wire (receive-pack), fast-forwarding
 *             main onto a rewound tip so the pass ALSO has real orphans to eat
 *   gc      — `createGc().gc(repo, { graceSeconds })`; grace is swept so the run
 *             covers both the drain's production default and the 0 the GC suite
 *             itself uses
 *   repack  — `createRepack().repack(repo)`, the derived encoding tier's producer
 *   clone   — canonical git, reading a pack built out of all of the above
 *
 * The questions, all judged at git observables:
 *   Q1  can a push that git reported as SUCCESSFUL become unfetchable?
 *       (an acknowledged-then-lost push is the severe outcome)
 *   Q2  can a clone report success and hand the client a pack that fails
 *       `git fsck --strict` / connectivity? (a SHORT pack, worse than an error)
 *   Q3  after the dust settles, does one more repack + clone still work — i.e.
 *       does the repo converge to a servable state (design D7's self-repair)?
 *
 * The contract matches git's: GRACE is the in-flight defense, pggit's
 * `gc.pruneExpire`. Git documents that pruning with `--prune=now` while other
 * operations are live can destroy an in-flight push's objects — it promises
 * nothing there, and neither does pggit. So Q1 (and the permanent
 * non-convergence an eaten acked push implies in Q3) is ASSERTED only in the
 * graced arm; in the grace-0 arm those losses are tallied as tolerated. Q2 is
 * asserted in BOTH arms — a clone that reports success must be sound at any
 * grace, the same bar canonical upload-pack holds under a concurrent prune —
 * and a ref VANISHING is a hard break in both arms (gc never touches refs).
 *
 * Converted from `breakage/race--push-gc-repack.ts` (`--iters=40 --runs=120
 * --grace=-1 --rewind=40`; grace=-1 alternates 0 / 60). Probabilistic. Two
 * things are deliberately NOT the source's:
 *
 * - The actor-start offsets were frozen absolute milliseconds; they are now
 *   FRACTIONS of one measured un-raced clone wall (the longest actor), so the
 *   four starts keep the same relative stagger on any box under any load.
 * - The original indexing ALIASED: the 6-row offset matrix cycled `i % 6` while
 *   grace cycled `i % 2`, and 6 and 2 share a factor — so offset rows 0/2/4
 *   only ever ran at grace 0 and rows 1/3/5 only at grace 60, and 40 iterations
 *   never covered the other six combinations. Grace now flips per full matrix
 *   cycle (`floor(i/6) % 2`), so 12 iterations cover ALL 12 row×grace
 *   combinations — strictly more coverage than the 40 (ruling 5,
 *   docs/2026-08-20-test-efficiency.md).
 *
 * The per-iteration pre-race state (full history, ref rewound, no tier) is
 * assembled by COPYING a template repo's rows; the template's first copy is
 * proven canonical AND byte-faithful.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseOid } from "@/object/oid"
import type { GitServer } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	type GitObjectWithOid,
	loadReachableObjects,
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
const RUNS = 120
const REWIND = 40
const TEMPLATE = "race/pgr/template"
/** Actor-start offsets as fractions of the measured un-raced clone wall — the
 * same six start-order permutations the source swept, made box-independent. */
const PUSH_FRACTIONS = [0, 0, 0, 0.007, 0.014, 0.03] as const
const GC_FRACTIONS = [0, 0.007, 0.02, 0, 0.04, 0.011] as const
const REPACK_FRACTIONS = [0, 0.02, 0.007, 0.036, 0, 0.057] as const
const CLONE_FRACTIONS = [0, 0.036, 0.057, 0.014, 0.08, 0] as const

const msg = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""

describe("race — a wire push, a gc(), a repack() and a clone all in flight", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let gc: Gc
	let src = ""
	let client = ""
	let objects: GitObjectWithOid[] = []
	let tip = ""
	let rewindTo = ""
	let cloneMs = 0
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		const commits = await commitsOldestFirst(src, "HEAD")
		tip = commits[commits.length - 1] as string
		rewindTo = commits[commits.length - 1 - REWIND] as string

		// One client checkout, reused: it already holds the whole history, so each
		// iteration's push is a small, real, negotiated receive-pack.
		client = join(mkdtempSync(join(tmpdir(), "pgr-client-")), "c")
		scratch.push(client)
		await spawnGit(["clone", "-q", src, client])

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		repack = createRepack(db.sql)
		gc = createGc(db.sql)

		// Template: full history seeded, main rewound (real orphans for the pass to
		// eat), no encoding tier — the raced repack builds it. Built once, copied
		// per iteration.
		await store.putPack(TEMPLATE, objects)
		await refs.setRef(TEMPLATE, "refs/heads/main", tip)
		await refs.setSymref(TEMPLATE, "HEAD", "refs/heads/main")
		await refs.setRef(TEMPLATE, "refs/heads/main", rewindTo)
		const proof = `${TEMPLATE}/copy-proof`
		await copyTemplateRepo(db.sql, TEMPLATE, proof)
		await assertCanonicalStoreFixture(db.sql, proof, {
			encodings: { kind: "exact", objects: [] },
			objects,
			refs: [
				{ kind: "direct", name: "refs/heads/main", oid: parseOid(rewindTo) },
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			],
		})
		await assertTemplateCopyFaithful(db.sql, TEMPLATE, proof)

		// Calibrate: one un-raced clone (the longest actor), timed wall-to-wall.
		// Every actor's start offset is a fraction of this.
		const calRepo = "race/pgr/cal"
		await copyTemplateRepo(db.sql, TEMPLATE, calRepo)
		const calDest = join(mkdtempSync(join(tmpdir(), "pgr-cal-")), "c")
		scratch.push(calDest)
		const calStart = Date.now()
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			repoUrl(server, calRepo),
			calDest,
		])
		cloneMs = Date.now() - calStart
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("graced: an acked push stays servable and the repo converges; at any grace: an OK clone is sound", async () => {
		const breaks: string[] = []
		const tally: Record<string, number> = {}
		const bump = (k: string) => {
			tally[k] = (tally[k] ?? 0) + 1
		}
		// Overlap telemetry — recorded, not asserted: how many of the three
		// mutating actors (push, gc, repack) had their execution window intersect
		// the raced clone's window, per iteration.
		const overlaps: Record<string, number> = {}

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const repo = `race/pgr/${i}`
			const url = repoUrl(server, repo)
			// Grace flips per FULL offset-matrix cycle, never in lockstep with it —
			// `i % 2` aliased against `i % 6` and starved half the combinations.
			const grace = Math.floor(i / 6) % 2 === 0 ? 0 : 60

			// Pre-race state in one copy: full history, main rewound to leave orphans.
			await copyTemplateRepo(db.sql, TEMPLATE, repo)

			// A brand-new commit on top of the rewound tip — unique per iteration.
			await spawnGit(["reset", "-q", "--hard", rewindTo], { cwd: client })
			writeFileSync(join(client, "race.txt"), `iteration ${i} ${Date.now()}\n`)
			await spawnGit(["add", "race.txt"], { cwd: client })
			await spawnGit(["commit", "-q", "-m", `race ${i}`], { cwd: client })
			const pushed = (
				await spawnGit(["rev-parse", "HEAD"], { cwd: client })
			).stdout.trim()

			const row = i % 6
			const dPush = Math.round((PUSH_FRACTIONS[row] as number) * cloneMs)
			const dGc = Math.round((GC_FRACTIONS[row] as number) * cloneMs)
			const dRepack = Math.round((REPACK_FRACTIONS[row] as number) * cloneMs)
			const dClone = Math.round((CLONE_FRACTIONS[row] as number) * cloneMs)

			let pushErr: unknown
			let repackErr: unknown
			let gcErr: unknown
			let cloneErr: unknown
			const dest = join(mkdtempSync(join(tmpdir(), "pgr-dest-")), "c")
			scratch.push(dest)

			const raceStart = Date.now()
			const settle = { clone: 0, gc: 0, push: 0, repack: 0 }
			await Promise.allSettled([
				sleep(dPush)
					.then(() =>
						spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: client }).catch(
							(e) => {
								pushErr = e
							},
						),
					)
					.finally(() => {
						settle.push = Date.now() - raceStart
					}),
				sleep(dGc)
					.then(() =>
						gc
							.gc(repo, { batchLimit: 40, graceSeconds: grace, maintain: false })
							.catch((e) => {
								gcErr = e
							}),
					)
					.finally(() => {
						settle.gc = Date.now() - raceStart
					}),
				sleep(dRepack)
					.then(() =>
						repack.repack(repo).catch((e) => {
							repackErr = e
						}),
					)
					.finally(() => {
						settle.repack = Date.now() - raceStart
					}),
				sleep(dClone)
					.then(() =>
						spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest]).catch(
							(e) => {
								cloneErr = e
							},
						),
					)
					.finally(() => {
						settle.clone = Date.now() - raceStart
					}),
			])
			const actorStarts = { gc: dGc, push: dPush, repack: dRepack }
			const mutatorsInCloneWindow = (
				Object.keys(actorStarts) as (keyof typeof actorStarts)[]
			).filter((k) => actorStarts[k] < settle.clone && settle[k] > dClone).length
			overlaps[`mutators=${mutatorsInCloneWindow}`] =
				(overlaps[`mutators=${mutatorsInCloneWindow}`] ?? 0) + 1

			const problems: string[] = []
			const tolerated: string[] = []

			// Q2 — a clone that reported success must hand git a sound repository.
			// Hard in BOTH arms: canonical upload-pack holds this even under a
			// concurrent `gc --prune=now`.
			if (cloneErr === undefined) {
				try {
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				} catch (e) {
					problems.push(`CLONE-SAID-OK-BUT-FSCK-FAILED: ${msg(e)}`)
				}
			}

			// Q1 — a push git reported as SUCCESSFUL must stay fetchable. Asserted in
			// the graced arm only: at grace 0 git itself promises nothing (`--prune=now`
			// against a live push), so a swallowed closure is tallied, not a break.
			if (pushErr === undefined) {
				const ls = await spawnGit(["ls-remote", url, "refs/heads/main"], { cwd: client })
				const serverTip = ls.stdout.trim().split(/\s+/)[0] ?? ""
				if (serverTip !== pushed) {
					// gc never touches refs — a vanished ref is a hard break at ANY grace.
					problems.push(`ACKED PUSH LOST THE REF: server main=${serverTip.slice(0, 12)}`)
				} else {
					const v = join(mkdtempSync(join(tmpdir(), "pgr-verify-")), "c")
					scratch.push(v)
					try {
						await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, v])
						await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: v })
						const h = (await spawnGit(["rev-parse", "HEAD"], { cwd: v })).stdout.trim()
						if (h !== pushed) problems.push(`ACKED PUSH: clone HEAD ${h} != ${pushed}`)
					} catch (e) {
						;(grace === 0 ? tolerated : problems).push(
							`ACKED PUSH NOT SERVABLE: ${msg(e)}`,
						)
					}
					rmSync(v, { force: true, recursive: true })
				}
			}

			// Q3 — convergence: one more repack, one more clone, must be servable.
			try {
				await repack.repack(repo)
				const c2 = join(mkdtempSync(join(tmpdir(), "pgr-conv-")), "c")
				scratch.push(c2)
				await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, c2])
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: c2 })
				rmSync(c2, { force: true, recursive: true })
			} catch (e) {
				// An eaten grace-0 push leaves main pointing at a reclaimed closure —
				// permanent by design, the state git documents for --prune=now against
				// live traffic. Tolerated ONLY alongside that tallied loss; any other
				// non-convergence is real damage at any grace.
				;(grace === 0 && tolerated.length > 0 ? tolerated : problems).push(
					`DID NOT CONVERGE: ${msg(e)}`,
				)
			}
			for (const t of tolerated) bump(`tolerated[grace=0] ${t.split(":")[0]}`)

			bump(`grace=${grace} push=${pushErr === undefined ? "ok" : "err"}`)
			if (repackErr !== undefined) bump("repack-threw")
			if (gcErr !== undefined) bump("gc-threw")
			if (cloneErr !== undefined) bump("raced-clone-failed")

			rmSync(dest, { force: true, recursive: true })
			if (problems.length > 0) {
				for (const p of problems) bump(`BREAK[grace=${grace}] ${p.split(":")[0]}`)
				breaks.push(`iteration ${i} (grace ${grace}s): ${problems.join(" | ")}`)
			}
		}

		console.log(
			`overlap telemetry (recorded, not asserted): mutating actors intersecting the clone window — ${JSON.stringify(overlaps)}`,
		)
		expect(breaks, JSON.stringify(tally, null, 2)).toEqual([])
	}, 1_800_000)
})

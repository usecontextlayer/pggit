/**
 * The in-band refusal path has a hard size ceiling, and the GC-vs-serve race is
 * what walks into it.
 *
 * When `routeServeSet` reports missing objects, `buildPack` raises
 * `WantNotFoundError([...missingWants, ...rest])` — EVERY missing oid, not just
 * the wants. `handleFetch` turns that into `encodeErr(err.message)` =
 * `encodePktLine("ERR upload-pack: not our ref <oid> <oid> ...")`, and
 * `encodePktLine` THROWS above WRITER_MAX_PAYLOAD (65515 bytes). The throw
 * happens inside handleFetch's own catch block, so it escapes to the app's
 * onError and becomes an HTTP 500.
 *
 * At 41 bytes per oid the flip is around 1,597 missing objects. That is exactly
 * what a GC sweeping a large orphaned span mid-fetch produces: the SAME race
 * that answers cleanly ("fatal: remote error: upload-pack: not our ref ...")
 * when a hundred objects are gone answers with "RPC failed; HTTP 500" once a few
 * thousand are — the error path stops being an error path precisely when the
 * damage is largest.
 *
 * Part 1 (deterministic, no race): a real `git fetch <url> <sha>...` naming N
 * absent objects, N swept across the ceiling.
 * Part 2 (the race): a real fetch of a rewound tip while `gc(graceSeconds: 0)`
 * sweeps a large orphaned span, counting how often the refusal degrades into a
 * 500 with the pkt-line cap as the underlying server error.
 *
 * Part 1 is DETERMINISTIC — above ~1,597 missing oids the
 * refusal is always a 500 — so its N sweep is frozen exactly, and `RUNS`/`REWIND`
 * stay at this scale: the raced half needs the orphaned span to be
 * thousands of objects for the sweep to cross the ceiling. Part 2's gc-start
 * delays are NOT frozen: absolute milliseconds would tie the
 * race to one machine's serve speed, so each run times one un-raced fetch of the
 * same shape and sweeps the gc start across FRACTIONS of that measured wall
 * (0–16%, the serve's opening phase — the gc must get ahead of the serve's
 * missing-object check for the refusal to grow). That calibration is also why 12
 * iterations carry the coverage the source spread over 20 (ruling 5,
 * docs/2026-08-20-test-efficiency.md). Part 2's per-iteration pre-race state
 * (full history seeded, tier built, ref rewound) is assembled by COPYING a
 * template repo's rows — the dominant cost was re-seeding the ~10k-object set
 * every iteration; the template's first copy is proven canonical AND
 * byte-faithful.
 */
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
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
const RUNS = 1200
const REWIND = 1100
/** N missing objects per part-1 probe, swept across the ~1,597-oid ceiling. */
const MISSING_SWEEP = [10, 500, 1500, 1590, 1600, 1700, 4000]
const TEMPLATE = "errpkt/race/template"
/** Where in the measured un-raced fetch wall each iteration's gc starts — dense
 * across the serve's opening phase, where the gc must land to have swept enough
 * of the orphaned span before the serve's missing-object check reads it. */
const DELAY_FRACTIONS = [
	0, 0.002, 0.005, 0.01, 0.018, 0.03, 0.045, 0.06, 0.08, 0.1, 0.13, 0.16,
] as const

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function classify(err: unknown): "PROTO" | "HTTP500" | "OTHER" | "OK" {
	if (err === undefined) return "OK"
	const m = msg(err)
	if (/HTTP 500|internal server error/i.test(m)) return "HTTP500"
	if (/not our ref|remote error/i.test(m)) return "PROTO"
	return "OTHER"
}

describe("race — the in-band refusal path's pkt-line size ceiling", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let gc: Gc
	let src = ""
	let objects: GitObjectWithOid[] = []
	let tip = ""
	let rewindTo = ""
	let fetchMs = 0
	const scratch: string[] = []

	// The app logs internal (500) errors with console.error; capture them so the
	// underlying server-side cause is attributable without touching the database.
	const serverErrors: string[] = []
	const realError = console.error.bind(console)
	const drainServerErrors = (): string[] => serverErrors.splice(0, serverErrors.length)

	beforeAll(async () => {
		console.error = (...args: unknown[]) => {
			serverErrors.push(
				args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "),
			)
		}

		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		const commits = await commitsOldestFirst(src, "HEAD")
		tip = commits[commits.length - 1] as string
		rewindTo = commits[commits.length - 1 - REWIND] as string

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		gc = createGc(db.sql)
		repack = createRepack(db.sql)

		// Template for part 2: the per-iteration pre-race state — full history
		// seeded, tier built over it, ref rewound to orphan the span GC eats.
		await store.putPack(TEMPLATE, objects)
		await refs.setRef(TEMPLATE, "refs/heads/main", tip)
		await refs.setSymref(TEMPLATE, "HEAD", "refs/heads/main")
		await repack.repack(TEMPLATE)
		await refs.setRef(TEMPLATE, "refs/heads/main", rewindTo)
		const proof = `${TEMPLATE}/copy-proof`
		await copyTemplateRepo(db.sql, TEMPLATE, proof)
		await assertCanonicalStoreFixture(db.sql, proof, {
			encodings: { kind: "exact", objects: repackEligibleObjects(objects) },
			objects,
			refs: [
				{ kind: "direct", name: "refs/heads/main", oid: parseOid(rewindTo) },
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			],
		})
		await assertTemplateCopyFaithful(db.sql, TEMPLATE, proof)

		// Calibrate: one un-raced fetch of the exact per-iteration shape, timed
		// wall-to-wall. The raced gc delays are fractions of this.
		const calRepo = "errpkt/race/cal"
		await copyTemplateRepo(db.sql, TEMPLATE, calRepo)
		const calDest = join(mkdtempSync(join(tmpdir(), "errpkt-cal-")), "c")
		scratch.push(calDest)
		await spawnGit(["init", "-q", "-b", "main", calDest])
		const calStart = Date.now()
		await spawnGit(
			["-c", "protocol.version=2", "fetch", "-q", repoUrl(server, calRepo), tip],
			{ cwd: calDest },
		)
		fetchMs = Date.now() - calStart
	}, 900_000)

	afterAll(async () => {
		console.error = realError
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	// Part 1 — deterministic: a fetch naming N objects the repo does not have. The
	// refusal must stay in-band at EVERY size; an HTTP 500 means the error path
	// stopped being an error path.
	it("refuses in-band at every missing-object count, never an HTTP 500", async () => {
		const repo = "errpkt/base"
		await store.putPack(repo, objects.slice(0, 50))
		await refs.setRef(repo, "refs/heads/main", tip)
		await refs.setSymref(repo, "HEAD", "refs/heads/main")
		const url = repoUrl(server, repo)

		const observed: string[] = []
		const overflows: string[] = []
		for (const n of MISSING_SWEEP) {
			const dest = join(mkdtempSync(join(tmpdir(), "errpkt-")), "c")
			scratch.push(dest)
			await spawnGit(["init", "-q", "-b", "main", dest])
			const wants = Array.from({ length: n }, () => randomBytes(20).toString("hex"))
			drainServerErrors()
			let err: unknown
			await spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, ...wants], {
				cwd: dest,
			}).catch((e) => {
				err = e
			})
			const verdict = classify(err)
			const srv = drainServerErrors()
			const capHit = srv.some((s) => /exceeds writer cap/.test(s))
			observed.push(`N=${n} ${verdict}${capHit ? " <- pkt-line writer cap" : ""}`)
			rmSync(dest, { force: true, recursive: true })
			if (verdict === "HTTP500") {
				overflows.push(
					`N=${n}: HTTP 500${capHit ? " from the pkt-line writer cap" : ""} — ` +
						`server: ${srv[0]?.slice(0, 120) ?? "?"}`,
				)
			}
		}

		expect(overflows, observed.join("\n")).toEqual([])
	}, 900_000)

	// Part 2 — the same ceiling, reached by the GC race rather than by hand.
	it("a gc(graceSeconds: 0) racing a fetch never degrades the refusal past the writer cap", async () => {
		const observed: string[] = []
		const capHits: string[] = []
		// Overlap telemetry — recorded, not asserted: whether each iteration's gc
		// ran inside the fetch serve it races ("in"), spilled past it ("straddle"),
		// or started after the serve finished ("late", a wasted arm).
		const overlaps = { in: 0, late: 0, straddle: 0 }

		for (let i = 0; i < ITERS; i++) {
			const repo = `errpkt/race/${i}`
			const url = repoUrl(server, repo)
			// Pre-race state in one copy: full history, tier built, ref rewound.
			await copyTemplateRepo(db.sql, TEMPLATE, repo)

			const dest = join(mkdtempSync(join(tmpdir(), "errpkt-race-")), "c")
			scratch.push(dest)
			await spawnGit(["init", "-q", "-b", "main", dest])
			const fraction = DELAY_FRACTIONS[i % DELAY_FRACTIONS.length] as number
			const delay = Math.round(fraction * fetchMs)
			drainServerErrors()
			let err: unknown
			const raceStart = Date.now()
			let serveSettleMs = 0
			let racerSettleMs = 0
			await Promise.allSettled([
				spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, tip], {
					cwd: dest,
				})
					.catch((e) => {
						err = e
					})
					.finally(() => {
						serveSettleMs = Date.now() - raceStart
					}),
				sleep(delay)
					.then(() =>
						gc
							.gc(repo, { batchLimit: 500, graceSeconds: 0, maintain: false })
							.catch(() => undefined),
					)
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
			const verdict = classify(err)
			const srv = drainServerErrors()
			const capHit = srv.some((s) => /exceeds writer cap/.test(s))
			observed.push(`iter ${i} gcAt=+${delay}ms ${verdict}${capHit ? "+pktcap" : ""}`)
			rmSync(dest, { force: true, recursive: true })
			// Break on the BEHAVIOUR — an HTTP 500 is the degradation, whether or not
			// the writer cap named itself in the log. The cap substring stays purely
			// as attribution, exactly as part 1 uses it: a reworded internal message
			// must not be able to turn this loop green.
			if (verdict === "HTTP500" || capHit) {
				capHits.push(
					`iteration ${i} (gc at +${delay}ms): ${verdict} — ` +
						`${srv.find((s) => /writer cap/.test(s))?.slice(0, 120) ?? srv[0]?.slice(0, 120) ?? "?"}`,
				)
			}
		}

		console.log(
			`overlap telemetry (recorded, not asserted): gc vs fetch serve — in=${overlaps.in} straddle=${overlaps.straddle} late=${overlaps.late}`,
		)
		expect(capHits, observed.join("\n")).toEqual([])
		// …and a run where every fetch failed for an unrelated reason is not a pass
		// either: at least one iteration has to have reached the serve path.
		expect(
			observed.filter((o) => o.includes("OK") || o.includes("PROTO")).length,
			observed.join("\n"),
		).toBeGreaterThan(0)
	}, 1_800_000)
})

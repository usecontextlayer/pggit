/**
 * RACE: hunting a SHORT PACK — a fetch the server reports as SUCCESS (HTTP 200,
 * header count == emitted count) whose pack is missing objects the client needs.
 *
 * The hypothesis is structural, in `reachableClosure` (store/reachability.ts):
 * blobs are not edges, so after the recursive CTE fixes the tree/commit closure
 * the walk RE-READS every present tree's content in a second, separate query to
 * enumerate its blobs. A tree deleted between those two statements simply does
 * not come back from the second query — its blobs are never enumerated, and
 * NOTHING records that. The tree itself stays in `present` (hence in the served
 * set), so:
 *
 *   1. GC deletes tree T after the CTE saw it            -> T's blobs vanish
 *                                                           from the closure
 *   2. a concurrent writer re-inserts T (same oid)       -> `buildPack`'s batch
 *                                                           read finds T again,
 *                                                           so the "vanished
 *                                                           while packing" guard
 *                                                           never fires
 *   3. the pack ships complete-looking, minus T's blobs  -> the CLIENT fails
 *
 * Step 2 stands in for a concurrent push that re-sends objects GC just reclaimed
 * (a force-push retry, a mirror sync): `putPack` is the same `insertObjects`
 * path receive-pack ingests through.
 *
 * Outcomes, by what the CLIENT reports:
 *   OK        clone succeeded and fsck --strict is clean
 *   PROTO     in-band "not our ref"    (server refused; clean)
 *   HTTP500   server-side hard error   (loud; ugly but not corruption)
 *   SHORTPACK server said 200, git says the remote did not send everything  <-- the defect
 *   CORRUPT   clone exit 0, fsck fails                                      <-- the defect
 *
 * Converted from `breakage/race--short-pack-closure-truncation.ts` (`--iters=60
 * --runs=250 --rewind=120 --resurrect=trees`). Probabilistic. The swept
 * gc-start delays are NOT the source's: it froze absolute milliseconds
 * ([0..60]ms), which tie the hunt to one machine's serve speed — the hunted gap
 * (between the closure CTE and the tree-content re-read) sits in the serve's
 * opening phase, and on a slower or loaded box 60 ms is still before the CTE
 * finishes while on a faster one it overshoots the whole closure. Each run
 * instead times one un-raced fetch of the same shape and sweeps the gc start
 * across FRACTIONS of that measured wall (0–7%, the serve's opening phase), so
 * the arms straddle the CTE→re-read seam on any box. That calibration is also
 * why 20 iterations carry the coverage the source spread over 60: one full
 * 20-arm sweep concentrated on a window the arms actually hit beats three
 * sweeps of absolute delays that drift off it
 * (docs/2026-08-20-test-efficiency.md, ruling 5).
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { PackInputObject } from "@/pack/write-pack"
import type { GitServer } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { loadReachableObjects } from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 20
const RUNS = 250
const REWIND = 120
/** Where in the measured un-raced fetch wall each iteration's gc starts. The
 * hunted seam lives in the serve's opening closure phase, so the sweep is
 * dense there and stops at 7% — a gc landing later races nothing this file
 * hunts. */
const DELAY_FRACTIONS = [
	0, 0.001, 0.002, 0.003, 0.004, 0.006, 0.008, 0.01, 0.013, 0.016, 0.02, 0.024, 0.028,
	0.033, 0.038, 0.044, 0.05, 0.056, 0.063, 0.07,
] as const
/** What the concurrent writer re-inserts. `trees` cycles far faster than `all`,
 * and trees are the only objects whose loss is SILENT (a lost blob still trips
 * the closure's presence check and a lost tree trips the serve path's guard —
 * only a tree that leaves and comes BACK slips between the two). */
// "trees" is the mode that reproduces the race; "all"/"none" are the documented
// alternatives the source script could be run with. Cast the initializer (not the
// binding) so its apparent type stays the union — otherwise TS narrows a const to
// its literal and flags the other two branches as dead (TS2367).
const RESURRECT = "trees" as "trees" | "all" | "none"

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Verdict = "OK" | "PROTO" | "HTTP500" | "SHORTPACK" | "CORRUPT" | "OTHER"

function classifyFetchError(err: unknown): Verdict {
	const m = msg(err)
	if (/HTTP 500|internal server error/i.test(m)) return "HTTP500"
	if (/not our ref|unadvertised/i.test(m)) return "PROTO"
	if (
		/did not send all necessary objects|index-pack failed|unable to read|bad object|missing blob|fsck error/i.test(
			m,
		)
	) {
		return "SHORTPACK"
	}
	return "OTHER"
}

describe("race — a truncated want-closure serving a short pack", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let gc: Gc
	let src = ""
	let objects: PackInputObject[] = []
	let resurrectSet: PackInputObject[] = []
	let tip = ""
	let rewindTo = ""
	let fetchMs = 0
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		const commits = (
			await spawnGit(["rev-list", "--reverse", "HEAD"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		tip = commits[commits.length - 1] as string
		rewindTo = commits[commits.length - 1 - REWIND] as string
		resurrectSet =
			RESURRECT === "all" ? objects : objects.filter((o) => o.type === "tree")

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		gc = createGc(db.sql)
		repack = createRepack(db.sql)

		// Calibrate: one repo in the exact per-iteration shape, one un-raced fetch
		// of it, timed wall-to-wall. The raced gc delays are fractions of this.
		const calRepo = "race/short/cal"
		await store.putPack(calRepo, objects)
		await refs.setRef(calRepo, "refs/heads/main", tip)
		await refs.setSymref(calRepo, "HEAD", "refs/heads/main")
		await repack.repack(calRepo)
		await refs.setRef(calRepo, "refs/heads/main", rewindTo)
		const calDest = join(mkdtempSync(join(tmpdir(), "short-cal-")), "c")
		scratch.push(calDest)
		await spawnGit(["init", "-q", "-b", "main", calDest])
		const calStart = Date.now()
		await spawnGit(
			["-c", "protocol.version=2", "fetch", "-q", repoUrl(server, calRepo), tip],
			{ cwd: calDest },
		)
		fetchMs = Date.now() - calStart
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	// A fetch either refuses cleanly or delivers everything: the server must never
	// report success and hand the client a pack short of the closure it promised.
	it("never serves a short pack: a fetch racing gc + a re-inserting writer stays sound", async () => {
		const breaks: string[] = []
		const verdicts: string[] = []

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const repo = `race/short/${i}`
			const url = repoUrl(server, repo)
			await store.putPack(repo, objects)
			await refs.setRef(repo, "refs/heads/main", tip)
			await refs.setSymref(repo, "HEAD", "refs/heads/main")
			await repack.repack(repo)
			await refs.setRef(repo, "refs/heads/main", rewindTo)

			const dest = join(mkdtempSync(join(tmpdir(), "short-dest-")), "c")
			scratch.push(dest)
			await spawnGit(["init", "-q", "-b", "main", dest])

			const fraction = DELAY_FRACTIONS[i % DELAY_FRACTIONS.length] as number
			const delay = Math.round(fraction * fetchMs)
			let stop = false
			// The resurrector: keep re-inserting the FULL object set for as long as
			// the race runs, so anything GC removes can come back before the serve
			// path's own presence check reaches it.
			const resurrect = (async () => {
				if (RESURRECT === "none") return
				while (!stop) {
					await store.putPack(repo, resurrectSet).catch(() => undefined)
				}
			})()

			let fetchErr: unknown
			const fetchP = spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, tip], {
				cwd: dest,
			}).catch((e) => {
				fetchErr = e
			})
			const gcP = sleep(delay).then(() =>
				gc
					.gc(repo, { batchLimit: 15, graceSeconds: 0, maintain: false })
					.catch(() => undefined),
			)
			// The resurrector races the FETCH's presence checks; it must stop when
			// the fetch settles, NOT when gc does — a zero-grace sweep can never
			// drain while the resurrector keeps re-inserting what it just deleted,
			// so gating `stop` on gc livelocks the iteration (observed: a 36-minute
			// wedge in the full-suite gate).
			await fetchP
			stop = true
			await resurrect
			await gcP

			let verdict: Verdict
			let detail = ""
			if (fetchErr !== undefined) {
				verdict = classifyFetchError(fetchErr)
				detail = msg(fetchErr).split("\n").slice(0, 2).join(" ").slice(0, 160)
			} else {
				try {
					await spawnGit(["update-ref", "refs/heads/probe", tip], { cwd: dest })
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
					verdict = "OK"
				} catch (e) {
					verdict = "CORRUPT"
					detail = msg(e).split("\n").slice(0, 2).join(" ").slice(0, 160)
				}
			}
			verdicts.push(`iter ${i} gcAt=+${delay}ms ${verdict}`)
			rmSync(dest, { force: true, recursive: true })

			if (verdict === "SHORTPACK" || verdict === "CORRUPT") {
				breaks.push(`iteration ${i} (gc at +${delay}ms): ${verdict} — ${detail}`)
			}
		}

		expect(breaks, verdicts.join("\n")).toEqual([])
	}, 1_800_000)
})

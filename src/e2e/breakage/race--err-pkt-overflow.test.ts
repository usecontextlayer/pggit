/**
 * The in-band refusal path has a hard size ceiling, and the GC-vs-serve race is
 * what walks into it.
 *
 * When `buildPack`'s want-closure comes back with missing objects it raises
 * `WantNotFoundError([...want.missing])` — EVERY missing oid, not just the
 * wants. `handleFetch` turns that into `encodeErr(err.message)` =
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
 * Converted from `breakage/race--err-pkt-overflow.ts` (`--iters=20 --runs=1200
 * --rewind=1100`). Part 1 is DETERMINISTIC — above ~1,597 missing oids the
 * refusal is always a 500 — so its N sweep is frozen exactly; part 2's iteration
 * count and swept gc-start delays are frozen too.
 */
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
const RUNS = 1200
const REWIND = 1100
/** N missing objects per part-1 probe, swept across the ~1,597-oid ceiling. */
const MISSING_SWEEP = [10, 500, 1500, 1590, 1600, 1700, 4000]

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
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
	let objects: PackInputObject[] = []
	let tip = ""
	let rewindTo = ""
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
		const commits = (
			await spawnGit(["rev-list", "--reverse", "HEAD"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		tip = commits[commits.length - 1] as string
		rewindTo = commits[commits.length - 1 - REWIND] as string

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		gc = createGc(db.sql)
		repack = createRepack(db.sql)
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

		for (let i = 0; i < ITERS; i++) {
			const repo = `errpkt/race/${i}`
			const url = repoUrl(server, repo)
			await store.putPack(repo, objects)
			await refs.setRef(repo, "refs/heads/main", tip)
			await refs.setSymref(repo, "HEAD", "refs/heads/main")
			await repack.repack(repo)
			await refs.setRef(repo, "refs/heads/main", rewindTo)

			const dest = join(mkdtempSync(join(tmpdir(), "errpkt-race-")), "c")
			scratch.push(dest)
			await spawnGit(["init", "-q", "-b", "main", dest])
			const delay = [0, 2, 5, 10, 20, 35, 55, 80, 120, 180][i % 10] as number
			drainServerErrors()
			let err: unknown
			await Promise.allSettled([
				spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, tip], {
					cwd: dest,
				}).catch((e) => {
					err = e
				}),
				sleep(delay).then(() =>
					gc
						.gc(repo, { batchLimit: 500, graceSeconds: 0, maintain: false })
						.catch(() => undefined),
				),
			])
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

		expect(capHits, observed.join("\n")).toEqual([])
		// …and a run where every fetch failed for an unrelated reason is not a pass
		// either: at least one iteration has to have reached the serve path.
		expect(
			observed.filter((o) => o.includes("OK") || o.includes("PROTO")).length,
			observed.join("\n"),
		).toBeGreaterThan(0)
	}, 1_800_000)
})

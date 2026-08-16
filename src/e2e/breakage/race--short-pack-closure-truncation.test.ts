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
 * --runs=250 --rewind=120 --resurrect=trees`). Probabilistic: the iteration
 * count and the swept gc-start delays are frozen exactly as the script ran them.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import type { GitObjectType } from "@/object/object"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 60
const RUNS = 250
const REWIND = 120
/** What the concurrent writer re-inserts. `trees` cycles far faster than `all`,
 * and trees are the only objects whose loss is SILENT (a lost blob still trips
 * the closure's presence check and a lost tree trips the serve path's guard —
 * only a tree that leaves and comes BACK slips between the two). */
// "trees" is the mode that reproduces the race; "all"/"none" are the documented
// alternatives the source script could be run with. Cast the initializer (not the
// binding) so its apparent type stays the union — otherwise TS narrows a const to
// its literal and flags the other two branches as dead (TS2367).
const RESURRECT = "trees" as "trees" | "all" | "none"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Obj = { oid: string; type: GitObjectType; content: Buffer }

/** Every reachable object of a real repo, in ONE `cat-file --batch`. */
async function loadObjects(dir: string): Promise<Obj[]> {
	const list = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
	const oids = [
		...new Set(
			list.stdout
				.split("\n")
				.map((l) => l.slice(0, 40))
				.filter((o) => /^[0-9a-f]{40}$/.test(o)),
		),
	]
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
	})
	const buf = res.stdoutBytes
	const out: Obj[] = []
	let pos = 0
	while (pos < buf.length) {
		const nl = buf.indexOf(0x0a, pos)
		if (nl < 0) break
		const [oid, type, sizeStr] = buf.subarray(pos, nl).toString("latin1").split(" ")
		if (!oid || !type || !sizeStr) break
		const size = Number(sizeStr)
		const start = nl + 1
		out.push({
			content: buf.subarray(start, start + size),
			oid,
			type: type as GitObjectType,
		})
		pos = start + size + 1
	}
	return out
}

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
	let objects: Obj[] = []
	let resurrectSet: Obj[] = []
	let tip = ""
	let rewindTo = ""
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadObjects(src)
		const commits = (
			await spawnGit(["rev-list", "--reverse", "HEAD"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		tip = commits[commits.length - 1] as string
		rewindTo = commits[commits.length - 1 - REWIND] as string
		resurrectSet =
			RESURRECT === "all" ? objects : objects.filter((o) => o.type === "tree")

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		store = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		gc = createGc(db.sql)
		repack = createRepack(db.sql)
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	// A fetch either refuses cleanly or delivers everything: the server must never
	// report success and hand the client a pack short of the closure it promised.
	it("never serves a short pack: a fetch racing gc + a re-inserting writer stays sound", async () => {
		const breaks: string[] = []
		const verdicts: string[] = []

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const repo = `race/short/${i}`
			const url = `http://127.0.0.1:${server.port}/${repo}`
			await store.putPack(repo, objects)
			await refs.setRef(repo, "refs/heads/main", tip)
			await refs.setSymref(repo, "HEAD", "refs/heads/main")
			await repack.repack(repo)
			await refs.setRef(repo, "refs/heads/main", rewindTo)

			const dest = join(mkdtempSync(join(tmpdir(), "short-dest-")), "c")
			scratch.push(dest)
			await spawnGit(["init", "-q", "-b", "main", dest])

			const delay = [0, 1, 2, 3, 5, 7, 10, 14, 20, 28, 40, 60][i % 12] as number
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
			await Promise.allSettled([
				spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, tip], {
					cwd: dest,
				}).catch((e) => {
					fetchErr = e
				}),
				sleep(delay).then(() =>
					gc
						.gc(repo, { batchLimit: 15, graceSeconds: 0, maintain: false })
						.catch(() => undefined),
				),
			])
			stop = true
			await resurrect

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

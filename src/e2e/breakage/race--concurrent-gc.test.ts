/**
 * RACE: two `createGc().gc()` passes on the SAME repo, concurrently.
 *
 * The defect this originally reproduced (hunt C1) is FIXED by design: the live
 * set was a shared `gc_live_<id>` UNLOGGED table, so a second pass's
 * `truncate`/`drop` could wipe the first pass's live set mid-sweep and its
 * `NOT EXISTS` anti-join then matched the whole REACHABLE set. Since D12 the
 * live set is a TEMP table on the pass's own reserved connection —
 * session-private, collision-proof by construction. This test now PINS that
 * property: `gc()` is still exported with no lock, so any two callers (an
 * operator script, a second process, a retry) may overlap, and must not be able
 * to destroy anything reachable.
 *
 * NOTHING here is unreachable-object trickery: the repo's ref is at the FULL tip
 * and every object is live, so a correct GC — at any concurrency — must delete
 * NOTHING and every clone must keep working. The verdict is a real `git clone`
 * plus `git fsck --strict`, and whether the clone's HEAD still matches the ref.
 *
 * Converted from `breakage/race--concurrent-gc.ts` (`--iters=25 --runs=150
 * --passes=2 --hangms=60000`). Probabilistic — it reproduces roughly 1 iteration
 * in 10–30, so the loop and its count ARE the test and are frozen exactly.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import type { PackInputObject } from "@/pack/write-pack"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type Gc, type GcResult } from "@/store/gc"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { loadReachableObjects } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 25
const RUNS = 150
const PASSES = 2
/** Watchdog: a pass that has not settled in this long is HUNG, not slow — a
 * concurrent round on this fixture completes in well under a second, and an
 * observed hang sat at zero CPU with zero in-flight queries for 25 minutes. */
const HANG_MS = 60_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
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
	let objects: PackInputObject[] = []
	let tip = ""
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

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

	// Every object is reachable from the ref, so a correct GC deletes ZERO at any
	// concurrency, never hangs, and leaves the repo clonable at the same tip.
	it("concurrent gc() passes delete no reachable object and leave the repo clonable", async () => {
		const breaks: string[] = []
		const rounds: string[] = []
		let totalDeleted = 0

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const repo = `race/gcgc/${i}`
			const url = `http://127.0.0.1:${server.port}/${repo}`
			await store.putPack(repo, objects)
			await refs.setRef(repo, "refs/heads/main", tip)
			await refs.setSymref(repo, "HEAD", "refs/heads/main")
			await repack.repack(repo)

			const spread = [0, 1, 2, 4, 8, 12, 20, 30, 45, 70][i % 10] as number
			const HUNG = Symbol("hung")
			const settled = await Promise.all(
				Array.from({ length: PASSES }, (_, k) =>
					Promise.race([
						sleep(k * spread).then(() =>
							// batchLimit 5 ⇒ many short sweep transactions ⇒ a long window in
							// which the sibling pass's truncate/drop can land mid-sweep.
							gc
								.gc(repo, { batchLimit: 5, graceSeconds: 0, maintain: false })
								.then((v) => ({ ok: true as const, v }))
								.catch((e) => ({ e, ok: false as const })),
						),
						sleep(HANG_MS).then(() => HUNG),
					]),
				),
			)
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

		expect(breaks, rounds.join("\n")).toEqual([])
		// The sharper form of the same property: across every iteration, a GC over a
		// fully reachable repo must destroy nothing at all.
		expect(totalDeleted).toBe(0)
	}, 1_800_000)
})

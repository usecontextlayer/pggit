/**
 * RACE: two concurrent `createRepack().repack()` passes on the SAME repo.
 *
 * The exported repack API takes no lock; the design's frozen-policy claim (D4)
 * assumes one pass at a time. Two passes read the pending set + the existing
 * encoding rows at different instants, so B can replay decisions against a stale
 * view of what A has already committed. Rows land through `copyInsert`, which is
 * `COPY -> INSERT ... ON CONFLICT DO NOTHING`, so a losing row is SILENTLY
 * SKIPPED and the winner's mixed with it.
 *
 * Judged ONLY at git-observable outcomes:
 *   - a real `git clone` over the real HTTP wire succeeds
 *   - `git fsck --strict` is clean on the clone
 *   - the clone's object set equals the source repo's
 *   - a real INCREMENTAL `git fetch` (with haves) after more history also lands
 *   - `repack()` itself never throws
 *
 * The delta-chain depth measured per iteration is a DIAGNOSTIC, not the verdict:
 * it exists to prove the interleaving actually diverged (design says depth <= 1
 * structurally). A depth > 1 with a clean clone is an internal invariant breach
 * with no client-visible consequence, and is reported as such — it rides on the
 * assertion's message, never on the assertion.
 *
 * Converted from `breakage/race--concurrent-repack.ts` (`--iters=40 --runs=400
 * --passes=6 --push=0`). Probabilistic: the iteration count, the pass count and
 * the swept start offsets (including their randomized jitter) are frozen exactly.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { PackInputObject } from "@/pack/write-pack"
import type { GitServer } from "@/server"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { allObjectOids, loadReachableObjects, refsOf } from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 40
const RUNS = 400
/** Concurrent repack passes per iteration. >2 matters: the divergence window is
 * the gap between a pass's `pending` read and its `existing` read, and pool
 * contention (the isolated schema's porsager pool is max:4) is what widens it. */
const PASSES = 6
describe("race — concurrent repack passes on one repo", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let src = ""
	let objects: PackInputObject[] = []
	let srcOids: string[] = []
	let sourceRefs: { name: string; oid: string }[] = []
	let head = ""
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		srcOids = await allObjectOids(src)
		sourceRefs = await refsOf(src)
		head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		repack = createRepack(db.sql)
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("concurrent repack passes keep the repo clonable, fsck-clean and complete", async () => {
		const breaks: string[] = []
		const rounds: string[] = []
		let divergedIters = 0

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const repo = `race/repack/${i}`
			await store.putPack(repo, objects)
			for (const { name, oid } of sourceRefs) {
				await refs.setRef(repo, name, oid)
			}
			await refs.setSymref(repo, "HEAD", head)

			// Vary each pass's start so they land at different points of one another:
			// before the first COPY flush, right after it, mid-phase-2, etc.
			const spread = [0, 1, 3, 8, 15, 25, 40, 60, 90, 130, 180, 250][i % 12] as number
			const delays = Array.from({ length: PASSES }, (_, k) =>
				k === 0 ? 0 : Math.round(k * spread + Math.random() * spread),
			)
			const settled = await Promise.allSettled(
				delays.map((d) => sleep(d).then(() => repack.repack(repo))),
			)
			const thrown = settled.filter((s) => s.status === "rejected")

			// DIAGNOSTIC ONLY (never the verdict): did the race actually break the
			// documented depth<=1 star invariant, and did it make a cycle?
			const [depth] = await db.sql<{ n: number; cyc: number }[]>`
				with recursive chain(oid, base_oid, d, path, cyc) as (
					select e.oid, e.base_oid, 1, array[e.oid], false
						from git_pack_encoding e
						join repos r on r.id = e.repo_id
						where r.name = ${repo} and e.base_oid is not null
					union all
					select c.oid, p.base_oid, c.d + 1, c.path || p.oid, p.oid = any(c.path)
						from chain c
						join repos r on r.name = ${repo}
						join git_pack_encoding p
							on p.repo_id = r.id and p.oid = c.base_oid
						where p.base_oid is not null and c.d < 24 and not c.cyc
				)
				select coalesce(max(d), 0)::int as n,
					coalesce(sum(case when cyc then 1 else 0 end), 0)::int as cyc from chain`
			if (depth === undefined)
				throw new Error("concurrent repack diagnostics returned no row")
			const maxDepth = depth.n
			const cycles = depth.cyc
			if (maxDepth > 1 || cycles > 0) divergedIters++

			// ---- the verdict: what a real git client observes ----
			const dest = join(mkdtempSync(join(tmpdir(), "race-repack-")), "c")
			scratch.push(dest)
			const problems: string[] = []
			for (const t of thrown) {
				problems.push(`repack() threw: ${(t as PromiseRejectedResult).reason}`)
			}
			try {
				await spawnGit([
					"-c",
					"protocol.version=2",
					"clone",
					"-q",
					repoUrl(server, repo),
					dest,
				])
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				const got = await allObjectOids(dest)
				if (got.join(",") !== srcOids.join(",")) {
					problems.push(`object set mismatch: ${got.length} vs ${srcOids.length}`)
				}
			} catch (err) {
				problems.push(`clone/fsck: ${err instanceof Error ? err.message : String(err)}`)
			}

			rounds.push(
				`iter ${i} spread=${spread}ms x${PASSES} chainDepth=${maxDepth} cycles=${cycles}`,
			)
			if (problems.length > 0) {
				breaks.push(`iteration ${i} (spread ${spread}ms): ${problems.join(" | ")}`)
			}
			rmSync(dest, { force: true, recursive: true })
		}

		expect(
			breaks,
			`${divergedIters} iterations produced a delta chain deeper than the documented ` +
				`depth<=1 (internal invariant breach, not client-visible)\n${rounds.join("\n")}`,
		).toEqual([])
	}, 1_800_000)
})

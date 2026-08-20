/**
 * PROBE 4 — repack racing GC over GARBAGE.
 *
 * S4: design D5 orders the drain GC-then-repack "so it encodes survivors, not
 * garbage". Repack's pending set is the whole inventory, NOT the reachable set —
 * so when the two overlap, repack is encoding rows for objects the sweep is
 * deleting underneath it. This drives that head-on: force-push FIRST (so the
 * garbage has no encoding rows yet), then run both at once. The race is
 * probabilistic, so it keeps the source probe's five trials rather than one.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const REPO = "r"
const RUNS = 150
/** Where main is force-pushed BEFORE any repack — ~110 commits of garbage that has
 * no encoding rows yet, so the pass and the sweep contend over the same objects. */
const REWIND_TO = 40
const TRIALS = [1, 2, 3, 4, 5]

/** Leftovers a repack/GC interleaving must never produce. */
type Leftovers = { ghost: number; orphan: number; depth2: number }

type Trial = {
	trial: number
	notes: string[]
	leftovers: Leftovers
	clone: TestResult<string>
}

const settled = (r: PromiseSettledResult<unknown>): string =>
	r.status === "fulfilled"
		? JSON.stringify(r.value)
		: `THREW ${String(r.reason).slice(0, 90)}`

describe("repack × GC over garbage — the race", () => {
	let root = ""
	let src = ""
	const trials: Trial[] = []

	beforeAll(async () => {
		const pgBaseUrl = inject("pgBaseUrl")
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-garbage-race-"))
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		const commits = await commitsOldestFirst(src)
		const rewindTo = commits[REWIND_TO]
		if (!rewindTo) throw new Error(`fixture too short: no commit #${REWIND_TO}`)

		async function withSchema<T>(fn: (db: IsolatedDb) => Promise<T>): Promise<T> {
			const db = await createIsolatedSchema(pgBaseUrl)
			try {
				return await fn(db)
			} finally {
				await db.drop()
			}
		}

		for (const trial of TRIALS) {
			const result = await withSchema(async (db) => {
				let server: GitServer | undefined
				try {
					const objects = createObjectStore(db.sql)
					const refs = createRefStore(db.sql)
					await seedRepoIntoStore(REPO, src, { objects, refs })
					// Force push BEFORE any repack: ~110 commits of garbage with no rows yet.
					await refs.setRef(REPO, "refs/heads/main", rewindTo)

					const [a, b] = await Promise.allSettled([
						createRepack(db.sql).repack(REPO),
						createGc(db.sql).gc(REPO, { graceSeconds: 0, maintain: false }),
					])

					const [leftovers] = await db.sql<Leftovers[]>`
						select
							(select count(*) from git_pack_encoding e
								where not exists (select 1 from git_object o where o.oid=e.oid))::int as ghost,
							(select count(*) from git_pack_encoding e where e.base_oid is not null
								and not exists (select 1 from git_object o where o.oid=e.base_oid))::int as orphan,
							(select count(*) from git_pack_encoding d
								join git_pack_encoding b on b.repo_id=d.repo_id and b.oid=d.base_oid
								where d.base_oid is not null and b.base_oid is not null)::int as depth2`
					if (!leftovers) throw new Error("leftover query returned no row")

					const liveServer = await serveOnPort(createGitApp({ objects, refs }), 0)
					server = liveServer
					const dest = join(root, `c${trial}`)
					const clone = await captureTestResult(async () => {
						await spawnGit([
							"-c",
							"protocol.version=2",
							"clone",
							"-q",
							"--mirror",
							`http://127.0.0.1:${liveServer.port}/${REPO}`,
							dest,
						])
						const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], {
							cwd: dest,
						})
						return `${fsck.stdout}${fsck.stderr}`.trim()
					})

					return {
						clone,
						leftovers,
						notes: [`repack: ${settled(a)}`, `gc: ${settled(b)}`],
						trial,
					}
				} finally {
					await server?.close()
				}
			})
			trials.push(result)
		}
	}, 600_000)

	afterAll(() => {
		if (src) rmSync(src, { force: true, recursive: true })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("S4: no repack/GC interleaving leaves the tier holding garbage", () => {
		expect(trials).toHaveLength(TRIALS.length)
		for (const t of trials) {
			const context = `trial ${t.trial}: ${t.notes.join(" | ")}`
			expect(
				t.leftovers.ghost,
				`${context} — rows for objects that no longer exist`,
			).toBe(0)
			expect(t.leftovers.orphan, `${context} — deltas whose base OBJECT is gone`).toBe(0)
			expect(t.leftovers.depth2, `${context} — deltas whose base is itself a delta`).toBe(
				0,
			)
		}
	}, 300_000)

	it("S4: the raced repo still clones fsck-clean, every trial", () => {
		for (const t of trials) {
			const context = `trial ${t.trial}: ${t.notes.join(" | ")}`
			expect(t.clone.kind, testResultContext(t.clone, context)).toBe("succeeded")
			if (t.clone.kind === "succeeded") expect(t.clone.value, context).toBe("")
		}
	}, 300_000)
})

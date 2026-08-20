/**
 * FINDING (fixed) — after `admin.deleteRepo(name)` and a re-push under the SAME
 * name, a long-lived `createRepack(sql)` (and `createGc(sql)`) silently no-op'd
 * on that repo forever, so the encoding tier was never built and the repo's
 * garbage never reclaimed. No error, no log line: `repack()` returned
 * `{wholes:0,deltas:0}` — indistinguishable from "already covered".
 *
 * The mechanism, entirely from the public surface: each of those components
 * built its OWN memoizing `createRepoResolver`, whose name->id cache was safe
 * only while `RepoResolver.invalidate()` could reach it — and `admin.deleteRepo`
 * invalidates only the ONE resolver inside its `createGitDeps` composition.
 * `createRepack(pg)` / `createGc(pg)` take a bare `Sql` and sat outside it, so
 * they kept resolving the dead id: queries hit a repo_id with zero rows and
 * reported zero work. The fix: both resolve the name fresh per pass through the
 * unmemoized `lookupRepoId` primitive, so a recreate is picked up on the very
 * next pass.
 *
 * Why this lands with the delta work rather than being purely pre-existing: W1
 * puts `createRepack()` on the drain (`drainRepo`), built once per process and
 * held for its lifetime — exactly the shape that goes stale. The GC half has sat
 * built-but-unwired since 2026-07-09, so this is the first time the pattern gets
 * a second, size-critical consumer.
 *
 * Proven below with git-observable evidence only:
 *   1. long-lived repack after recreate -> {0,0}, long-lived gc -> all zeros
 *   2. a FRESH repack/gc over the same schema does real work — so (1) was a lie
 *   3. a mirror clone taken between (1) and (2) receives a pack N times larger
 *      than the one taken after (2): the tier really was absent on the wire
 *
 * Full scale: 200 append-only run commits. Every assertion states the contract —
 * the long-lived components do the work, the fresh ones find nothing left, and
 * the two clones are the same size.
 *
 * Originated as breakage probe
 * `lifecycle--repo-recreate-silent-noop-repack.ts` (exit 1 when the silent no-op
 * reproduced); fixed by resolving the repo name fresh per pass through the
 * unmemoized `lookupRepoId` primitive.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type GcResult } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack, type RepackResult } from "@/store/repack"
import { buildLifecycleSource, commitsOldestFirst } from "@/testing/append-only-repo"
import { packFileBytes, requiredAt } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/recreated"

/** Bytes of the pack a mirror clone received (client-side, no server counters). */
async function clonedPackBytes(url: string, dest: string): Promise<number> {
	await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
	await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
	const bytes = await packFileBytes(dest)
	rmSync(dest, { force: true, recursive: true })
	return bytes
}

describe("lifecycle breakage — silent no-op repack after repo recreate", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	let longLivedRepack: RepackResult = { deltas: 0, wholes: 0 }
	let longLivedGc: GcResult = { deletedObjects: 0, epoch: "unchanged" }
	let freshRepack: RepackResult = { deltas: 0, wholes: 0 }
	let freshGc: GcResult = { deletedObjects: 0, epoch: "unchanged" }
	let packWhileStale = 0
	let packAfterFresh = 0

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-recreate-"))

		const src = join(root, "src")
		await buildLifecycleSource(src, 200)
		const commits = await commitsOldestFirst(src, "main")
		const tip = requiredAt(commits, commits.length - 1, "main commit history")
		const mid = requiredAt(commits, 80, "main commit history")

		const deps = createGitDeps(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		// The long-lived components a server process holds for its whole lifetime.
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = createRefStore(db.sql)

		// --- life 1: normal operation, caches warm ---------------------------
		await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
		await repack.repack(REPO)
		await gc.gc(REPO, { graceSeconds: 0 })

		// --- the lifecycle event ---------------------------------------------
		await deps.admin.deleteRepo(REPO)
		await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
		// make real garbage so a working gc would have something to report
		await refs.setRef(REPO, "refs/heads/main", mid)

		// --- life 2: the SAME long-lived components ---------------------------
		longLivedRepack = await repack.repack(REPO)
		longLivedGc = await gc.gc(REPO, { graceSeconds: 0 })

		packWhileStale = await clonedPackBytes(url, join(root, "c1"))

		// --- the truth, from freshly built components -------------------------
		freshRepack = await createRepack(db.sql).repack(REPO)
		// clone BEFORE the fresh gc, so the pack delta below is the TIER alone
		packAfterFresh = await clonedPackBytes(url, join(root, "c2"))
		freshGc = await createGc(db.sql).gc(REPO, { graceSeconds: 0 })
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("re-encodes the recreated repo through the long-lived repack", () => {
		expect(longLivedRepack.wholes + longLivedRepack.deltas).toBeGreaterThan(0)
	})

	it("leaves a freshly built repack nothing to do", () => {
		// The inverse half of the lie: the source only calls it a reproduction when
		// the long-lived pass reported zero AND a fresh one then found real work.
		expect(freshRepack).toEqual({ deltas: 0, wholes: 0 })
	})

	it("reclaims the recreated repo's garbage through the long-lived gc", () => {
		expect(longLivedGc.deletedObjects).toBeGreaterThan(0)
	})

	it("leaves a freshly built gc nothing to reclaim", () => {
		expect(freshGc.deletedObjects).toBe(0)
	})

	it("serves the encoded tier on the wire while the long-lived repack held it", () => {
		// The git-observable consequence: with the tier really built by the
		// long-lived pass, the clone taken before the fresh repack cannot be the
		// bigger one — under the bug it is several times larger.
		expect(packWhileStale).toBeLessThanOrEqual(packAfterFresh)
	})
})

/**
 * After `admin.deleteRepo(name)` and a re-push under the SAME name, long-lived
 * `createRepack(sql)` and `createGc(sql)` instances must target the new incarnation
 * rather than silently returning no work.
 *
 * A repo name does not identify a stable database row: deletion cascades the old
 * `repos.id`, and recreation assigns a new one. Each pass must therefore resolve
 * the name afresh through `lookupRepoId`; retaining an id across passes would make
 * a process-lifetime component query the dead incarnation and report no work.
 *
 * Full scale: 200 append-only run commits. Every assertion states the contract —
 * the long-lived components do the work, the fresh ones find nothing left, and
 * the two clones are the same size.
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

describe("regressions/lifecycle — silent no-op repack after repo recreate", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	let longLivedRepack: RepackResult = { deltas: 0, wholes: 0 }
	let longLivedGc: GcResult = { deletedObjects: 0, epoch: "unchanged" }
	let freshRepack: RepackResult = { deltas: 0, wholes: 0 }
	let freshGc: GcResult = { deletedObjects: 0, epoch: "unchanged" }
	let packAfterLongLived = 0
	let packAfterFresh = 0

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-repo-recreate-long-lived-"))

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

		packAfterLongLived = await clonedPackBytes(url, join(root, "c1"))

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
		// If the long-lived pass resolved the recreated repo, no encoding work remains.
		expect(freshRepack).toEqual({ deltas: 0, wholes: 0 })
	})

	it("reclaims the recreated repo's garbage through the long-lived gc", () => {
		expect(longLivedGc.deletedObjects).toBeGreaterThan(0)
	})

	it("leaves a freshly built gc nothing to reclaim", () => {
		expect(freshGc.deletedObjects).toBe(0)
	})

	it("serves the encoded tier on the wire while the long-lived repack held it", () => {
		// A fresh no-op repack cannot make the encoded response smaller than the pack
		// already served after the long-lived pass.
		expect(packAfterLongLived).toBeLessThanOrEqual(packAfterFresh)
	})
})

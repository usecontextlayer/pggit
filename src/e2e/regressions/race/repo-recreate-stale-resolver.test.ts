/**
 * NOT a race — a deterministic lifecycle defect found while hunting them, kept
 * here because it silently disabled the entire delta tier for a repo.
 *
 * `createRepack(pg)` and `createGc(pg)` each built their OWN memoizing
 * `createRepoResolver`, invalidated ONLY through the instance `createRepoAdmin`
 * was handed — so `admin.deleteRepo()` invalidated the serving stores and left a
 * long-lived Repack / Gc holding the DEAD id: a repo deleted and re-created
 * under the same name resolved, inside those two components only, to a row that
 * no longer existed, and `repack()` reported `{wholes: 0, deltas: 0}` —
 * indistinguishable from "already fully covered" — forever. The fix: both
 * components resolve the name FRESH each pass via the unmemoized `lookupRepoId`
 * primitive; memoization stays only inside the `createGitDeps` composition,
 * whose admin can actually invalidate it. This pins the correct behaviour: the
 * client-visible bytes of a re-created repo's clone shrink exactly as a
 * fresh-instance control's do.
 *
 * The check is git-observable and needs no DB assertion: clone the re-created
 * repo and compare the bytes that ARRIVED (the client's own pack files) against
 * a control repo that used a fresh Repack instance.
 *
 * Deterministic — no loop to preserve.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps, type GitDeps } from "@/index"
import type { PackInputObject } from "@/pack/write-pack"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { loadReachableObjects, packFileBytes } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const RUNS = 400

describe("race — a long-lived Repack against a deleted-and-recreated repo name", () => {
	let db: IsolatedDb
	let server: GitServer
	let deps: GitDeps
	/** ONE long-lived Repack, exactly as a platform process would hold one beside
	 * its scheduler (design W1: "extend drainRepo to run createRepack().repack()"). */
	let repack: Repack
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
		deps = createGitDeps(db.sql)
		repack = createRepack(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("still deltifies a re-created repo name, so its clones never regress to full size", async () => {
		const repo = "lifecycle/workspace"
		const seed = async (): Promise<void> => {
			await deps.objects.putPack(repo, objects)
			await deps.refs.setRef(repo, "refs/heads/main", tip)
			await deps.refs.setSymref(repo, "HEAD", "refs/heads/main")
		}
		const cloneBytes = async (tag: string): Promise<number> => {
			const dest = join(mkdtempSync(join(tmpdir(), `stale-${tag}-`)), "c")
			scratch.push(dest)
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				`http://127.0.0.1:${server.port}/${repo}`,
				dest,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			const n = await packFileBytes(dest)
			rmSync(dest, { force: true, recursive: true })
			return n
		}

		// 1. First incarnation: seed, repack through the long-lived instance, clone.
		await seed()
		const r1 = await repack.repack(repo)
		const bytes1 = await cloneBytes("first")

		// 2. Delete it through the public admin surface, then re-create the SAME
		//    name (the platform re-provisioning a workspace).
		await deps.admin.deleteRepo(repo)
		await seed()

		// 3. Repack through the SAME instance the platform has been holding.
		const r2 = await repack.repack(repo)
		const bytes2 = await cloneBytes("recreated")

		// 4. Control: a FRESH Repack instance on the same repo, same schema.
		const r3 = await createRepack(db.sql).repack(repo)
		const bytes3 = await cloneBytes("fresh-instance")

		const evidence =
			`first incarnation : repack ${r1.wholes}w/${r1.deltas}d, clone ${bytes1} B\n` +
			`after delete+recreate, SAME Repack instance:\n` +
			`                  : repack ${r2.wholes}w/${r2.deltas}d, clone ${bytes2} B\n` +
			`then a FRESH Repack instance on the same repo:\n` +
			`                  : repack ${r3.wholes}w/${r3.deltas}d, clone ${bytes3} B`

		// The first pass encoded something at all — otherwise everything below is vacuous.
		expect(r1.wholes + r1.deltas, evidence).toBeGreaterThan(0)
		// The long-lived instance must encode the RE-CREATED repo, not report a no-op.
		expect(r2.wholes + r2.deltas, evidence).toBeGreaterThan(0)
		// And having done so, a fresh instance finds nothing left pending.
		expect(r3.wholes + r3.deltas, evidence).toBe(0)
		// Client-visible: the re-created repo serves a deltified pack, never the
		// undeltified one a stale resolver leaves it stuck on.
		expect(bytes2, evidence).toBeLessThanOrEqual(bytes3)
	}, 900_000)
})

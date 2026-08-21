/**
 * WIRE — a tree whose repack anchor is NOT reachable from every commit that reaches
 * it (the cross-lineage shared-tree shape), fetched through a closure that excludes
 * the anchor. (Converted from `breakage/wire--orphan-branch-shared-tree.ts`.)
 *
 * Git trees are content-addressed, so one tree oid can sit in unrelated histories.
 * Repack fixes that tree's delta base once, from whichever lineage the topo walk
 * reaches first. A client that clones ONLY the other branch gets a served set that
 * does not contain the anchor. Under design D8', that no-have request must fall
 * back to the whole form; a thin request may use the anchor only when `clientHas`
 * proves it.
 *
 * Shapes covered:
 *   1. `--single-branch` clone of the branch whose closure excludes the anchor.
 *   2. Fetch of one branch by exact ref after the other was repacked.
 *   3. Full clone (both branches) as the control.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const REPO = "workspace/probe/orphan"
/** Enough versions of `dir/` that the star topology forms real anchors + deltas. */
const STEPS = 90

type CloneCase = {
	label: string
	clone: TestResult<{ fsck: TestResult<void>; sharedTree: TestResult<boolean> }>
}

describe("wire — a cross-lineage shared tree served in every closure", () => {
	let db: IsolatedDb
	let server: GitServer
	const { cleanup: cleanupScratch, make: mk } = createScratchArena()

	let sharedTree = ""
	const cases: CloneCase[] = []
	let orphanOntoMain: TestResult<void>

	beforeAll(async () => {
		const src = mk("src")
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		mkdirSync(join(src, "dir"))

		// main: `dir/` grows one file per commit — a long same-path tree lineage, so
		// late versions are deltas against an anchor many commits back.
		for (let i = 0; i < STEPS; i++) {
			writeFileSync(join(src, "dir", `f${i}.txt`), `content ${i}\n`.repeat(4))
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", `step ${i}`], { cwd: src })
		}
		// The tree we will strand: `dir/` as of the LAST commit.
		sharedTree = (await spawnGit(["rev-parse", "main:dir"], { cwd: src })).stdout.trim()

		// An ORPHAN branch (no shared ancestry with main) whose root tree contains the
		// very same `dir/` tree oid. Built with plumbing so nothing about main is
		// reachable from it.
		const rootTree = (
			await spawnGit(["mktree"], {
				cwd: src,
				input: `040000 tree ${sharedTree}\tdir\n`,
			})
		).stdout.trim()
		const orphanCommit = (
			await spawnGit(["commit-tree", rootTree, "-m", "orphan"], { cwd: src })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/orphan", orphanCommit], { cwd: src })

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const url = repoUrl(server, REPO)

		await spawnGit(["push", "-q", url, "--all"], { cwd: src })
		await createRepack(db.sql).repack(REPO)

		const shapes: [string, string[]][] = [
			[
				"single-branch orphan (anchor NOT in closure)",
				["clone", "-q", "--single-branch", "--branch", "orphan", url],
			],
			["full clone (control)", ["clone", "-q", url]],
			[
				"single-branch main (control)",
				["clone", "-q", "--single-branch", "--branch", "main", url],
			],
		]
		for (const [label, args] of shapes) {
			const dest = join(mk("dst"), "c")
			const clone = await captureTestResult(() =>
				spawnGit([
					"-c",
					"protocol.version=2",
					"-c",
					"transfer.fsckobjects=true",
					"-c",
					"fetch.fsckobjects=true",
					...args,
					dest,
				]),
			)
			if (clone.kind === "failed") {
				cases.push({ clone, label })
				continue
			}
			const fsck = await captureTestResult(async () => {
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			})
			// The shared tree must have arrived, byte-identical.
			const sharedTreeResult = await captureTestResult(async () => {
				const got = await spawnGit(["cat-file", "tree", sharedTree], { cwd: dest })
				const want = await spawnGit(["cat-file", "tree", sharedTree], { cwd: src })
				return got.stdoutBytes.equals(want.stdoutBytes)
			})
			cases.push({
				clone: { kind: "succeeded", value: { fsck, sharedTree: sharedTreeResult } },
				label,
			})
		}

		// Fetch just the orphan ref into a clone that already has ALL of main. The
		// anchor is then a `have`, so D8' may use it as an external base for a thin
		// pack; otherwise the object ships whole.
		const withMain = join(mk("wm"), "c")
		orphanOntoMain = await captureTestResult(async () => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--single-branch",
				"--branch",
				"main",
				url,
				withMain,
			])
			await spawnGit(
				[
					"-c",
					"protocol.version=2",
					"-c",
					"transfer.fsckobjects=true",
					"fetch",
					"-q",
					"origin",
					"refs/heads/orphan:refs/remotes/origin/orphan",
				],
				{ cwd: withMain },
			)
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: withMain })
		})
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		cleanupScratch()
	})

	it("clones fsck-clean in every closure, anchor present or not", () => {
		expect(cases.length).toBe(3)
		for (const c of cases) {
			expect(c.clone.kind, testResultContext(c.clone, c.label)).toBe("succeeded")
			if (c.clone.kind === "succeeded") {
				expect(
					c.clone.value.fsck.kind,
					testResultContext(c.clone.value.fsck, `${c.label} fsck`),
				).toBe("succeeded")
			}
		}
	})

	it("delivers the shared tree byte-identically in every closure", () => {
		for (const c of cases) {
			if (c.clone.kind === "failed") continue
			const at = `${c.label} — shared tree ${sharedTree}`
			expect(
				c.clone.value.sharedTree.kind,
				testResultContext(c.clone.value.sharedTree, at),
			).toBe("succeeded")
			if (c.clone.value.sharedTree.kind === "succeeded") {
				expect(c.clone.value.sharedTree.value, at).toBe(true)
			}
		}
	})

	it("fetches the orphan ref onto a main-only clone (the anchor is a have)", () => {
		expect(
			orphanOntoMain.kind,
			testResultContext(orphanOntoMain, "orphan onto main"),
		).toBe("succeeded")
	})
})

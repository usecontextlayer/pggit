/**
 * WIRE — a tree whose repack anchor is NOT reachable from every commit that reaches
 * it (the cross-lineage shared-tree shape), fetched through a closure that excludes
 * the anchor. (Converted from `breakage/wire--orphan-branch-shared-tree.ts`.)
 *
 * Git trees are content-addressed, so one tree oid can sit in unrelated histories.
 * Repack fixes that tree's delta base once, from whichever lineage the topo walk
 * reaches first. A client that clones ONLY the other branch gets a served set that
 * does not contain the anchor — design D8's `base in served set` test is the sole
 * thing standing between that and an unresolvable REF_DELTA.
 *
 * Shapes covered:
 *   1. `--single-branch` clone of the branch whose closure excludes the anchor.
 *   2. Fetch of one branch by exact ref after the other was repacked.
 *   3. Full clone (both branches) as the control.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/orphan"
/** Enough versions of `dir/` that the star topology forms real anchors + deltas. */
const STEPS = 90

type CloneCase = {
	label: string
	cloneError: string | null
	fsckError: string | null
	sharedTreeError: string | null
	sharedTreeMatches: boolean
}

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run()
		return null
	} catch (err) {
		return String(err)
	}
}

describe("wire — a cross-lineage shared tree served in every closure", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	let sharedTree = ""
	const cases: CloneCase[] = []
	let orphanOntoMainError: string | null = null

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

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

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
			const cloneError = await errorOf(() =>
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
			if (cloneError !== null) {
				cases.push({
					cloneError,
					fsckError: null,
					label,
					sharedTreeError: null,
					sharedTreeMatches: false,
				})
				continue
			}
			const fsckError = await errorOf(() =>
				spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest }),
			)
			// The shared tree must have arrived, byte-identical.
			let sharedTreeMatches = false
			const sharedTreeError = await errorOf(async () => {
				const got = await spawnGit(["cat-file", "tree", sharedTree], { cwd: dest })
				const want = await spawnGit(["cat-file", "tree", sharedTree], { cwd: src })
				sharedTreeMatches = got.stdoutBytes.equals(want.stdoutBytes)
			})
			cases.push({ cloneError, fsckError, label, sharedTreeError, sharedTreeMatches })
		}

		// Fetch just the orphan ref into a clone that already has ALL of main — the
		// anchor is then a `have`, so the delta must ship whole.
		const withMain = join(mk("wm"), "c")
		orphanOntoMainError = await errorOf(async () => {
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
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("clones fsck-clean in every closure, anchor present or not", () => {
		expect(cases.length).toBe(3)
		for (const c of cases) {
			expect(c.cloneError, c.label).toBeNull()
			expect(c.fsckError, c.label).toBeNull()
		}
	})

	it("delivers the shared tree byte-identically in every closure", () => {
		for (const c of cases) {
			expect(c.sharedTreeError, `${c.label} — shared tree ${sharedTree}`).toBeNull()
			expect(c.sharedTreeMatches, `${c.label} — shared tree ${sharedTree}`).toBe(true)
		}
	})

	it("fetches the orphan ref onto a main-only clone (the anchor is a have)", () => {
		expect(orphanOntoMainError).toBeNull()
	})
})

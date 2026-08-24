/**
 * Lifecycle regression — degenerate ends of the sequence space:
 *  1. delete EVERY ref, gc(0) to zero objects, repack an empty repo, clone it
 *  2. refill with the identical history (same oids, fresh rows) and repack again
 *  3. a ref that points straight at a TREE whose encoding is a delta, with the
 *     anchor kept alive only by a SECOND ref — then that second ref is deleted
 *  4. a tree that becomes EMPTY (the 4b825dc... empty tree object) mid-history
 * Every step is checked against a file:// reference remote replaying the same
 * visible history: clone, fsck --strict, object-set equality, byte digest.
 *
 * The fixture retains its full scale of 60 seed commits.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ZERO_OID } from "@/object/oid"
import type { GitServer } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack, type RepackResult } from "@/store/repack"
import { buildLifecycleSource, commitsOldestFirst } from "@/testing/append-only-repo"
import {
	compareMirrorClones,
	type MirrorComparison,
	requiredAt,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { captureTestResult, type TestResult } from "@/testing/test-result"

const REPO = "workspace/slate/degenerate"

type CloneCheck = TestResult<MirrorComparison> & { tag: string }

describe("regressions/lifecycle — drain to empty and refill", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const checks: CloneCheck[] = []
	let emptied: RepackResult = { deltas: 0, wholes: 0 }
	let refilled: RepackResult = { deltas: 0, wholes: 0 }
	let refilledSecond: RepackResult = { deltas: 0, wholes: 0 }

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		root = mkdtempSync(join(tmpdir(), "pggit-drain-empty-refill-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildLifecycleSource(src, 60)
		const commits = await commitsOldestFirst(src, "main")
		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
		const url = repoUrl(server, REPO)
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = fixture.deps.refs

		const check = async (tag: string): Promise<void> => {
			const a = dir(`pg-${tag}`)
			const b = dir(`rf-${tag}`)
			const result = await captureTestResult(() =>
				compareMirrorClones({ dest: a, url }, { dest: b, url: `file://${ref}` }),
			)
			checks.push({ ...result, tag })
			if (result.kind === "succeeded") {
				rmSync(a, { force: true, recursive: true })
				rmSync(b, { force: true, recursive: true })
			}
		}
		const pushBoth = async (sha: string, name: string): Promise<void> => {
			await spawnGit(["push", "-q", url, `${sha}:${name}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${sha}:${name}`], { cwd: src })
		}
		const delBoth = async (name: string, old: string): Promise<void> => {
			await refs.applyRefUpdates(
				REPO,
				[{ newOid: ZERO_OID, oldOid: old, ref: name }],
				false,
			)
			await spawnGit(["update-ref", "-d", name, old], { cwd: ref })
		}

		const tip = requiredAt(commits, commits.length - 1, "main commit history")
		await pushBoth(tip, "refs/heads/main")
		await repack.repack(REPO)
		await check("seeded")

		// --- 1. drain to empty ------------------------------------------------
		await delBoth("refs/heads/main", tip)
		await gc.gc(REPO, { batchLimit: 1_000_000, graceSeconds: 0 })
		await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
		emptied = await repack.repack(REPO)
		await check("emptied")

		// --- 2. refill with the identical history ------------------------------
		await pushBoth(tip, "refs/heads/main")
		refilled = await repack.repack(REPO)
		refilledSecond = await repack.repack(REPO)
		await check("refilled")

		// --- 3. a ref straight at a TREE, anchor held alive by a second ref -----
		// commit 40's root tree is (with ANCHOR_EVERY=32) a delta against an earlier
		// anchor; park a tag on it while another ref keeps the anchor reachable.
		const midTree = (
			await spawnGit(
				["rev-parse", `${requiredAt(commits, 40, "main commit history")}^{tree}`],
				{ cwd: src },
			)
		).stdout.trim()
		await pushBoth(midTree, "refs/tags/tree40")
		await pushBoth(requiredAt(commits, 40, "main commit history"), "refs/heads/keep40")
		await repack.repack(REPO)
		await check("tree-ref")

		// drop the branch that kept the anchor reachable, keep the tree tag
		await delBoth("refs/heads/keep40", requiredAt(commits, 40, "main commit history"))
		await refs.setRef(
			REPO,
			"refs/heads/main",
			requiredAt(commits, 10, "main commit history"),
		)
		await spawnGit(
			["update-ref", "refs/heads/main", requiredAt(commits, 10, "main commit history")],
			{ cwd: ref },
		)
		await gc.gc(REPO, { batchLimit: 1_000_000, graceSeconds: 0 })
		await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
		await check("tree-ref-orphaned-anchor")
		await repack.repack(REPO)
		await check("tree-ref-repaired")

		// --- 4. a directory that becomes EMPTY --------------------------------
		// git cannot store an empty directory, but `git commit-tree` over a tree
		// that contains the empty-tree object can — exercise the zero-length object
		// through encode + serve.
		const emptyTree = (
			await spawnGit(["hash-object", "-t", "tree", "-w", "--stdin"], {
				cwd: src,
				input: Buffer.alloc(0),
			})
		).stdout.trim()
		const mk = await spawnGit(["mktree"], {
			cwd: src,
			input: `040000 tree ${emptyTree}\tempty\n`,
		})
		const withEmpty = (
			await spawnGit(["commit-tree", mk.stdout.trim(), "-m", "empty dir"], { cwd: src })
		).stdout.trim()
		await pushBoth(withEmpty, "refs/heads/emptydir")
		await repack.repack(REPO)
		await check("empty-tree")
	}, 900_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("serves a clonable repo at every degenerate point", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "failed" ? [`${c.tag}: ${String(c.error).slice(0, 250)}`] : [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "succeeded" &&
				(c.value.objects.onlyServed.length > 0 || c.value.objects.onlyOracle.length > 0)
					? [
							`${c.tag}: onlyServed=${c.value.objects.onlyServed.length} onlyOracle=${c.value.objects.onlyOracle.length}`,
						]
					: [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "succeeded" ? [{ refs: c.value.served.refs, tag: c.tag }] : [],
			),
		).toEqual(
			checks.flatMap((c) =>
				c.kind === "succeeded" ? [{ refs: c.value.oracle.refs, tag: c.tag }] : [],
			),
		)
	})

	it("serves byte-identical objects to the oracle", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "succeeded" && c.value.served.digest !== c.value.oracle.digest
					? [c.tag]
					: [],
			),
		).toEqual([])
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "succeeded" && c.value.served.fsck.length > 0
					? [`${c.tag}: ${c.value.served.fsck}`]
					: [],
			),
		).toEqual([])
	})

	it("finds no repack work in a repo with zero objects", () => {
		expect(emptied).toEqual({ deltas: 0, wholes: 0 })
	})

	it("re-encodes a refilled repo, then converges on the second pass", () => {
		expect(refilled.wholes + refilled.deltas).toBeGreaterThan(0)
		expect(refilledSecond).toEqual({ deltas: 0, wholes: 0 })
	})
})

/**
 * Lifecycle breakage — histories the commit walk has to work for: merges (2 and 3
 * parents), reverts (a commit whose tree EQUALS an ancestor's tree, so a lineage
 * runs backwards), criss-cross merges, and identical-content branches. Each
 * shape is repacked, gc'd, force-moved and cloned against a file:// oracle.
 *
 * Full scale: a 120-commit append-only seed, two 25-commit feature lineages, an
 * octopus merge, a criss-cross pair, a twin root, then a collapse (every branch
 * force-moved back to commit 10) followed by gc(0) and a repair repack.
 *
 * Originated as exploration-9 probe
 * `lifecycle--merge-revert-history-shapes.ts` (exit 1 on a mismatch against the
 * file:// oracle); fixed.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack, type RepackResult } from "@/store/repack"
import {
	appendLifecycleBranch,
	buildLifecycleSource,
	commitsOldestFirst,
} from "@/testing/append-only-repo"
import {
	listDifferences,
	type MirrorState,
	mirrorClone,
	requiredAt,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/shapes"

type CloneCheck =
	| { kind: "failed"; tag: string; error: unknown }
	| {
			kind: "succeeded"
			tag: string
			objectsOnlyPg: number
			objectsOnlyRef: number
			refsPg: string[]
			refsRef: string[]
			fsck: string
	  }

describe("lifecycle breakage — merge, revert and criss-cross history shapes", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const checks: CloneCheck[] = []
	let collapseConverge: RepackResult = { deltas: 0, wholes: 0 }

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-shapes-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildLifecycleSource(src, 120)
		const commits = await commitsOldestFirst(src, "main")
		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
		const url = repoUrl(server, REPO)
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = fixture.deps.refs

		const tree = async (rev: string): Promise<string> =>
			(await spawnGit(["rev-parse", `${rev}^{tree}`], { cwd: src })).stdout.trim()
		const commitTree = async (
			t: string,
			parents: string[],
			msg: string,
		): Promise<string> =>
			(
				await spawnGit(
					["commit-tree", t, ...parents.flatMap((p) => ["-p", p]), "-m", msg],
					{
						cwd: src,
					},
				)
			).stdout.trim()

		const check = async (tag: string): Promise<void> => {
			const a = dir(`pg-${tag}`)
			const b = dir(`rf-${tag}`)
			let pgc: MirrorState
			try {
				pgc = await mirrorClone(url, a)
			} catch (error) {
				checks.push({ error, kind: "failed", tag })
				return
			}
			const rfc = await mirrorClone(`file://${ref}`, b)
			const od = listDifferences(pgc.objects, rfc.objects)
			checks.push({
				fsck: pgc.fsck,
				kind: "succeeded",
				objectsOnlyPg: od.onlyLeft.length,
				objectsOnlyRef: od.onlyRight.length,
				refsPg: pgc.refs,
				refsRef: rfc.refs,
				tag,
			})
			rmSync(a, { force: true, recursive: true })
			rmSync(b, { force: true, recursive: true })
		}
		const pushBoth = async (sha: string, name: string): Promise<void> => {
			await spawnGit(["push", "-q", url, `${sha}:${name}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${sha}:${name}`], { cwd: src })
		}

		// 1. linear seed
		await pushBoth(requiredAt(commits, 119, "main commit history"), "refs/heads/main")
		await repack.repack(REPO)

		// 2. REVERT: a commit whose tree equals commit 60's tree, parented on the tip.
		//    The path lineage now runs BACKWARDS through an already-anchored version.
		const revert = await commitTree(
			await tree(requiredAt(commits, 60, "main commit history")),
			[requiredAt(commits, 119, "main commit history")],
			"revert to 60",
		)
		await pushBoth(revert, "refs/heads/main")
		await repack.repack(REPO)
		await check("revert")

		// 3. MERGES: two feature lineages off different points, merged with the
		//    merge's tree taken from one side (so first-parent diffing sees a big jump).
		const f1 = await appendLifecycleBranch(
			src,
			"f1",
			requiredAt(commits, 40, "main commit history"),
			"f1",
			25,
		)
		const f2 = await appendLifecycleBranch(
			src,
			"f2",
			requiredAt(commits, 80, "main commit history"),
			"f2",
			25,
		)
		await pushBoth(f1, "refs/heads/f1")
		await pushBoth(f2, "refs/heads/f2")
		const merge = await commitTree(await tree(f2), [revert, f1, f2], "octopus merge")
		await pushBoth(merge, "refs/heads/main")
		await repack.repack(REPO)
		await check("octopus")

		// 4. criss-cross: two merges each taking the other's side first
		const m1 = await commitTree(await tree(f1), [f1, f2], "m1")
		const m2 = await commitTree(await tree(f2), [f2, f1], "m2")
		await pushBoth(m1, "refs/heads/x1")
		await pushBoth(m2, "refs/heads/x2")
		const m3 = await commitTree(await tree(m1), [m1, m2], "m3")
		const m4 = await commitTree(await tree(m2), [m2, m1], "m4")
		await pushBoth(m3, "refs/heads/x1")
		await pushBoth(m4, "refs/heads/x2")
		await repack.repack(REPO)
		await check("crisscross")

		// 5. identical-content branch: the same tree under a different commit
		const twin = await commitTree(
			await tree(requiredAt(commits, 100, "main commit history")),
			[],
			"twin root",
		)
		await pushBoth(twin, "refs/heads/twin")
		await repack.repack(REPO)
		await check("twin")

		// 6. force-move everything back, gc, repack, clone
		await refs.setRef(
			REPO,
			"refs/heads/main",
			requiredAt(commits, 10, "main commit history"),
		)
		await spawnGit(
			["update-ref", "refs/heads/main", requiredAt(commits, 10, "main commit history")],
			{ cwd: ref },
		)
		for (const b of ["f1", "f2", "x1", "x2"]) {
			await refs.setRef(
				REPO,
				`refs/heads/${b}`,
				requiredAt(commits, 10, "main commit history"),
			)
			await spawnGit(
				["update-ref", `refs/heads/${b}`, requiredAt(commits, 10, "main commit history")],
				{ cwd: ref },
			)
		}
		await gc.gc(REPO, { graceSeconds: 0 })
		await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
		await check("collapsed-pre-repack")
		await repack.repack(REPO)
		collapseConverge = await repack.repack(REPO)
		await check("collapsed-post-repack")
	}, 900_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("serves a clonable repo for every history shape", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "failed" ? [`${c.tag}: ${String(c.error).slice(0, 300)}`] : [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "succeeded" && (c.objectsOnlyPg > 0 || c.objectsOnlyRef > 0)
					? [`${c.tag}: onlyPG=${c.objectsOnlyPg} onlyREF=${c.objectsOnlyRef}`]
					: [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "succeeded" ? [{ refs: c.refsPg, tag: c.tag }] : [],
			),
		).toEqual(
			checks.flatMap((c) =>
				c.kind === "succeeded" ? [{ refs: c.refsRef, tag: c.tag }] : [],
			),
		)
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "succeeded" && c.fsck.length > 0 ? [`${c.tag}: ${c.fsck}`] : [],
			),
		).toEqual([])
	})

	it("converges the repack after the collapse", () => {
		expect(collapseConverge).toEqual({ deltas: 0, wholes: 0 })
	})
})

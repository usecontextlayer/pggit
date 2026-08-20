/**
 * Lifecycle breakage — 50-round incremental chain against a LONG-LIVED clone:
 * push 3 commits → (sometimes) repack → (sometimes) gc → fetch. Every round the
 * clone must stay fsck-clean and object-identical to a file:// reference remote
 * subjected to the same sequence. Mixed encoded/unencoded serving throughout.
 *
 * Full scale — 160 seed commits, 50 incremental rounds, then 8 rewind rounds
 * where a force-move + gc(0) + repack precedes a forced fetch and a FRESH mirror
 * clone (the real oracle for the SERVED state). Repack runs on 2 of every 3
 * rounds and gc every 7th, so the served pack mixes encoded and unencoded
 * objects.
 *
 * Originated as exploration-6 probe `lifecycle--long-lived-clone-chain.ts` (exit
 * 1 when a round diverged from the reference remote); fixed.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { buildLifecycleSource, commitsOldestFirst } from "@/testing/append-only-repo"
import {
	listDifferences,
	mirrorClone,
	parseRevListObjectOids,
	requiredAt,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/incr"
const ROUNDS = 50
const REWIND_ROUNDS = 8

type RoundResult =
	| { kind: "failed"; label: string; error: unknown }
	| {
			kind: "succeeded"
			label: string
			objectsOnlyPg: number
			objectsOnlyRef: number
			fsck: string
	  }

describe("lifecycle breakage — long-lived clone chain", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const incremental: RoundResult[] = []
	const rewinds: RoundResult[] = []

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-chain-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildLifecycleSource(src, 160)
		const commits = await commitsOldestFirst(src, "main")

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])

		const url = repoUrl(server, REPO)
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = fixture.deps.refs

		// round 0: seed one commit, then two long-lived mirror clones
		await spawnGit(
			[
				"push",
				"-q",
				url,
				`${requiredAt(commits, 0, "main commit history")}:refs/heads/main`,
			],
			{ cwd: src },
		)
		await spawnGit(
			[
				"push",
				"-q",
				ref,
				`${requiredAt(commits, 0, "main commit history")}:refs/heads/main`,
			],
			{ cwd: src },
		)
		await repack.repack(REPO)
		const live = dir("live")
		const liveRef = dir("liveref")
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, live])
		await spawnGit(["clone", "-q", "--mirror", `file://${ref}`, liveRef])

		for (let r = 1; r <= ROUNDS; r++) {
			const upto = Math.min(1 + r * 3, commits.length)
			const tip = requiredAt(commits, upto - 1, "main commit history")
			await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${tip}:refs/heads/main`], { cwd: src })
			// repack only on 2 out of every 3 rounds: the served pack mixes encoded
			// and unencoded objects.
			const didRepack = r % 3 !== 0
			if (didRepack) await repack.repack(REPO)
			// an occasional gc between push and repack (encodings never existed yet)
			if (r % 7 === 0) await gc.gc(REPO, { graceSeconds: 0 })

			const label = `round ${r} (repack=${didRepack})`
			try {
				await spawnGit(["fetch", "-q", "--prune", "origin"], { cwd: live })
			} catch (error) {
				incremental.push({ error, kind: "failed", label })
				continue
			}
			await spawnGit(["fetch", "-q", "--prune", "origin"], { cwd: liveRef })
			const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: live })
			const liveObjects = parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", "--all"], { cwd: live })).stdout,
			).sort()
			const referenceObjects = parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", "--all"], { cwd: liveRef })).stdout,
			).sort()
			const d = listDifferences(liveObjects, referenceObjects)
			incremental.push({
				fsck: `${fsck.stdout}${fsck.stderr}`.trim(),
				kind: "succeeded",
				label,
				objectsOnlyPg: d.onlyLeft.length,
				objectsOnlyRef: d.onlyRight.length,
			})
		}

		// now the same chain but with force-moves interleaved
		for (let r = 0; r < REWIND_ROUNDS; r++) {
			const back = requiredAt(commits, 40 + r * 5, "main commit history")
			await refs.setRef(REPO, "refs/heads/main", back)
			await spawnGit(["update-ref", "refs/heads/main", back], { cwd: ref })
			await gc.gc(REPO, { graceSeconds: 0 })
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
			await repack.repack(REPO)
			const forward = requiredAt(
				commits,
				Math.min(commits.length - 1, 60 + r * 8),
				"main commit history",
			)
			await spawnGit(["push", "-q", url, `${forward}:refs/heads/main`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${forward}:refs/heads/main`], { cwd: src })
			await repack.repack(REPO)

			const label = `rewind round ${r}`
			try {
				await spawnGit(
					["fetch", "-q", "--prune", "--force", "origin", "+refs/heads/*:refs/heads/*"],
					{ cwd: live },
				)
			} catch (error) {
				rewinds.push({ error, kind: "failed", label })
				continue
			}
			// a fresh clone is the real oracle for the SERVED state
			const fresh = dir(`fresh-${r}`)
			const freshRef = dir(`freshref-${r}`)
			const served = await mirrorClone(url, fresh)
			const oracle = await mirrorClone(`file://${ref}`, freshRef)
			const d = listDifferences(served.objects, oracle.objects)
			rewinds.push({
				fsck: served.fsck,
				kind: "succeeded",
				label,
				objectsOnlyPg: d.onlyLeft.length,
				objectsOnlyRef: d.onlyRight.length,
			})
			rmSync(fresh, { force: true, recursive: true })
			rmSync(freshRef, { force: true, recursive: true })
		}
	}, 1_800_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("serves every incremental fetch to the long-lived clone", () => {
		expect(
			incremental.flatMap((r) =>
				r.kind === "failed" ? [`${r.label}: ${String(r.error).slice(0, 300)}`] : [],
			),
		).toEqual([])
	})

	it("keeps the long-lived clone object-identical to the oracle", () => {
		expect(
			incremental.flatMap((r) =>
				r.kind === "succeeded" && (r.objectsOnlyPg > 0 || r.objectsOnlyRef > 0)
					? [`${r.label}: onlyPG=${r.objectsOnlyPg} onlyREF=${r.objectsOnlyRef}`]
					: [],
			),
		).toEqual([])
	})

	it("keeps the long-lived clone fsck --strict clean", () => {
		expect(
			incremental.flatMap((r) =>
				r.kind === "succeeded" && r.fsck.length > 0 ? [`${r.label}: ${r.fsck}`] : [],
			),
		).toEqual([])
	})

	it("serves every forced fetch after a rewind + gc + repack", () => {
		expect(
			rewinds.flatMap((r) =>
				r.kind === "failed" ? [`${r.label}: ${String(r.error).slice(0, 300)}`] : [],
			),
		).toEqual([])
	})

	it("serves a rewound state a fresh clone finds identical to the oracle", () => {
		expect(
			rewinds.flatMap((r) =>
				r.kind === "succeeded" && (r.objectsOnlyPg > 0 || r.objectsOnlyRef > 0)
					? [`${r.label}: onlyPG=${r.objectsOnlyPg} onlyREF=${r.objectsOnlyRef}`]
					: [],
			),
		).toEqual([])
	})

	it("serves a rewound state that clones fsck --strict clean", () => {
		expect(
			rewinds.flatMap((r) =>
				r.kind === "succeeded" && r.fsck.length > 0 ? [`${r.label}: ${r.fsck}`] : [],
			),
		).toEqual([])
	})
})

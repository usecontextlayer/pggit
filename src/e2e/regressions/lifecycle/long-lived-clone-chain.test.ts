/**
 * Lifecycle regression — 50-round incremental chain against a LONG-LIVED clone:
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
	compareMirrorClones,
	gitReachableOids,
	listDifferences,
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

const REPO = "workspace/slate/incr"
const ROUNDS = 50
const REWIND_ROUNDS = 8

type IncrementalComparison = {
	served: { fsck: string }
	objects: MirrorComparison["objects"]
}

type RoundResult<T> = TestResult<T> & { label: string }

describe("regressions/lifecycle — long-lived clone chain", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const incremental: RoundResult<IncrementalComparison>[] = []
	const rewinds: RoundResult<MirrorComparison>[] = []

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		root = mkdtempSync(join(tmpdir(), "pggit-long-lived-clone-chain-"))
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
			const result = await captureTestResult(async (): Promise<IncrementalComparison> => {
				await spawnGit(["fetch", "-q", "--prune", "origin"], { cwd: live })
				await spawnGit(["fetch", "-q", "--prune", "origin"], { cwd: liveRef })
				const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: live })
				const difference = listDifferences(
					await gitReachableOids(live),
					await gitReachableOids(liveRef),
				)
				return {
					objects: {
						onlyOracle: difference.onlyRight,
						onlyServed: difference.onlyLeft,
					},
					served: { fsck: `${fsck.stdout}${fsck.stderr}`.trim() },
				}
			})
			incremental.push({ ...result, label })
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
			const fresh = dir(`fresh-${r}`)
			const freshRef = dir(`freshref-${r}`)
			const result = await captureTestResult(async () => {
				await spawnGit(
					["fetch", "-q", "--prune", "--force", "origin", "+refs/heads/*:refs/heads/*"],
					{ cwd: live },
				)
				// A fresh clone is the real oracle for the served state.
				return compareMirrorClones(
					{ dest: fresh, url },
					{ dest: freshRef, url: `file://${ref}` },
				)
			})
			rewinds.push({ ...result, label })
			if (result.kind === "succeeded") {
				rmSync(fresh, { force: true, recursive: true })
				rmSync(freshRef, { force: true, recursive: true })
			}
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
				r.kind === "succeeded" &&
				(r.value.objects.onlyServed.length > 0 || r.value.objects.onlyOracle.length > 0)
					? [
							`${r.label}: onlyServed=${r.value.objects.onlyServed.length} onlyOracle=${r.value.objects.onlyOracle.length}`,
						]
					: [],
			),
		).toEqual([])
	})

	it("keeps the long-lived clone fsck --strict clean", () => {
		expect(
			incremental.flatMap((r) =>
				r.kind === "succeeded" && r.value.served.fsck.length > 0
					? [`${r.label}: ${r.value.served.fsck}`]
					: [],
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
				r.kind === "succeeded" &&
				(r.value.objects.onlyServed.length > 0 || r.value.objects.onlyOracle.length > 0)
					? [
							`${r.label}: onlyServed=${r.value.objects.onlyServed.length} onlyOracle=${r.value.objects.onlyOracle.length}`,
						]
					: [],
			),
		).toEqual([])
	})

	it("serves a rewound state that clones fsck --strict clean", () => {
		expect(
			rewinds.flatMap((r) =>
				r.kind === "succeeded" && r.value.served.fsck.length > 0
					? [`${r.label}: ${r.value.served.fsck}`]
					: [],
			),
		).toEqual([])
	})
})

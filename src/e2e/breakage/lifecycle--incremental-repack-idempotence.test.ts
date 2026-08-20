/**
 * Repack is idempotent across an incremental push chain: a 200-commit
 * append-only history delivered in five widening slices (40, 80, 120, 160, 201
 * commits), each followed by two repack passes and a mirror clone compared
 * against a plain `file://` bare remote carrying the same visible history.
 *
 * THE CONTRACT, per round: the FIRST repack does real work — each slice adds at
 * least 40 commits of genuinely new objects, and without that floor a repack
 * that permanently encoded nothing would satisfy every assertion here while the
 * clones quietly came off the undeltified raw path — and the SECOND is a strict
 * no-op, because the tier is derived and a pass over an already-covered repo has
 * nothing to write. Every round's clone must then be fsck-clean and carry exactly
 * the oracle's object set and refs.
 *
 * Originated as exploration-1 probe
 * `lifecycle--incremental-repack-idempotence.ts` (exit 1 when the second pass
 * wrote anything), which reproduced non-idempotent repack; fixed.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
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

const REPO = "workspace/slate/probe"
/** Commit counts of each successive push — the last one is the whole history. */
const SLICES = [40, 80, 120, 160, 201]

type RoundResult = TestResult<MirrorComparison> & {
	commits: number
	first: RepackResult
	second: RepackResult
}

describe("lifecycle breakage — incremental repack idempotence", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const rounds: RoundResult[] = []

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-incr-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildLifecycleSource(src, 200)
		const commits = await commitsOldestFirst(src, "main")

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])

		const url = repoUrl(server, REPO)
		const repack = createRepack(db.sql)

		for (const [round, upto] of SLICES.entries()) {
			const tip = requiredAt(commits, upto - 1, "main commit history")
			await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${tip}:refs/heads/main`], { cwd: src })
			const first = await repack.repack(REPO)
			const second = await repack.repack(REPO)

			const a = dir(`pg-${round}`)
			const b = dir(`ref-${round}`)
			const comparison = await captureTestResult(() =>
				compareMirrorClones({ dest: a, url }, { dest: b, url: `file://${ref}` }),
			)
			rounds.push({
				...comparison,
				commits: upto,
				first,
				second,
			})
			if (comparison.kind === "succeeded") {
				rmSync(a, { force: true, recursive: true })
				rmSync(b, { force: true, recursive: true })
			}
		}
	}, 900_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("does real encoding work in every incremental round", () => {
		// The floor under the no-op claim below: every slice adds at least 40 commits
		// of new objects, so a first pass that encoded nothing is a broken repack —
		// and one that permanently encodes nothing passes every other test in this
		// file, serving every clone off the raw path.
		expect(
			rounds
				.filter((r) => r.first.wholes + r.first.deltas === 0)
				.map((r) => `${r.commits} commits`),
		).toEqual([])
	})

	it("makes the second repack of every incremental round a strict no-op", () => {
		expect(
			rounds
				.filter((r) => r.second.deltas !== 0 || r.second.wholes !== 0)
				.map((r) => `${r.commits} commits: ${JSON.stringify(r.second)}`),
		).toEqual([])
	})

	it("serves a clonable repo in every incremental round", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "failed" ? [`${r.commits} commits: ${String(r.error)}`] : [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "succeeded" &&
				(r.value.objects.onlyServed.length > 0 || r.value.objects.onlyOracle.length > 0)
					? [
							`${r.commits} commits: onlyServed=${r.value.objects.onlyServed.length} onlyOracle=${r.value.objects.onlyOracle.length}`,
						]
					: [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "succeeded" ? [{ commits: r.commits, refs: r.value.served.refs }] : [],
			),
		).toEqual(
			rounds.flatMap((r) =>
				r.kind === "succeeded" ? [{ commits: r.commits, refs: r.value.oracle.refs }] : [],
			),
		)
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "succeeded" && r.value.served.fsck.length > 0
					? [`${r.commits} commits: ${r.value.served.fsck}`]
					: [],
			),
		).toEqual([])
	})
})

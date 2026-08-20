/**
 * Lifecycle breakage — force-push storm: N rounds of
 *   advance → repack → force-move main back onto a divergent lineage (setRef)
 *   → delete staging ref → gc(0) → repack → clone/fsck/compare.
 * Half the rounds invert the gc/repack order.
 *
 * Converted from `breakage/lifecycle--force-push-storm.ts` (exploration 2),
 * mechanically and at full scale — 200 seed commits, six rounds, a 45-commit
 * divergent lineage per round off six different branch points. The oracle is a
 * plain `file://` bare remote driven through the same sequence; every round's
 * mirror clone must be fsck-clean and BYTE-identical (every reachable object's
 * raw bytes, hashed in oid order), not merely oid-identical. The source exits 1
 * when the bug reproduces; the assertions here state the correct outcome, so a
 * reproduction is a RED test.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ZERO_OID } from "@/oid"
import type { GitServer } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack, type RepackResult } from "@/store/repack"
import {
	appendLifecycleLineage,
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

const REPO = "workspace/slate/storm"
const ROUNDS = 6
/** Each round's divergent lineage branches from a different point of main. */
const BRANCH_POINTS = [150, 100, 60, 170, 30, 120]

async function revParse(dir: string, rev: string): Promise<string> {
	return (await spawnGit(["rev-parse", rev], { cwd: dir })).stdout.trim()
}

type RoundResultBase = {
	round: number
	order: "gc→repack" | "repack→gc"
	stagingDeleteAccepted: boolean
}

type RoundResult = RoundResultBase &
	(
		| { kind: "failed"; error: unknown }
		| {
				kind: "succeeded"
				objectsOnlyPg: number
				objectsOnlyRef: number
				refsPg: string[]
				refsRef: string[]
				fsck: string
				bytesMatch: boolean
				converged: RepackResult
		  }
	)

describe("lifecycle breakage — force-push storm", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const rounds: RoundResult[] = []

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-storm-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildLifecycleSource(src, 200)
		const commits = await commitsOldestFirst(src, "main")

		for (let r = 0; r < ROUNDS; r++) {
			await appendLifecycleLineage(
				src,
				`alt${r}`,
				requiredAt(
					commits,
					requiredAt(BRANCH_POINTS, r, "force-push branch points"),
					"main commit history",
				),
				`alt${r}`,
				45,
			)
		}

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])

		const url = repoUrl(server, REPO)
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = fixture.deps.refs

		// Seed: full main.
		const tip0 = requiredAt(commits, commits.length - 1, "main commit history")
		await spawnGit(["push", "-q", url, `${tip0}:refs/heads/main`], { cwd: src })
		await spawnGit(["push", "-q", ref, `${tip0}:refs/heads/main`], { cwd: src })
		await repack.repack(REPO)

		for (let r = 0; r < ROUNDS; r++) {
			const altTip = await revParse(src, `alt${r}`)
			const stage = `refs/heads/stage${r}`
			// 1. deliver the divergent objects under a staging ref (a create — allowed)
			await spawnGit(["push", "-q", url, `${altTip}:${stage}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${altTip}:${stage}`], { cwd: src })
			// 2. force-move main onto it (the platform's ref-move path)
			await refs.setRef(REPO, "refs/heads/main", altTip)
			await spawnGit(["update-ref", "refs/heads/main", altTip], { cwd: ref })
			// 3. retire the staging ref
			const okDel = await refs.applyRefUpdates(
				REPO,
				[{ newOid: ZERO_OID, oldOid: altTip, ref: stage }],
				false,
			)
			await spawnGit(["update-ref", "-d", stage, altTip], { cwd: ref })

			// 4/5. gc + repack, order alternating per round
			const gcFirst = r % 2 === 0
			if (gcFirst) {
				await gc.gc(REPO, { graceSeconds: 0 })
				await repack.repack(REPO)
			} else {
				await repack.repack(REPO)
				await gc.gc(REPO, { graceSeconds: 0 })
			}
			await repack.repack(REPO)
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })

			const a = dir(`pg-${r}`)
			const b = dir(`ref-${r}`)
			const base = {
				order: (gcFirst ? "gc→repack" : "repack→gc") as RoundResultBase["order"],
				round: r,
				stagingDeleteAccepted: requiredAt(okDel, 0, "staging ref delete results"),
			}
			let pgc: MirrorState
			try {
				pgc = await mirrorClone(url, a)
			} catch (error) {
				rounds.push({
					...base,
					error,
					kind: "failed",
				})
				continue
			}
			const refc = await mirrorClone(`file://${ref}`, b)
			const objDiff = listDifferences(pgc.objects, refc.objects)
			// a second repack must be a no-op after convergence
			rounds.push({
				...base,
				bytesMatch: pgc.digest === refc.digest,
				converged: await repack.repack(REPO),
				fsck: pgc.fsck,
				kind: "succeeded",
				objectsOnlyPg: objDiff.onlyLeft.length,
				objectsOnlyRef: objDiff.onlyRight.length,
				refsPg: pgc.refs,
				refsRef: refc.refs,
			})
			rmSync(a, { force: true, recursive: true })
			rmSync(b, { force: true, recursive: true })
		}
	}, 900_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("accepts the staging-ref delete in every round", () => {
		expect(
			rounds.filter((r) => !r.stagingDeleteAccepted).map((r) => `round ${r.round}`),
		).toEqual([])
	})

	it("serves a clonable repo after every force-push round", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "failed"
					? [`round ${r.round} (${r.order}): ${String(r.error).slice(0, 400)}`]
					: [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "succeeded" && (r.objectsOnlyPg > 0 || r.objectsOnlyRef > 0)
					? [`round ${r.round}: onlyPG=${r.objectsOnlyPg} onlyREF=${r.objectsOnlyRef}`]
					: [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "succeeded" ? [{ refs: r.refsPg, round: r.round }] : [],
			),
		).toEqual(
			rounds.flatMap((r) =>
				r.kind === "succeeded" ? [{ refs: r.refsRef, round: r.round }] : [],
			),
		)
	})

	it("serves byte-identical objects to the oracle", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "succeeded" && !r.bytesMatch ? [`round ${r.round}`] : [],
			),
		).toEqual([])
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "succeeded" && r.fsck.length > 0
					? [`round ${r.round}: ${r.fsck}`]
					: [],
			),
		).toEqual([])
	})

	it("converges the repack in every round, in either gc/repack order", () => {
		expect(
			rounds.flatMap((r) =>
				r.kind === "succeeded" && (r.converged.deltas !== 0 || r.converged.wholes !== 0)
					? [`round ${r.round} (${r.order}): ${JSON.stringify(r.converged)}`]
					: [],
			),
		).toEqual([])
	})
})

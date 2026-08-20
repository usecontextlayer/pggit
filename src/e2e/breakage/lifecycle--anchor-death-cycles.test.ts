/**
 * Lifecycle breakage — the anchor-dies-delta-survives shape (design N3), iterated:
 * an orphan commit on a side ref reuses a MID-history tree, main rewinds, gc(0)
 * must sweep the now-dangling delta, and the tier must repair over many cycles.
 *
 * Converted from `breakage/lifecycle--anchor-death-cycles.ts` (exploration 3),
 * mechanically and at full scale — 200 seed commits, 5 cycles, a 50-commit
 * divergent lineage per cycle. The oracle is a plain `file://` bare remote
 * replaying exactly the same visible history: every mirror clone taken from pggit
 * must be `fsck --strict` clean and carry precisely the oracle's object set and
 * refs. The source script exits 1 when the bug reproduces; here the assertions
 * encode the CORRECT outcome, so a live reproduction shows up as a RED test.
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

const REPO = "workspace/slate/anchor"
const CYCLES = 5

async function revParse(dir: string, rev: string): Promise<string> {
	return (await spawnGit(["rev-parse", rev], { cwd: dir })).stdout.trim()
}

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

describe("lifecycle breakage — anchor death cycles", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const checks: CloneCheck[] = []
	const convergence: { cycle: number; second: RepackResult }[] = []

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-anchor-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildLifecycleSource(src, 200)
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

		// seed the full main history on both sides
		const seedTip = requiredAt(commits, commits.length - 1, "main commit history")
		await spawnGit(["push", "-q", url, `${seedTip}:refs/heads/main`], { cwd: src })
		await spawnGit(["push", "-q", ref, `${seedTip}:refs/heads/main`], { cwd: src })
		await repack.repack(REPO)

		for (let c = 0; c < CYCLES; c++) {
			// 1. orphan commit reusing a MID-history tree, parked on its own ref
			const midTree = await revParse(
				src,
				`${requiredAt(commits, 100 + c * 7, "main commit history")}^{tree}`,
			)
			const orphan = (
				await spawnGit(["commit-tree", midTree, "-m", `keep-${c}`], { cwd: src })
			).stdout.trim()
			const keepRef = `refs/heads/keep${c}`
			await spawnGit(["push", "-q", url, `${orphan}:${keepRef}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${orphan}:${keepRef}`], { cwd: src })

			// 2. rewind main hard to the seed commit — the anchors die, the orphan's
			//    mid-history trees survive.
			const rewindTo = requiredAt(commits, 0, "main commit history")
			await refs.setRef(REPO, "refs/heads/main", rewindTo)
			await spawnGit(["update-ref", "refs/heads/main", rewindTo], { cwd: ref })

			// 3. gc(0): the dangling-base sweep must fire here
			await gc.gc(REPO, { graceSeconds: 0 })
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })

			// 4. clone with the tier in its post-sweep (holed) state
			await check(`c${c}-postgc`)

			// 5. repair pass, then clone again; convergence must be immediate
			await repack.repack(REPO)
			convergence.push({ cycle: c, second: await repack.repack(REPO) })
			await check(`c${c}-postrepack`)

			// 6. advance main differently, re-using paths whose anchors were swept
			await appendLifecycleLineage(src, `re${c}`, rewindTo, `re${c}`, 50)
			const newTip = await revParse(src, `re${c}`)
			await spawnGit(["push", "-q", url, `${newTip}:refs/heads/main`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${newTip}:refs/heads/main`], { cwd: src })
			await repack.repack(REPO)
			await check(`c${c}-advanced`)

			// 7. retire the keep ref so the next cycle's garbage is real garbage
			await refs.applyRefUpdates(
				REPO,
				[{ newOid: ZERO_OID, oldOid: orphan, ref: keepRef }],
				false,
			)
			await spawnGit(["update-ref", "-d", keepRef, orphan], { cwd: ref })
		}
	}, 900_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("serves a clonable repo at every point of every cycle", () => {
		expect(
			checks.flatMap((c) =>
				c.kind === "failed" ? [`${c.tag}: ${String(c.error).slice(0, 400)}`] : [],
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

	it("repack converges immediately after the dangling-base sweep", () => {
		expect(
			convergence
				.filter((c) => c.second.deltas !== 0 || c.second.wholes !== 0)
				.map((c) => `cycle ${c.cycle}: ${JSON.stringify(c.second)}`),
		).toEqual([])
	})
})

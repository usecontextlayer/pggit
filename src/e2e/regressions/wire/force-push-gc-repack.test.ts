/**
 * WIRE — the encoding tier across a denied-push / GC / repack cycle, judged from a
 * real client. (Converted from `breakage/wire--force-push-gc-repack.ts`.)
 *
 * The tier's hygiene (design D7) is DDL since 0008: the FK cascades leave no
 * encoding row pointing at a reclaimed object OR a reclaimed BASE. A surviving
 * delta whose anchor is gone is exactly the shape that would ship an
 * unresolvable REF_DELTA — the one customer-visible corruption this tier could
 * introduce.
 *
 * The non-vacuous shape (design note N3): a KEPT ref whose root tree is a LATE
 * version of a lineage that is otherwise garbage, so the tree outlives its delta
 * anchor. pggit's push policy is refs-only-advance (no deletes, no non-FF), so the
 * ONLY way a client can create garbage is a DENIED push — receive-pack ingests the
 * pack before policy runs, so the objects land and the ref does not move.
 *
 *   push main → denied non-FF push of a long divergent branch (objects land,
 *   ref does not) → repack (anchors+deltas over the now-unreachable lineage) →
 *   push a keeper commit over that lineage's LAST tree → gc (anchor reclaimed,
 *   delta target kept) → clone (tier at its most damaged) → repack repair →
 *   clone → gc → clone
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Oid } from "@/object/oid"
import type { GitServer } from "@/server"
import { createGc, type GcResult } from "@/store/gc"
import { createRepack } from "@/store/repack"
import {
	objectsByType,
	parseRevListObjectOids,
	requireGitOid,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { attemptGit, spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const REPO = "workspace/probe/forcepush"
/** Long enough that the `dir/` lineage spans several ANCHOR_EVERY=32 segments. */
const BASE_STEPS = 20
const SIDE_STEPS = 90

type CloneCheck = {
	label: string
	result: TestResult<{
		/** ref name → the observed and expected tips, if observation succeeded. */
		refs: Map<string, TestResult<[string, string]>>
		keptTree: TestResult<boolean>
	}>
}

describe("wire — denied push, GC, repack: the tier stays servable", () => {
	let db: IsolatedDb
	let server: GitServer
	const { cleanup: cleanupScratch, make: mk } = createScratchArena()

	let deniedPush = ""
	/** `lateTree`'s delta base after the first repack — null means it is not a delta. */
	let keptAnchor: Oid | null = null
	/** Whether GC actually reclaimed that anchor. */
	let anchorGone = false
	let gcFirst: GcResult
	let gcSecond: GcResult
	let repackRepair = { deltas: 0, wholes: 0 }
	const clones: CloneCheck[] = []
	let afterSecondGc: CloneCheck

	beforeAll(async () => {
		const src = mk("src")
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		mkdirSync(join(src, "dir"))
		for (let i = 0; i < BASE_STEPS; i++) {
			writeFileSync(join(src, "dir", `f${i}.txt`), `content ${i}\n`.repeat(4))
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", `base ${i}`], { cwd: src })
		}
		// A DIVERGENT branch off main~5 — pushing it at refs/heads/main is a non-FF
		// update, denied by policy AFTER its objects have already been ingested.
		await spawnGit(["checkout", "-q", "-b", "side", "main~5"], { cwd: src })
		for (let i = BASE_STEPS; i < BASE_STEPS + SIDE_STEPS; i++) {
			writeFileSync(join(src, "dir", `f${i}.txt`), `content ${i}\n`.repeat(4))
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", `side ${i}`], { cwd: src })
		}
		// Every TREE that exists only on the divergent lineage, newest first: the pool
		// the kept tree is chosen from once repack has said which of them are deltas.
		// "Only on side" matters twice — it is the garbage a denied push creates, and
		// it guarantees the chosen tree's anchor is unreachable once the keeper is the
		// only thing holding the tree alive.
		const sideOnly = parseRevListObjectOids(
			(
				await spawnGit(["rev-list", "--objects", "side", "--not", "main"], {
					cwd: src,
				})
			).stdout,
		)
		const sideOnlySet = new Set(sideOnly)
		const sideTrees = new Set(
			(await objectsByType(src))
				.filter((object) => object.type === "tree" && sideOnlySet.has(object.oid))
				.map((object) => object.oid),
		)
		const sideTreesNewestFirst = sideOnly.filter((o) => sideTrees.has(o))
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const url = repoUrl(server, REPO)
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)

		const cloneAndCheck = async (
			label: string,
			tag: string,
			lateTree: Oid,
		): Promise<CloneCheck> => {
			const dest = join(mk(tag), "c")
			const clone = await captureTestResult(async () => {
				await spawnGit([
					"-c",
					"protocol.version=2",
					"-c",
					"transfer.fsckobjects=true",
					"-c",
					"fetch.fsckobjects=true",
					"clone",
					"-q",
					url,
					dest,
				])
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			})
			if (clone.kind === "failed") return { label, result: clone }
			const refs = new Map<string, TestResult<[string, string]>>()
			for (const ref of ["main", "keeper"]) {
				const want = (
					await spawnGit(["rev-parse", `refs/heads/${ref}`], { cwd: src })
				).stdout.trim()
				refs.set(
					ref,
					await captureTestResult<[string, string]>(async () => {
						const got = await spawnGit(["rev-parse", `refs/remotes/origin/${ref}`], {
							cwd: dest,
						})
						return [got.stdout.trim(), want]
					}),
				)
			}
			const keptTree = await captureTestResult(async () => {
				const got = await spawnGit(["cat-file", "tree", lateTree], { cwd: dest })
				const want = await spawnGit(["cat-file", "tree", lateTree], { cwd: src })
				return got.stdoutBytes.equals(want.stdoutBytes)
			})
			return { label, result: { kind: "succeeded", value: { keptTree, refs } } }
		}

		await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], { cwd: src })
		// Denied by the refs-only-advance policy — but the pack is ingested first, so
		// every `side` object now sits in the store UNREACHABLE. That is the only
		// garbage a real client can create against pggit.
		const denied = await attemptGit(
			["push", "-q", "--force", url, "refs/heads/side:refs/heads/main"],
			src,
		)
		deniedPush = denied.ok ? "ACCEPTED" : denied.stderr

		await repack.repack(REPO)
		// The file's whole subject, established by MEASUREMENT rather than assumed:
		// the kept tree has to BE a delta, or "still serves the kept tree whose delta
		// anchor GC reclaimed" is a claim about an ordinary whole row. Which trees are
		// deltas is repack's choice — the lineage's tip ROOT tree carries one entry
		// and loses to its own whole form every time — so ask the tier which of the
		// lineage's trees it deltified and keep the newest of those whose anchor is
		// also side-only, so GC reclaims that anchor once the keeper is the only
		// thing holding the tree alive.
		const deltaBase = new Map(
			(
				await db.sql<{ oid: string; base: string }[]>`
					select encode(oid, 'hex') as oid, encode(base_oid, 'hex') as base
					from git_pack_encoding where base_oid is not null`
			).map((r) => [
				requireGitOid(r.oid, "encoding target row"),
				requireGitOid(r.base, "encoding base row"),
			]),
		)
		const lateTree = sideTreesNewestFirst.find((t) => {
			const base = deltaBase.get(t)
			return base !== undefined && sideTrees.has(base)
		})
		if (lateTree === undefined)
			throw new Error("fixture wrong: no side-only tree is a delta")
		const selectedAnchor = deltaBase.get(lateTree)
		if (selectedAnchor === undefined)
			throw new Error("fixture wrong: selected tree has no delta anchor")
		keptAnchor = selectedAnchor
		console.log(`kept tree ${lateTree} → delta anchor ${keptAnchor ?? "<none>"}`)

		// Keep exactly ONE late tree alive: a commit whose root tree is `side`'s last.
		// Its delta anchor sits many versions back in a lineage nothing now reaches.
		const keeper = (
			await spawnGit(["commit-tree", lateTree, "-m", "keeper"], { cwd: src })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/keeper", keeper], { cwd: src })
		await spawnGit(["push", "-q", url, "refs/heads/keeper:refs/heads/keeper"], {
			cwd: src,
		})
		await spawnGit(["checkout", "-q", "main"], { cwd: src })

		gcFirst = await gc.gc(REPO, { graceSeconds: 0 })
		if (keptAnchor !== null) {
			const [anchorRow] = await db.sql<{ n: number }[]>`
				select count(*)::int as n from git_object
				where oid = ${Buffer.from(keptAnchor, "hex")}`
			if (anchorRow === undefined) throw new Error("anchor count query returned no row")
			anchorGone = anchorRow.n === 0
		}
		clones.push(
			await cloneAndCheck("clone after gc (before repair repack)", "pre", lateTree),
		)
		repackRepair = await repack.repack(REPO)
		clones.push(await cloneAndCheck("clone after repair repack", "post", lateTree))

		gcSecond = await gc.gc(REPO, { graceSeconds: 0 })
		afterSecondGc = await cloneAndCheck("clone after second gc", "after", lateTree)
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		cleanupScratch()
	})

	it("has the fixture it needs: the divergent push is DENIED, not accepted", () => {
		expect(deniedPush).not.toBe("ACCEPTED")
		expect(deniedPush).toMatch(/non-fast-forward/)
	})

	it("has the fixture it needs: the kept tree is a delta whose anchor GC reclaimed", () => {
		expect(keptAnchor, "the kept tree was not stored as a delta").not.toBeNull()
		expect(anchorGone, "GC did not reclaim the kept tree's delta anchor").toBe(true)
		expect(
			gcFirst.deletedObjects,
			"GC reclaimed nothing — the denied push's garbage is still live",
		).toBeGreaterThan(0)
	})

	it("clones fsck-clean both immediately after gc and after the repair repack", () => {
		for (const c of clones) {
			const at =
				`${c.label} — gc reclaimed ${gcFirst.deletedObjects} objects; ` +
				`repair repack wrote ${repackRepair.wholes} wholes + ${repackRepair.deltas} deltas`
			expect(c.result.kind, testResultContext(c.result, at)).toBe("succeeded")
		}
	})

	it("serves both refs at the source's tips in every one of those clones", () => {
		for (const c of clones) {
			if (c.result.kind === "failed") continue
			expect(c.result.value.refs.size, c.label).toBe(2)
			for (const [ref, result] of c.result.value.refs) {
				const at = `${c.label} — ref ${ref}`
				expect(result.kind, testResultContext(result, at)).toBe("succeeded")
				if (result.kind === "succeeded") {
					const [got, want] = result.value
					expect(got, at).toBe(want)
				}
			}
		}
	})

	it("still serves the kept tree whose delta anchor GC reclaimed, byte-identical", () => {
		for (const c of clones) {
			if (c.result.kind === "failed") continue
			const result = c.result.value.keptTree
			expect(result.kind, testResultContext(result, c.label)).toBe("succeeded")
			if (result.kind === "succeeded") expect(result.value, c.label).toBe(true)
		}
	})

	it("clones fsck-clean after a SECOND gc pass over the repaired tier", () => {
		expect(
			afterSecondGc.result.kind,
			testResultContext(
				afterSecondGc.result,
				`second gc reclaimed ${gcSecond.deletedObjects} objects`,
			),
		).toBe("succeeded")
	})
})

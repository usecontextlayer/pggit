/**
 * WIRE — the encoding tier across a denied-push / GC / repack cycle, judged from a
 * real client. (Converted from `breakage/wire--force-push-gc-repack.ts`.)
 *
 * GC's `sweepEncodings` (design D7) must leave no encoding row pointing at a
 * reclaimed object OR a reclaimed BASE. A surviving delta whose anchor is gone is
 * exactly the shape that would ship an unresolvable REF_DELTA — the one
 * customer-visible corruption this tier could introduce.
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type GcResult } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/forcepush"
/** Long enough that the `dir/` lineage spans several ANCHOR_EVERY=32 segments. */
const BASE_STEPS = 20
const SIDE_STEPS = 90

type CloneCheck = {
	label: string
	error: string | null
	/** ref name → [observed in the clone, expected from the source]. */
	refs: Map<string, [string, string]>
	keptTreeMatches: boolean
	keptTreeError: string | null
}

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run()
		return null
	} catch (err) {
		return String(err)
	}
}

describe("wire — denied push, GC, repack: the tier stays servable", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	let deniedPush = ""
	let gcFirst: GcResult
	let gcSecond: GcResult
	let repackRepair = { deltas: 0, wholes: 0 }
	const clones: CloneCheck[] = []
	let afterSecondGcError: string | null = null

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
		// The object that must outlive its anchor: `side`'s LAST root tree.
		const lateTree = (
			await spawnGit(["rev-parse", "side^{tree}"], { cwd: src })
		).stdout.trim()

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)

		const cloneAndCheck = async (label: string, tag: string): Promise<CloneCheck> => {
			const dest = join(mk(tag), "c")
			const error = await errorOf(async () => {
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
			const refs = new Map<string, [string, string]>()
			let keptTreeMatches = false
			let keptTreeError: string | null = null
			if (error === null) {
				for (const ref of ["main", "keeper"]) {
					const got = await spawnGit(["rev-parse", `refs/remotes/origin/${ref}`], {
						cwd: dest,
					})
						.then((x) => x.stdout.trim())
						.catch(() => "<missing>")
					const want = (
						await spawnGit(["rev-parse", `refs/heads/${ref}`], { cwd: src })
					).stdout.trim()
					refs.set(ref, [got, want])
				}
				keptTreeError = await errorOf(async () => {
					const got = await spawnGit(["cat-file", "tree", lateTree], { cwd: dest })
					const want = await spawnGit(["cat-file", "tree", lateTree], { cwd: src })
					keptTreeMatches = got.stdoutBytes.equals(want.stdoutBytes)
				})
			}
			return { error, keptTreeError, keptTreeMatches, label, refs }
		}

		await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], { cwd: src })
		// Denied by the refs-only-advance policy — but the pack is ingested first, so
		// every `side` object now sits in the store UNREACHABLE. That is the only
		// garbage a real client can create against pggit.
		deniedPush = await spawnGit(
			["push", "-q", "--force", url, "refs/heads/side:refs/heads/main"],
			{ cwd: src },
		).then(
			() => "ACCEPTED",
			(e) => String(e).split("\n")[1] ?? "denied",
		)

		await repack.repack(REPO)

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
		clones.push(await cloneAndCheck("clone after gc (before repair repack)", "pre"))
		repackRepair = await repack.repack(REPO)
		clones.push(await cloneAndCheck("clone after repair repack", "post"))

		gcSecond = await gc.gc(REPO, { graceSeconds: 0 })
		afterSecondGcError = (await cloneAndCheck("clone after second gc", "after")).error
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("has the fixture it needs: the divergent push is DENIED, not accepted", () => {
		expect(deniedPush).not.toBe("ACCEPTED")
	})

	it("clones fsck-clean both immediately after gc and after the repair repack", () => {
		for (const c of clones) {
			expect(
				c.error,
				`${c.label} — gc reclaimed ${gcFirst.deletedObjects} objects / ` +
					`${gcFirst.deletedEncodings} encodings; repair repack wrote ` +
					`${repackRepair.wholes} wholes + ${repackRepair.deltas} deltas`,
			).toBeNull()
		}
	})

	it("serves both refs at the source's tips in every one of those clones", () => {
		for (const c of clones) {
			for (const [ref, [got, want]] of c.refs) {
				expect(got, `${c.label} — ref ${ref}`).toBe(want)
			}
		}
	})

	it("still serves the kept tree whose delta anchor GC reclaimed, byte-identical", () => {
		for (const c of clones) {
			expect(c.keptTreeError, c.label).toBeNull()
			expect(c.keptTreeMatches, c.label).toBe(true)
		}
	})

	it("clones fsck-clean after a SECOND gc pass over the repaired tier", () => {
		expect(
			afterSecondGcError,
			`second gc reclaimed ${gcSecond.deletedObjects} objects / ` +
				`${gcSecond.deletedEncodings} encodings`,
		).toBeNull()
	})
})

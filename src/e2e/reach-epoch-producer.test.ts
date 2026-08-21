/**
 * The reachability-epoch producer: GC's pass owns the epoch, and every path must
 * produce EXACT per-tip bitmaps — each tip's bitmap
 * names precisely `fullClosure(tip)`, the walk the bitmap will stand in for at
 * serve time. The sequence below is one repo's life: first drain (rebuilt),
 * quiet drain (unchanged — the write-cost guard), refs-only advance (the
 * steady-state delta), a store-level rewind (LOUD fallback to a rebuild that
 * actually reclaims), a ref deletion (same), and finally an emptied repo
 * (cleared). Exactness is asserted against `fullClosure` at every stage, with each
 * source-resolvable commit tip also anchored to canonical `git rev-list`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Database, initKysely } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"
import { ZERO_OID } from "@/object/oid"
import { type Epoch, loadEpoch, oidsOfUnion, splitOids } from "@/store/reach-epoch"
import { fullClosure } from "@/store/reachability"
import {
	type GcFixture,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import { parseRevListObjectOids } from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "epoch/producer"

describe("reachability-epoch producer", () => {
	let fx: GcFixture
	let db: ReturnType<typeof initKysely<Database>>
	let id: ReposId
	let src = ""
	const mainTips: string[] = [] // main's commit oids, oldest→newest
	let tagOid = ""

	beforeAll(async () => {
		fx = await setupGcFixture()
		db = initKysely<Database>(fx.db.sql)
		src = mkdtempSync(join(tmpdir(), "pggit-epoch-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		const commit = async (name: string, content: string): Promise<string> => {
			writeFileSync(join(src, name), content)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", name], { cwd: src })
			return (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		}
		mainTips.push(await commit("a.txt", "one\n"))
		mainTips.push(await commit("b.txt", "two\n"))
		// A feature branch off main~1 and an annotated tag on main~1.
		const firstMainTip = mainTips[0]
		if (firstMainTip === undefined) throw new Error("first main tip was not created")
		await spawnGit(["checkout", "-q", "-b", "feature", firstMainTip], { cwd: src })
		await commit("f.txt", "feat\n")
		await spawnGit(["tag", "-a", "-m", "v1", "v1", firstMainTip], { cwd: src })
		tagOid = (await spawnGit(["rev-parse", "refs/tags/v1"], { cwd: src })).stdout.trim()
		await spawnGit(["checkout", "-q", "main"], { cwd: src })
		mainTips.push(await commit("c.txt", "three\n"))

		const url = repoUrl(fx, REPO)
		await spawnGit(["push", "-q", url, "main", "feature", "refs/tags/v1"], { cwd: src })
		const row = await db
			.selectFrom("repos")
			.select("id")
			.where("name", "=", REPO)
			.executeTakeFirstOrThrow()
		id = row.id
	}, 120_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
		if (src) rmSync(src, { force: true, recursive: true })
	})

	/** The exactness oracle: every stored tip bitmap names fullClosure(tip) —
	 * and, for commit tips whose history the source repo still holds, CANONICAL
	 * GIT's own closure (`rev-list --objects`), so a shared walk defect cannot
	 * self-confirm through fullClosure alone. */
	async function expectReadyEpoch(): Promise<Epoch> {
		const loaded = await loadEpoch(db, id)
		expect(loaded.state).toBe("ready")
		if (loaded.state !== "ready") {
			throw new Error(`expected ready epoch, got ${loaded.state}`)
		}
		return loaded.epoch
	}

	async function expectExactBitmaps(): Promise<void> {
		let anchored = 0
		const epoch = await expectReadyEpoch()
		const refs = await fx.db.sql<{ oid: Buffer }[]>`
			select oid from git_ref where repo_id = ${id} and oid is not null`
		const tips = [...new Set(refs.map((r) => r.oid.toString("hex")))].sort()
		expect(epoch.tips).toEqual(tips)
		const all = new Set<string>()
		for (const tip of tips) {
			const bits = epoch.bitmaps.get(tip)
			if (bits === undefined) throw new Error(`bitmap missing for tip ${tip}`)
			const named = oidsOfUnion([bits], epoch.oids)
			const { present, missing } = await fullClosure(db, id, [tip], false)
			expect(missing.size).toBe(0)
			expect(named).toEqual([...present].sort())
			for (const o of named) all.add(o)
			const inSrc = await spawnGit(["cat-file", "-t", tip], { cwd: src })
			if (inSrc.stdout.trim() === "commit") {
				anchored++
				const expected = parseRevListObjectOids(
					(await spawnGit(["rev-list", "--objects", tip], { cwd: src })).stdout,
				).sort()
				expect(named, `git oracle for tip ${tip}`).toEqual(expected)
			}
		}
		// Without a git-anchored tip this call degrades to pggit-vs-pggit — the epoch's
		// bitmaps against our own `fullClosure` walk, a shared defect self-confirming.
		// Every stage must keep at least one commit tip the source repo can still
		// resolve, or the oracle silently opted out.
		expect(
			anchored,
			"no tip was anchored against canonical git — the stage lost its oracle",
		).toBeGreaterThan(0)
		expect(splitOids(epoch.oids)).toEqual([...all].sort())
	}

	it("the first drain REBUILDS an epoch whose bitmaps are the exact closures", async () => {
		const result = await fx.gc.gc(REPO, { graceSeconds: 0 })
		expect(result.epoch).toBe("rebuilt")
		const epoch = await expectReadyEpoch()
		expect(epoch.epoch).toBe(1)
		expect(epoch.tips).toContain(tagOid) // tag REF tips are the tag OBJECT oids
		await expectExactBitmaps()
	})

	it("a quiet drain SKIPS the write entirely", async () => {
		const result = await fx.gc.gc(REPO, { graceSeconds: 0 })
		expect(result.epoch).toBe("unchanged")
		expect((await expectReadyEpoch()).epoch).toBe(1)
	})

	it("a refs-only advance produces a DELTA epoch that stays exact", async () => {
		writeFileSync(join(src, "d.txt"), "four\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "d"], { cwd: src })
		mainTips.push((await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim())
		await spawnGit(["push", "-q", repoUrl(fx, REPO), "main"], { cwd: src })

		const result = await fx.gc.gc(REPO, { graceSeconds: 0 })
		expect(result.epoch).toBe("advanced")
		expect((await expectReadyEpoch()).epoch).toBe(2)
		await expectExactBitmaps()
	})

	it("an ANCESTOR rewind (tip moved back inside the epoch) rebuilds and reclaims", async () => {
		// The rewind signature the planner short-circuits on: the new tip is
		// INSIDE the old epoch array but not among its tips — a delta walk from
		// it would re-walk old history for nothing.
		const ancestorTip = mainTips[1]
		if (ancestorTip === undefined) throw new Error("second main tip was not created")
		await fx.refs.setRef(REPO, "refs/heads/main", ancestorTip)
		const result = await fx.gc.gc(REPO, { graceSeconds: 0 })
		expect(result.epoch).toBe("rebuilt")
		expect(result.deletedObjects).toBeGreaterThan(0) // mainTips[2..] reclaimed
		await expectExactBitmaps()
	})

	it("a rewind falls back LOUDLY to a rebuild that reclaims the rewound history", async () => {
		// An UNRELATED single-commit history replaces main: the old main line becomes
		// garbage and its epoch tip is no longer covered. The new root is built INSIDE
		// `src` (rather than in a throwaway repo) so this stage keeps a tip canonical
		// git can still resolve — expectExactBitmaps refuses to run without one.
		await spawnGit(["checkout", "-q", "--orphan", "rewound"], { cwd: src })
		await spawnGit(["rm", "-rf", "--cached", "."], { cwd: src })
		writeFileSync(join(src, "a.txt"), "rewound\n")
		await spawnGit(["add", "a.txt"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "rewound"], { cwd: src })
		const rewound = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		// The wire denies non-fast-forward moves, so the objects land through a
		// throwaway CREATE and `main` is CAS-moved through the store — the store-level
		// rewind the GC workload models (gc-helpers' `rewind` mechanic, inlined here).
		const tmpRef = `refs/heads/rewind-${rewound.slice(0, 12)}`
		await spawnGit(["push", "-q", repoUrl(fx, REPO), `HEAD:${tmpRef}`], { cwd: src })
		const current = (await fx.refs.listRefs(REPO)).find(
			(r) => r.name === "refs/heads/main",
		)
		if (!current) throw new Error("refs/heads/main missing — nothing to rewind")
		const moved = await fx.refs.applyRefUpdates(
			REPO,
			[
				{ newOid: rewound, oldOid: current.oid, ref: "refs/heads/main" },
				{ newOid: ZERO_OID, oldOid: rewound, ref: tmpRef },
			],
			false,
		)
		if (moved.some((ok) => !ok)) {
			throw new Error(`store ref updates failed (${moved})`)
		}
		const result = await fx.gc.gc(REPO, { graceSeconds: 0 })
		expect(result.epoch).toBe("rebuilt")
		expect(result.deletedObjects).toBeGreaterThan(0)
		await expectExactBitmaps()
	})

	it("a deleted ref rebuilds and reclaims its exclusive history", async () => {
		// The wire denies deletions (refs only advance) — a deletion is a
		// PLATFORM operation, modeled here as the ref row going away.
		await fx.db
			.sql`delete from git_ref where repo_id = ${id} and name = 'refs/heads/feature'`
		const result = await fx.gc.gc(REPO, { graceSeconds: 0 })
		expect(result.epoch).toBe("rebuilt")
		expect(result.deletedObjects).toBeGreaterThan(0)
		await expectExactBitmaps()
	})

	it("an emptied repo CLEARS its epoch", async () => {
		await fx.db.sql`delete from git_ref where repo_id = ${id}`
		const result = await fx.gc.gc(REPO, { graceSeconds: 0 })
		expect(result.epoch).toBe("cleared")
		expect((await loadEpoch(db, id)).state).toBe("absent")
		// And a pass over the now-epochless empty repo has nothing to say.
		expect((await fx.gc.gc(REPO, { graceSeconds: 0 })).epoch).toBe("unchanged")
	})
})

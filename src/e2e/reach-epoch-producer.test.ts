/**
 * The epoch producer (spine chunk 5b, S6): GC's pass owns the reachability
 * epoch, and every path must produce EXACT per-tip bitmaps — each tip's bitmap
 * names precisely `fullClosure(tip)`, the walk the bitmap will stand in for at
 * serve time. The sequence below is one repo's life: first drain (rebuilt),
 * quiet drain (unchanged — the write-cost guard), refs-only advance (the
 * steady-state delta), a force-push rewind (LOUD fallback to a rebuild that
 * actually reclaims), a ref deletion (same), and finally an emptied repo
 * (cleared). Exactness is asserted against `fullClosure` — the engine clone
 * and connectivity already trust — at every stage.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Database, initKysely } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"
import { type Epoch, loadEpoch, oidsOfUnion, splitOids } from "@/store/reach-epoch"
import { fullClosure } from "@/store/reachability"
import {
	type GcFixture,
	pushFile,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "epoch/producer"

describe("reach-epoch producer (chunk 5b)", () => {
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
		await spawnGit(["checkout", "-q", "-b", "feature", mainTips[0] as string], {
			cwd: src,
		})
		await commit("f.txt", "feat\n")
		await spawnGit(["tag", "-a", "-m", "v1", "v1", mainTips[0] as string], { cwd: src })
		tagOid = (await spawnGit(["rev-parse", "refs/tags/v1"], { cwd: src })).stdout.trim()
		await spawnGit(["checkout", "-q", "main"], { cwd: src })
		mainTips.push(await commit("c.txt", "three\n"))

		const url = repoUrl(fx, REPO)
		await spawnGit(["push", "-q", url, "main", "feature", "refs/tags/v1"], { cwd: src })
		const [row] = await fx.db.sql<{ id: string }[]>`
			select id::text as id from repos where name = ${REPO}`
		id = row?.id as unknown as ReposId
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
		const epoch = await expectReadyEpoch()
		const refs = await fx.db.sql<{ oid: Buffer }[]>`
			select oid from git_ref where repo_id = ${id} and oid is not null`
		const tips = [...new Set(refs.map((r) => r.oid.toString("hex")))].sort()
		expect(epoch.tips).toEqual(tips)
		const all = new Set<string>()
		for (const tip of tips) {
			const bits = epoch.bitmaps.get(tip)
			expect(bits, `bitmap for tip ${tip}`).toBeDefined()
			if (bits === undefined) continue
			const named = oidsOfUnion([bits], epoch.oids)
			const { present, missing } = await fullClosure(db, id, [tip], false)
			expect(missing.size).toBe(0)
			expect(named).toEqual([...present].sort())
			for (const o of named) all.add(o)
			const inSrc = await spawnGit(["cat-file", "-t", tip], { cwd: src }).catch(
				() => null,
			)
			if (inSrc?.stdout.trim() === "commit") {
				const expected = (
					await spawnGit(["rev-list", "--objects", tip], { cwd: src })
				).stdout
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((l) => l.slice(0, 40))
					.sort()
				expect(named, `git oracle for tip ${tip}`).toEqual(expected)
			}
		}
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
		await fx.refs.setRef(REPO, "refs/heads/main", mainTips[1] as string)
		const result = await fx.gc.gc(REPO, { graceSeconds: 0 })
		expect(result.epoch).toBe("rebuilt")
		expect(result.deletedObjects).toBeGreaterThan(0) // mainTips[2..] reclaimed
		await expectExactBitmaps()
	})

	it("a rewind falls back LOUDLY to a rebuild that reclaims the rewound history", async () => {
		// Force-push an UNRELATED single-commit history onto main: the old main
		// line becomes garbage, and its epoch tip is no longer covered.
		await pushFile(fx, REPO, { content: "rewound\n", path: "a.txt", rewind: true })
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

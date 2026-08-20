/**
 * The frontier's boundary provenance (spine S6): `boundaryHits` = the haves the
 * want-side walk actually REACHED (each provably inside the wants' closure, so
 * its closure may be OR'd into a bitmap serve without over-serving), and
 * `boundaryExact` = every exclusion the walk made is justified by a hit have.
 * The bitmap fast path stands on exactly these two fields — a regression to
 * "always false" (permanent fallback) or "always true" (over-serving forks)
 * must fail HERE, not only through end-to-end set equality.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Database, initKysely } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"
import { frontier } from "@/store/reachability"
import {
	type GcFixture,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "frontier/provenance"

describe("frontier boundary provenance (chunk 5b)", () => {
	let fx: GcFixture
	let db: ReturnType<typeof initKysely<Database>>
	let id: ReposId
	let src = ""
	let base = ""
	let a = ""
	let b = ""
	let f = ""

	beforeAll(async () => {
		fx = await setupGcFixture()
		db = initKysely<Database>(fx.db.sql)
		src = mkdtempSync(join(tmpdir(), "pggit-frontprov-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		const commit = async (name: string): Promise<string> => {
			writeFileSync(join(src, name), `${name}\n`)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", name], { cwd: src })
			return (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		}
		base = await commit("base.txt")
		a = await commit("a.txt")
		b = await commit("b.txt")
		await spawnGit(["checkout", "-q", "-b", "fork", base], { cwd: src })
		f = await commit("f.txt")
		await spawnGit(["checkout", "-q", "main"], { cwd: src })
		await spawnGit(["push", "-q", repoUrl(fx, REPO), "main", "fork"], { cwd: src })
		const [row] = await fx.db.sql<{ id: string }[]>`
			select id::text as id from repos where name = ${REPO}`
		if (row === undefined) throw new Error(`repo row missing for ${REPO}`)
		id = row.id as unknown as ReposId
	}, 120_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("a have on the want's own line is HIT, and the walk is exact", async () => {
		const r = await frontier(db, id, [b], [a], false)
		expect(r.boundaryHits).toEqual(new Set([a]))
		expect(r.boundaryExact).toBe(true)
		expect(r.served.has(b)).toBe(true)
		expect(r.served.has(a)).toBe(false)
	})

	it("a fork below the have meets it WITHOUT reaching it — inexact, no hit", async () => {
		// f's history is base←f; the have `a` is NOT reachable from f, but a's
		// descent marks base uninteresting, so the walk excluded base on a's
		// authority — an authority the wants never reached. OR-ing closure(a)
		// here would over-serve; the exactness flag is the only guard.
		const r = await frontier(db, id, [f], [a], false)
		expect(r.boundaryHits).toEqual(new Set())
		expect(r.boundaryExact).toBe(false)
	})

	it("want === have is a trivially exact hit serving nothing", async () => {
		const r = await frontier(db, id, [b], [b], false)
		expect(r.boundaryHits).toEqual(new Set([b]))
		expect(r.boundaryExact).toBe(true)
		expect(r.served.size).toBe(0)
	})

	it("an unreached, untouched have neither hits nor breaks exactness", async () => {
		// `f` is unrelated to b's line above a: its descent marks only base and
		// below, none of which the want-side walk kept — every exclusion is
		// still justified by the hit have `a` alone.
		const r = await frontier(db, id, [b], [a, f], false)
		expect(r.boundaryHits).toEqual(new Set([a]))
		expect(r.boundaryExact).toBe(true)
	})
})

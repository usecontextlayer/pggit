/**
 * The shared driver behind the four `shapes--negative-sweep-*` suites: the `Shape`
 * contract they register against, the fast-import helpers they build fixtures with,
 * and `runShape` — the pipeline that judges one shape against a `file://` control.
 * A test DRIVER shared by sibling suites, the same category as `append-only-repo.ts`,
 * which is why it lives here rather than beside any one suite.
 *
 * The four suites were a single file until the split recorded in
 * `docs/2026-08-20-test-efficiency.md`: the sweep is the longest file in the gate and
 * its solo placement rested on a false claim (no verdict here is timing-based), so the
 * 22 shapes now spread across four sibling files that run in the parallel pool.
 * Identical shapes, identical verdicts — only the file boundaries moved.
 *
 * NEGATIVE RESULTS — the adversarial repo-shape sweep that pggit's delta-pack
 * pipeline SURVIVED. Every shape here was built to break it and did not.
 *
 * Converted from `breakage/shapes--negative-sweep.ts` (exit 0 = every shape held
 * up · exit 1 = a shape diverged from real git). The script's verdict is a pure
 * CORRECTNESS property over hermetically-built repos, so it lands here as a plain
 * e2e test — one `it` per shape, GREEN today, and a regression detector forever.
 *
 * Each shape builds a REAL git repo in $TMPDIR and drives the whole pipeline over
 * the real wire — `git push` → `createRepack().repack()` → `git clone` →
 * incremental `git fetch` → `createGc().gc()` → repack → clone — judging ONLY what
 * real git observes: clone/fetch success, `git fsck --strict`, byte-identical
 * object sets (an OID IS the object's bytes) and ref sets, all against a plain
 * `file://` bare remote driven through the identical dance. Partial-clone filters
 * (`blob:none`, `tree:0`) are exercised against the repacked repo too.
 *
 * The delta count in the real clone's pack is the proof the delta path was
 * actually on. `git verify-pack -v` reads it on the client side, and every shape
 * built so the delta wins carries an asserted floor. Shapes that legitimately
 * serve none (`tags`, `blob-edges`) omit `minDeltasServed`, so the exception is
 * stated rather than assumed.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import type { GitServer } from "@/server"
import type { Gc } from "@/store/gc"
import type { Repack } from "@/store/repack"
import { FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import { branchAndTagRefsOf, parseVerifyPackObjects } from "@/testing/git-fixtures"
import { repoUrl } from "@/testing/git-server-fixture"
import { spawnGit } from "@/testing/spawn-git"

const PUSH_REFSPECS = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]

// Fixture scale. These were the source script's env-overridable defaults; the
// shapes are only adversarial AT these sizes (a 20-level nest or a 200-commit
// linear history exercises nothing), so they are pinned constants here.
export const DEPTH = 2000
export const WIDE = 20_000
export const LINEAR = 10_000

export type Mk = (tag: string) => string

export type Shape = {
	build: (dir: string) => Promise<void>
	extend?: (dir: string) => Promise<void>
	/** arbitrary ref surgery pushed to BOTH remotes (deletes, orphan refs, …) */
	mutate?: (dir: string, url: string, mirror: string, mk: Mk) => Promise<void>
	/** Floor on the REF_DELTA entries the post-repack clone must be served. Set on
	 * every shape built so "the delta actually wins"; omitted where a shape
	 * legitimately serves none (`tags`, `blob-edges`), so that exception is stated
	 * rather than inferred from silence. */
	minDeltasServed?: number
}

/** What a suite's `beforeAll` fixture hands the driver: the server the shapes are
 * pushed to over the real wire, and the two store operations the pipeline drives
 * between clones. */
export type ShapeSweepContext = {
	server: GitServer
	repack: Repack
	gc: Gc
}

async function objectList(dir: string): Promise<string[]> {
	const r = await spawnGit(
		[
			"cat-file",
			"--batch-all-objects",
			"--batch-check=%(objectname) %(objecttype) %(objectsize)",
		],
		{ cwd: dir },
	)
	return r.stdout.trim().split("\n").filter(Boolean).sort()
}

async function refList(dir: string): Promise<string[]> {
	return (await branchAndTagRefsOf(dir)).map(({ name, oid }) => `${oid} ${name}`)
}

/** Delta entries in the packs a bare clone actually retained, per canonical git. */
async function servedDeltaCount(dir: string): Promise<number> {
	const packDir = join(dir, "objects", "pack")
	const indexes = readdirSync(packDir).filter((name) => name.endsWith(".idx"))
	if (indexes.length === 0) throw new Error("the client clone retained no pack index")
	let deltas = 0
	for (const file of indexes) {
		const out = await spawnGit(["verify-pack", "-v", join(packDir, file)], { cwd: dir })
		deltas += parseVerifyPackObjects(out.stdout).filter(
			(object) => object.kind === "delta",
		).length
	}
	return deltas
}

// ───────────────────────── helpers for building shapes ─────────────────────────

/** Feed a fast-import stream into `dir`. */
export async function fastImport(dir: string, stream: string): Promise<void> {
	await spawnGit(["fast-import", "--quiet", "--done"], {
		cwd: dir,
		input: `${stream}done\n`,
	})
}

/** An append-only directory that gains one entry per commit, so each version of
 * the growing tree pairs with its predecessor and the delta actually wins. */
export function growing(opts: {
	commits: number
	/** extra fast-import file commands per commit `i`, given a mark allocator */
	extraChanges?: (i: number, blob: (s: string) => number) => string[]
	/** entry added at commit `i` inside the growing dir */
	entry: (i: number, blob: (s: string) => number) => string
}): (dir: string) => Promise<void> {
	return async (dir: string) => {
		const out: string[] = []
		let mark = 0
		const blob = (s: string): number => {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(s)}\n${s}\n`)
			return m
		}
		let prev = 0
		for (let i = 0; i < opts.commits; i++) {
			const changes = [opts.entry(i, blob), ...(opts.extraChanges?.(i, blob) ?? [])]
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nc${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					`${changes.join("\n")}\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	}
}

/**
 * Drive one shape through the whole pipeline against a `file://` bare remote
 * running the identical dance. Every judgement is real git's: clone/fetch
 * success, `fsck --strict`, and byte-identical object/ref sets.
 */
export async function runShape(
	{ server, repack, gc }: ShapeSweepContext,
	name: string,
	s: Shape,
): Promise<void> {
	const scratch: string[] = []
	const mk: Mk = (tag) => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	try {
		const src = join(mk(name), "src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await s.build(src)
		const srcObjs = await objectList(src)
		console.log(
			`shape ${name} — source: ${srcObjs.length} objects, ${(await refList(src)).length} refs`,
		)

		// The oracle: a plain bare git remote driven through the identical dance.
		const mirror = join(mk(`${name}-mirror`), "m.git")
		await spawnGit(["init", "-q", "--bare", mirror])
		await spawnGit(["config", "uploadpack.allowFilter", "true"], { cwd: mirror })
		await spawnGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: mirror })
		await spawnGit(["push", "-q", mirror, ...PUSH_REFSPECS], { cwd: src })
		const ctl = join(mk(`${name}-ctl`), "c.git")
		await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, ctl])
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: ctl })
		const ctlObjs = await objectList(ctl)

		const url = repoUrl(server, name)
		await spawnGit(["push", "-q", url, ...PUSH_REFSPECS], { cwd: src })

		const pre = join(mk(`${name}-pre`), "c.git")
		await spawnGit(["clone", "-q", "--bare", url, pre])
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: pre })
		const preObjs = await objectList(pre)
		expect(preObjs.length).toBe(ctlObjs.length)
		expect(preObjs.join("\n")).toBe(ctlObjs.join("\n"))

		const t0 = Date.now()
		const res = await repack.repack(name)
		console.log(
			`shape ${name} — repack: ${res.wholes} wholes + ${res.deltas} deltas in ${Date.now() - t0}ms`,
		)

		const post = join(mk(`${name}-post`), "c.git")
		await spawnGit(["clone", "-q", "--bare", url, post])
		const deltasServed = await servedDeltaCount(post)
		console.log(`shape ${name} — client retained ${deltasServed} delta entries`)
		// The proof the delta path was actually ON for this shape. Every shape
		// carrying a floor is built so the delta wins; without this the whole sweep
		// stays green with deltified serving deleted.
		if (s.minDeltasServed !== undefined) {
			expect(
				deltasServed,
				`${name}: the delta serve path was not exercised`,
			).toBeGreaterThanOrEqual(s.minDeltasServed)
		}
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: post })
		const postObjs = await objectList(post)
		expect(postObjs.length).toBe(ctlObjs.length)
		expect(postObjs.join("\n")).toBe(ctlObjs.join("\n"))

		// partial-clone filters against the repacked repo (a delta whose base is
		// filtered OUT of the served set must fall back to its whole form).
		for (const f of ["blob:none", "tree:0"]) {
			const pf = join(mk(`${name}-pf`), "c.git")
			const cf = join(mk(`${name}-cf`), "c.git")
			await spawnGit(["clone", "-q", "--bare", `--filter=${f}`, `file://${mirror}`, cf])
			await spawnGit(["clone", "-q", "--bare", `--filter=${f}`, url, pf])
			// "usable" asserted, not assumed — every other clone in this function
			// is fsck'd and these were not.
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: pf })
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: cf })
			const pgSet = new Set(await objectList(pf))
			const ctlSet = new Set(await objectList(cf))
			if (f === "tree:0") {
				// tree:0 is a KNOWN pre-existing gap (pggit ignores it and ships a
				// superset — src/e2e/transport-filter-tree0.test.ts). Pin the
				// documented behaviour rather than nothing: the served set must
				// CONTAIN the control's, so a change in the shape of the gap fails
				// loudly instead of passing unnoticed.
				expect(
					[...ctlSet].filter((o) => !pgSet.has(o)),
					`${name}: pggit's tree:0 clone is MISSING objects the control served`,
				).toEqual([])
			} else {
				expect([...pgSet].sort().join("\n")).toBe([...ctlSet].sort().join("\n"))
			}
		}

		const postRefs = await refList(post)
		const ctlRefs = await refList(ctl)
		expect(postRefs).toEqual(ctlRefs)

		if (s.extend) {
			await s.extend(src)
			await spawnGit(["push", "-q", mirror, ...PUSH_REFSPECS], { cwd: src })
			await spawnGit(["push", "-q", url, ...PUSH_REFSPECS], { cwd: src })
			const res2 = await repack.repack(name)
			console.log(
				`shape ${name} — repack2: ${res2.wholes} wholes + ${res2.deltas} deltas`,
			)
			await spawnGit(["fetch", "-q", "--tags", "--force", url, ...PUSH_REFSPECS], {
				cwd: post,
			})
			await spawnGit(
				["fetch", "-q", "--tags", "--force", `file://${mirror}`, ...PUSH_REFSPECS],
				{
					cwd: ctl,
				},
			)
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: post })
			const inc = await objectList(post)
			const ctl2 = await objectList(ctl)
			expect(inc.length).toBe(ctl2.length)
			expect(inc.join("\n")).toBe(ctl2.join("\n"))
		}

		if (s.mutate) {
			await s.mutate(src, url, mirror, mk)
			const resM = await repack.repack(name)
			console.log(
				`shape ${name} — repackM: ${resM.wholes} wholes + ${resM.deltas} deltas`,
			)
			const mp = join(mk(`${name}-mp`), "c.git")
			const mc = join(mk(`${name}-mc`), "c.git")
			await spawnGit(["clone", "-q", "--bare", url, mp])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: mp })
			await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, mc])
			expect((await objectList(mp)).join("\n")).toBe((await objectList(mc)).join("\n"))
			expect(await refList(mp)).toEqual(await refList(mc))
		}

		const gcRes = await gc.gc(name, { graceSeconds: 0 })
		const res3 = await repack.repack(name)
		console.log(
			`shape ${name} — gc: ${gcRes.deletedObjects} objs; repack3: ${res3.wholes}+${res3.deltas}`,
		)
		const gcd = join(mk(`${name}-gcd`), "c.git")
		await spawnGit(["clone", "-q", "--bare", url, gcd])
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: gcd })
		const gcdObjs = await objectList(gcd)
		const ctlFresh = join(mk(`${name}-ctlf`), "c.git")
		await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, ctlFresh])
		const ctlFinal = await objectList(ctlFresh)
		expect(gcdObjs.length).toBe(ctlFinal.length)
		expect(gcdObjs.join("\n")).toBe(ctlFinal.join("\n"))
	} finally {
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	}
}

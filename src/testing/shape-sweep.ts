/**
 * The shared driver behind the four `regressions/shapes/negative-sweep-*` suites:
 * the `Shape` contract they register against, the fast-import helpers they build
 * fixtures with, and `runShape` — the pipeline that judges one shape against a
 * `file://` control. A test DRIVER shared by sibling suites, the same category as
 * `append-only-repo.ts`, which is why it lives here rather than beside any one suite.
 *
 * NEGATIVE RESULTS — the adversarial repo-shape sweep that pggit's delta-pack
 * pipeline SURVIVED. Every shape here was built to break it and did not.
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

// The shapes are only adversarial AT these sizes (a 20-level nest or a 200-commit
// linear history exercises nothing), so fixture scale is pinned here.
export const DEPTH = 2000
export const WIDE = 20_000
export const LINEAR = 10_000

export type ScratchDirectoryFactory = (tag: string) => string

export type Shape = {
	build: (dir: string) => Promise<void>
	extend?: (dir: string) => Promise<void>
	/** arbitrary ref surgery pushed to BOTH remotes (deletes, orphan refs, …) */
	mutate?: (
		directory: string,
		remoteUrl: string,
		mirrorDirectory: string,
		createScratchDirectory: ScratchDirectoryFactory,
	) => Promise<void>
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
	shape: Shape,
): Promise<void> {
	const scratch: string[] = []
	const createScratchDirectory: ScratchDirectoryFactory = (tag) => {
		const directory = mkdtempSync(join(tmpdir(), `pggit-shape-${tag}-`))
		scratch.push(directory)
		return directory
	}

	try {
		const source = join(createScratchDirectory(name), "src")
		await spawnGit(["init", "-q", "-b", "main", source])
		await shape.build(source)
		const sourceObjects = await objectList(source)
		console.log(
			`shape ${name} — source: ${sourceObjects.length} objects, ${(await refList(source)).length} refs`,
		)

		// The oracle: a plain bare git remote driven through the identical dance.
		const mirror = join(createScratchDirectory(`${name}-mirror`), "m.git")
		await spawnGit(["init", "-q", "--bare", mirror])
		await spawnGit(["config", "uploadpack.allowFilter", "true"], { cwd: mirror })
		await spawnGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: mirror })
		await spawnGit(["push", "-q", mirror, ...PUSH_REFSPECS], { cwd: source })
		const control = join(createScratchDirectory(`${name}-control`), "c.git")
		await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, control])
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: control })
		const controlObjects = await objectList(control)

		const remoteUrl = repoUrl(server, name)
		await spawnGit(["push", "-q", remoteUrl, ...PUSH_REFSPECS], { cwd: source })

		const beforeRepack = join(createScratchDirectory(`${name}-before-repack`), "c.git")
		await spawnGit(["clone", "-q", "--bare", remoteUrl, beforeRepack])
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: beforeRepack })
		const beforeRepackObjects = await objectList(beforeRepack)
		expect(beforeRepackObjects.length).toBe(controlObjects.length)
		expect(beforeRepackObjects.join("\n")).toBe(controlObjects.join("\n"))

		const repackStartedAt = Date.now()
		const repackResult = await repack.repack(name)
		console.log(
			`shape ${name} — repack: ${repackResult.wholes} wholes + ${repackResult.deltas} deltas in ${Date.now() - repackStartedAt}ms`,
		)

		const afterRepack = join(createScratchDirectory(`${name}-after-repack`), "c.git")
		await spawnGit(["clone", "-q", "--bare", remoteUrl, afterRepack])
		const deltasServed = await servedDeltaCount(afterRepack)
		console.log(`shape ${name} — client retained ${deltasServed} delta entries`)
		// The proof the delta path was actually ON for this shape. Every shape
		// carrying a floor is built so the delta wins; without this the whole sweep
		// stays green with deltified serving deleted.
		if (shape.minDeltasServed !== undefined) {
			expect(
				deltasServed,
				`${name}: the delta serve path was not exercised`,
			).toBeGreaterThanOrEqual(shape.minDeltasServed)
		}
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: afterRepack })
		const afterRepackObjects = await objectList(afterRepack)
		expect(afterRepackObjects.length).toBe(controlObjects.length)
		expect(afterRepackObjects.join("\n")).toBe(controlObjects.join("\n"))

		// partial-clone filters against the repacked repo (a delta whose base is
		// filtered OUT of the served set must fall back to its whole form).
		for (const filter of ["blob:none", "tree:0"]) {
			const filteredServed = join(
				createScratchDirectory(`${name}-filtered-served`),
				"c.git",
			)
			const filteredControl = join(
				createScratchDirectory(`${name}-filtered-control`),
				"c.git",
			)
			await spawnGit([
				"clone",
				"-q",
				"--bare",
				`--filter=${filter}`,
				`file://${mirror}`,
				filteredControl,
			])
			await spawnGit([
				"clone",
				"-q",
				"--bare",
				`--filter=${filter}`,
				remoteUrl,
				filteredServed,
			])
			// "usable" asserted, not assumed — every other clone in this function
			// is fsck'd and these were not.
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: filteredServed })
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: filteredControl })
			const servedSet = new Set(await objectList(filteredServed))
			const controlSet = new Set(await objectList(filteredControl))
			if (filter === "tree:0") {
				// tree:0 is an intentional gap: pggit ignores it and ships a
				// superset — src/e2e/transport/filter-tree0.test.ts. Pin the
				// documented behaviour rather than nothing: the served set must
				// CONTAIN the control's, so a change in the shape of the gap fails
				// loudly instead of passing unnoticed.
				expect(
					[...controlSet].filter((oid) => !servedSet.has(oid)),
					`${name}: pggit's tree:0 clone is MISSING objects the control served`,
				).toEqual([])
			} else {
				expect([...servedSet].sort().join("\n")).toBe([...controlSet].sort().join("\n"))
			}
		}

		const servedRefs = await refList(afterRepack)
		const controlRefs = await refList(control)
		expect(servedRefs).toEqual(controlRefs)

		if (shape.extend) {
			await shape.extend(source)
			await spawnGit(["push", "-q", mirror, ...PUSH_REFSPECS], { cwd: source })
			await spawnGit(["push", "-q", remoteUrl, ...PUSH_REFSPECS], { cwd: source })
			const incrementalRepack = await repack.repack(name)
			console.log(
				`shape ${name} — incremental repack: ${incrementalRepack.wholes} wholes + ${incrementalRepack.deltas} deltas`,
			)
			await spawnGit(["fetch", "-q", "--tags", "--force", remoteUrl, ...PUSH_REFSPECS], {
				cwd: afterRepack,
			})
			await spawnGit(
				["fetch", "-q", "--tags", "--force", `file://${mirror}`, ...PUSH_REFSPECS],
				{
					cwd: control,
				},
			)
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: afterRepack })
			const incrementalObjects = await objectList(afterRepack)
			const incrementalControlObjects = await objectList(control)
			expect(incrementalObjects.length).toBe(incrementalControlObjects.length)
			expect(incrementalObjects.join("\n")).toBe(incrementalControlObjects.join("\n"))
		}

		if (shape.mutate) {
			await shape.mutate(source, remoteUrl, mirror, createScratchDirectory)
			const mutationRepack = await repack.repack(name)
			console.log(
				`shape ${name} — mutation repack: ${mutationRepack.wholes} wholes + ${mutationRepack.deltas} deltas`,
			)
			const mutatedServed = join(
				createScratchDirectory(`${name}-mutated-served`),
				"c.git",
			)
			const mutatedControl = join(
				createScratchDirectory(`${name}-mutated-control`),
				"c.git",
			)
			await spawnGit(["clone", "-q", "--bare", remoteUrl, mutatedServed])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: mutatedServed })
			await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, mutatedControl])
			expect((await objectList(mutatedServed)).join("\n")).toBe(
				(await objectList(mutatedControl)).join("\n"),
			)
			expect(await refList(mutatedServed)).toEqual(await refList(mutatedControl))
		}

		const gcResult = await gc.gc(name, { graceSeconds: 0 })
		const postGcRepack = await repack.repack(name)
		console.log(
			`shape ${name} — gc: ${gcResult.deletedObjects} objects; post-GC repack: ${postGcRepack.wholes} wholes + ${postGcRepack.deltas} deltas`,
		)
		const afterGc = join(createScratchDirectory(`${name}-after-gc`), "c.git")
		await spawnGit(["clone", "-q", "--bare", remoteUrl, afterGc])
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: afterGc })
		const afterGcObjects = await objectList(afterGc)
		const finalControl = join(createScratchDirectory(`${name}-final-control`), "c.git")
		await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, finalControl])
		const finalControlObjects = await objectList(finalControl)
		expect(afterGcObjects.length).toBe(finalControlObjects.length)
		expect(afterGcObjects.join("\n")).toBe(finalControlObjects.join("\n"))
	} finally {
		for (const directory of scratch) {
			rmSync(directory, { force: true, recursive: true })
		}
	}
}

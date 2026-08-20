/**
 * Repack's small-object bind-parameter wall (breakage probe
 * `perf--repack-small-object-wall.ts`).
 *
 * `createRepack().repack()` has NO hard object-count wall: the pass completes and
 * covers the whole inventory at every fixture size, on repos `git repack -adf`
 * handles fine.
 *
 * THE DEFECT THIS PINS: repack's phase-2 coverage sweep once batched pending
 * objects by BYTES only (a 16 MB round-trip) and fed each batch to an
 * `oid in (…)` value list, so a repo of many SMALL objects packed an unbounded
 * number of oids into one query. porsager refuses at 65,534 bind parameters
 * (Postgres' int16 ceiling), and the whole pass threw — no partial progress, no
 * encoding tier, forever. The sweep now also flushes on oid COUNT, so the batch
 * is bounded on both axes.
 *
 * Black-box: one commit with W tiny files, seeded through `putPack`, then
 * `repack()`. Comparator: `git repack -adf` on the same repo.
 *
 * Routed here rather than to `perf/breakage/` because the probe's only verdict is
 * a correctness one — whether repack throws on a repo `git repack -adf` handles
 * fine. There is no measured threshold to exceed; the wall timings it printed
 * survive as console output beside the assertion.
 *
 * FIXTURE SCALE IS THE TEST. The sizes straddle 65,534 — 10k and 60k below the
 * ceiling, 70k and 100k above it. Shrinking them moves the fixture off the
 * boundary the defect lived on, and the suite would go green having exercised
 * nothing near it.
 *
 * Originated as breakage probe `perf--repack-small-object-wall.ts`, which
 * reproduced the bind-parameter wall; fixed.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { PackInputObject } from "@/pack/write-pack"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import { branchAndTagRefsOf, loadReachableObjects } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** Two sizes under porsager's 65,534-parameter ceiling, two over it. */
const SIZES = [10_000, 60_000, 70_000, 100_000]

/** Objects per `putPack` round-trip when seeding (bytes are negligible here). */
const SEED_BATCH = 20_000

/** One commit, W tiny unique files spread over 100 directories. */
function stream(w: number): string {
	const out: string[] = []
	const changes: string[] = []
	for (let i = 0; i < w; i++) {
		out.push(`blob\nmark :${i + 1}\ndata ${String(i).length + 1}\n${i}\n\n`)
		changes.push(`M 100644 :${i + 1} d${i % 100}/f${i}.txt`)
	}
	out.push(
		`commit refs/heads/main\nmark :${w + 1}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nseed\n${changes.join("\n")}\n`,
	)
	return out.join("")
}

describe("repack — the small-object bind-parameter wall", () => {
	let db: IsolatedDb
	let objects: ObjectStore
	let refs: RefStore
	let repack: Repack
	const scratch: string[] = []

	/** A fresh temp root the suite owns and tears down in `afterAll`. */
	function scratchDir(tag: string): string {
		const d = mkdtempSync(join(tmpdir(), `pggit-small-object-${tag}-`))
		scratch.push(d)
		return d
	}

	/** Build a repo from a raw fast-import stream — one process, no per-commit spawn. */
	async function importRepo(tag: string, fastImport: string): Promise<string> {
		const dir = join(scratchDir(tag), "repo")
		mkdirSync(dir, { recursive: true })
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: fastImport })
		return dir
	}

	/**
	 * The real-git oracle: `git repack -adf` on a COPY of the repo. `spawnGit`
	 * rejects on a non-zero exit, so canonical git failing on the fixture fails the
	 * test here — which would mean the fixture is the problem, not pggit.
	 */
	async function gitRepack(
		srcDir: string,
		tag: string,
	): Promise<{ ms: number; packBytes: number }> {
		const dir = join(scratchDir(tag), "repo")
		cpSync(srcDir, dir, { recursive: true })
		const t0 = Date.now()
		await spawnGit(["repack", "-adf", "-q"], { cwd: dir })
		const ms = Date.now() - t0
		const out = await spawnGit(["count-objects", "-v"], { cwd: dir })
		const sizePack = out.stdout.match(/^size-pack: (\d+)$/m)?.[1]
		if (sizePack === undefined) {
			throw new Error(`git count-objects omitted size-pack: ${out.stdout}`)
		}
		const kb = Number(sizePack)
		return { ms, packBytes: kb * 1024 }
	}

	/** Seed a real repo's objects + refs through the public store. */
	async function seedRepo(
		repoId: string,
		dir: string,
		objs: PackInputObject[],
	): Promise<void> {
		for (let i = 0; i < objs.length; i += SEED_BATCH) {
			await objects.putPack(repoId, objs.slice(i, i + SEED_BATCH))
		}
		for (const ref of await branchAndTagRefsOf(dir)) {
			await refs.setRef(repoId, ref.name, ref.oid)
		}
		const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: dir })).stdout.trim()
		await refs.setSymref(repoId, "HEAD", head)
	}

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		repack = createRepack(db.sql)
	}, 300_000)

	afterAll(async () => {
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	for (const w of SIZES) {
		it(`covers a ${w}-file repo that \`git repack -adf\` handles fine`, async () => {
			const repoId = `small-${w}`
			const dir = await importRepo(`w${w}`, stream(w))
			const git = await gitRepack(dir, `w${w}-git`)
			const objs = await loadReachableObjects(dir, ["--all"])
			await seedRepo(repoId, dir, objs)

			const t0 = Date.now()
			const result = await repack.repack(repoId)
			const ms = Date.now() - t0
			console.log(
				`${w} files → ${objs.length} objects · pggit repack ${(ms / 1000).toFixed(2)}s ` +
					`→ ${result.wholes}w+${result.deltas}d · git repack -adf ` +
					`${(git.ms / 1000).toFixed(2)}s / ${(git.packBytes / 1_000_000).toFixed(2)} MB`,
			)

			// The defect is a hard ceiling, not a slowdown: past 65,534 bind parameters
			// the `oid in (…)` value list is refused and the pass throws, leaving NO
			// encoding tier at all — no partial progress, forever. Correct behaviour is
			// full coverage: one encoding row per stored object, at every size.
			expect(result.wholes + result.deltas).toBe(objs.length)
		}, 300_000)
	}
})

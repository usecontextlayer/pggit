/**
 * RACE: wire pushes into the SAME delta lineage while a repack pass is running.
 *
 * Two shapes, both aimed at the encoder's base-selection policy (design D4:
 * "frozen, deterministic — bases finalize before dependents, existing rows are
 * never rewritten"). That policy is a claim about ONE pass over a FIXED commit
 * set; a push landing mid-pass changes the commit set the walk is derived from,
 * and the walk's topological order is recomputed from scratch on the next pass.
 *
 *   same-path  one push appending to the append-only directory whose successive
 *              tree versions ARE the lineage the encoder deltifies, fired at a
 *              swept offset into a concurrent repack; then a clone.
 *   two-push   two clients racing to move refs/heads/main to DIFFERENT commits
 *              while a repack runs. Exactly one must win; the repo must then
 *              serve the winner's tip, fsck-clean.
 *
 * Verdict is git's: push exit status, clone, `git fsck --strict`, and that the
 * clone's HEAD equals whatever `git ls-remote` says the ref is — both with the
 * tier as the race left it AND after one more converging repack.
 *
 * Converted from `breakage/race--two-pushes-repack.ts` (`--iters=25 --runs=400`).
 * Probabilistic: the iteration count, the two modes and the swept repack-start
 * delays are frozen exactly as the script ran them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { PackInputObject } from "@/pack/write-pack"
import type { GitServer } from "@/server"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo, RUNS_DIR, runDirName } from "@/testing/append-only-repo"
import { loadReachableObjects } from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 25
const RUNS = 400
const MODES = ["same-path", "two-push"] as const

const msg = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""

/** Add one run directory to the append-only lineage and commit it. */
async function commitRun(dir: string, n: number, salt: string): Promise<string> {
	const run = join(dir, RUNS_DIR, runDirName(n))
	mkdirSync(run, { recursive: true })
	writeFileSync(join(run, "record.json"), `{"run":${n},"salt":"${salt}"}\n`)
	writeFileSync(join(run, "stderr"), `err ${n} ${salt}\n`)
	await spawnGit(["add", "-A"], { cwd: dir })
	await spawnGit(["commit", "-q", "-m", `run ${n} ${salt}`], { cwd: dir })
	return (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
}

describe("race — wire pushes into the delta lineage while a repack runs", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let src = ""
	let a = ""
	let b = ""
	let objects: PackInputObject[] = []
	let tip = ""
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		// Two independent working checkouts of the same history.
		a = join(mkdtempSync(join(tmpdir(), "tpr-a-")), "c")
		b = join(mkdtempSync(join(tmpdir(), "tpr-b-")), "c")
		scratch.push(a, b)
		await spawnGit(["clone", "-q", src, a])
		await spawnGit(["clone", "-q", src, b])

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		repack = createRepack(db.sql)
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("exactly one push wins and the repo serves that tip, fsck-clean, before and after a converging repack", async () => {
		const breaks: string[] = []
		const tally: Record<string, number> = {}
		const bump = (k: string) => {
			tally[k] = (tally[k] ?? 0) + 1
		}

		outer: for (let i = 0; i < ITERS; i++) {
			for (const mode of MODES) {
				const repo = `race/tpr/${mode}/${i}`
				const url = repoUrl(server, repo)
				await store.putPack(repo, objects)
				await refs.setRef(repo, "refs/heads/main", tip)
				await refs.setSymref(repo, "HEAD", "refs/heads/main")
				// Partially covered tier: the OLD history is encoded, the pushes are not.
				await repack.repack(repo)

				await spawnGit(["reset", "-q", "--hard", tip], { cwd: a })
				await spawnGit(["reset", "-q", "--hard", tip], { cwd: b })
				await commitRun(a, RUNS + i, `a${i}`)
				await commitRun(b, RUNS + i, `b${i}`)

				const delay = [0, 3, 8, 15, 25, 40, 65, 100, 150, 220][i % 10] as number
				const problems: string[] = []
				let errA: unknown
				let errB: unknown
				let repackErr: unknown

				if (mode === "same-path") {
					await Promise.allSettled([
						spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: a }).catch(
							(e) => {
								errA = e
							},
						),
						sleep(delay).then(() =>
							repack.repack(repo).catch((e) => {
								repackErr = e
							}),
						),
					])
					if (errA !== undefined) problems.push(`push rejected: ${msg(errA)}`)
				} else {
					await Promise.allSettled([
						spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: a }).catch(
							(e) => {
								errA = e
							},
						),
						spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: b }).catch(
							(e) => {
								errB = e
							},
						),
						sleep(delay).then(() =>
							repack.repack(repo).catch((e) => {
								repackErr = e
							}),
						),
					])
					const winners = [errA === undefined, errB === undefined].filter(Boolean).length
					// Both pushes are siblings of the same parent, so at most one can be a
					// fast-forward; the other must be refused.
					if (winners !== 1)
						problems.push(`expected exactly 1 push to win, got ${winners}`)
					bump(`two-push winners=${winners}`)
				}
				if (repackErr !== undefined) problems.push(`repack threw: ${msg(repackErr)}`)

				// Whatever the ref says now, the repo must serve it soundly — with the
				// tier as the race left it AND after one more converging repack.
				const ls = await spawnGit(["ls-remote", url, "refs/heads/main"], { cwd: a })
				const serverTip = ls.stdout.trim().split(/\s+/)[0] ?? ""
				for (const [tag, pre] of [
					["as-raced", async () => undefined],
					["after-repack", async () => void (await repack.repack(repo))],
				] as const) {
					await pre()
					const dest = join(mkdtempSync(join(tmpdir(), `tpr-${tag}-`)), "c")
					scratch.push(dest)
					try {
						await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
						await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
						const h = (await spawnGit(["rev-parse", "HEAD"], { cwd: dest })).stdout.trim()
						if (h !== serverTip)
							problems.push(`${tag}: clone HEAD ${h} != ref ${serverTip}`)
					} catch (e) {
						problems.push(`${tag}: ${msg(e)}`)
					}
					rmSync(dest, { force: true, recursive: true })
				}

				if (problems.length > 0) {
					breaks.push(
						`iteration ${i}, mode ${mode}, repack at +${delay}ms: ${problems.join(" | ")}`,
					)
					break outer
				}
			}
		}

		expect(breaks, JSON.stringify(tally, null, 2)).toEqual([])
	}, 1_800_000)
})

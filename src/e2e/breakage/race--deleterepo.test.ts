/**
 * RACE: `admin.deleteRepo()` against everything else in flight.
 *
 * Repo deletion is a bare `DELETE FROM repos` relying entirely on FK cascade —
 * including the new `git_pack_encoding` cascade (migration 0008). `repo-admin.ts`
 * says outright that "a live writer racing this call can resurrect the repo
 * (ensureRepoId is get-or-create); quiescing writers is the caller's contract".
 * This measures what that costs a git client.
 *
 * Modes:
 *   clone   — deleteRepo fired mid-clone
 *   repack  — deleteRepo fired mid-repack (the encoding tier's FK parent goes
 *             away underneath an in-flight COPY)
 *   push    — deleteRepo fired mid-push, the resurrection case: does receive-pack
 *             ever report SUCCESS for a push whose objects the cascade removed?
 *
 * The only real defect shapes: a clone that exits 0 with an unsound repository,
 * or a push git called successful whose ref is left pointing at objects that no
 * longer exist (a permanently unclonable repo).
 *
 * Converted from `breakage/race--deleterepo.ts` (`--iters=20 --runs=120`).
 * Probabilistic: the iteration count, the three modes and the swept delete-start
 * delays are frozen exactly as the script ran them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps, type GitDeps } from "@/index"
import type { PackInputObject } from "@/pack/write-pack"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { loadReachableObjects } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 20
const RUNS = 120
const MODES = ["clone", "repack", "push"] as const

const msg = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""

describe("race — admin.deleteRepo() against a clone / repack / push in flight", () => {
	let db: IsolatedDb
	let server: GitServer
	let deps: GitDeps
	let repack: Repack
	let src = ""
	let client = ""
	let objects: PackInputObject[] = []
	let tip = ""
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		client = join(mkdtempSync(join(tmpdir(), "delrepo-client-")), "c")
		scratch.push(client)
		await spawnGit(["clone", "-q", src, client])

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		deps = createGitDeps(db.sql)
		repack = createRepack(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("a delete racing a clone/repack/push never leaves an acked-but-unsound result", async () => {
		const breaks: string[] = []
		const tally: Record<string, number> = {}
		const bump = (k: string) => {
			tally[k] = (tally[k] ?? 0) + 1
		}

		outer: for (let i = 0; i < ITERS; i++) {
			for (const mode of MODES) {
				const repo = `race/delrepo/${mode}/${i}`
				const url = `http://127.0.0.1:${server.port}/${repo}`
				await deps.objects.putPack(repo, objects)
				await deps.refs.setRef(repo, "refs/heads/main", tip)
				await deps.refs.setSymref(repo, "HEAD", "refs/heads/main")
				if (mode !== "repack") await repack.repack(repo)

				const delay = [0, 2, 5, 10, 20, 40, 70, 120][i % 8] as number
				const dest = join(mkdtempSync(join(tmpdir(), `delrepo-${mode}-`)), "c")
				scratch.push(dest)
				const problems: string[] = []
				let actorErr: unknown
				let repackErr: unknown

				if (mode === "clone") {
					await Promise.allSettled([
						spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest]).catch(
							(e) => {
								actorErr = e
							},
						),
						sleep(delay).then(() => deps.admin.deleteRepo(repo)),
					])
					if (actorErr === undefined) {
						// An EMPTY clone is not a race defect: pggit treats an unknown repo
						// name as an empty repo (they are created lazily on first push), so a
						// delete that lands before info/refs advertises nothing and git clones
						// an empty repository, exit 0. Only a NON-empty clone has to be sound.
						const cloneHead = await spawnGit(["rev-parse", "HEAD"], { cwd: dest }).then(
							(r) => r.stdout.trim(),
							() => "",
						)
						if (cloneHead === "") {
							bump("clone empty (repo already gone at info/refs)")
						} else {
							try {
								await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
								if (cloneHead !== tip) {
									problems.push(`clone said OK but HEAD ${cloneHead} != ${tip}`)
								}
								bump("clone ok")
							} catch (e) {
								problems.push(`CLONE SAID OK BUT UNSOUND: ${msg(e)}`)
							}
						}
					} else {
						bump("clone err")
					}
				} else if (mode === "repack") {
					await Promise.allSettled([
						repack.repack(repo).catch((e) => {
							repackErr = e
						}),
						sleep(delay).then(() => deps.admin.deleteRepo(repo)),
					])
					bump(
						`repack ${repackErr === undefined ? "ok" : `err(${msg(repackErr).slice(0, 60)})`}`,
					)
					// The verdict this mode exists for: migration 0008's cascade owns one
					// direction — no `git_pack_encoding` row may outlive its `repos` row.
					// A repack that wrote encodings for a repo the cascade just removed
					// leaves exactly that orphan, and neither the throw nor the silence
					// tells you which happened.
					const [orphans] = await db.sql<{ n: number }[]>`
						select count(*)::int as n from git_pack_encoding e
							where not exists (select 1 from repos r where r.id = e.repo_id)`
					if (orphans === undefined) throw new Error("orphan aggregate returned no row")
					if (orphans.n > 0) {
						problems.push(
							`repack left ${orphans.n} git_pack_encoding row(s) with no repos row`,
						)
					}
					// If a writer resurrected the repo row, what it serves must be sound.
					const survivors = await db.sql`select 1 from repos where name = ${repo}`.then(
						(r) => r.length,
					)
					if (survivors > 0) {
						try {
							await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
							await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
						} catch (e) {
							problems.push(`REPO SURVIVED THE DELETE BUT IS NOT SERVABLE: ${msg(e)}`)
						}
					}
				} else {
					await spawnGit(["reset", "-q", "--hard", tip], { cwd: client })
					writeFileSync(join(client, "del.txt"), `del ${i} ${Date.now()}\n`)
					await spawnGit(["add", "del.txt"], { cwd: client })
					await spawnGit(["commit", "-q", "-m", `del ${i}`], { cwd: client })
					const pushed = (
						await spawnGit(["rev-parse", "HEAD"], { cwd: client })
					).stdout.trim()
					await Promise.allSettled([
						spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: client }).catch(
							(e) => {
								actorErr = e
							},
						),
						sleep(delay).then(() => deps.admin.deleteRepo(repo)),
					])
					if (actorErr === undefined) {
						// git said the push succeeded. Either the repo is gone entirely
						// (acceptable — the operator deleted it) or it must serve the tip.
						const ls = await spawnGit(["ls-remote", url, "refs/heads/main"], {
							cwd: client,
						}).catch(() => undefined)
						const serverTip = ls?.stdout.trim().split(/\s+/)[0] ?? ""
						if (serverTip === pushed) {
							try {
								await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
								await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
							} catch (e) {
								problems.push(`ACKED PUSH, REF PRESENT, NOT SERVABLE: ${msg(e)}`)
							}
						} else if (serverTip !== "") {
							problems.push(`acked push but server main=${serverTip.slice(0, 12)}`)
						}
					}
					bump(`push ${actorErr === undefined ? "ok" : "err"}`)
				}

				rmSync(dest, { force: true, recursive: true })
				if (problems.length > 0) {
					breaks.push(
						`iteration ${i}, mode ${mode}, delete at +${delay}ms: ${problems.join(" | ")}`,
					)
					break outer
				}
			}
		}

		expect(breaks, JSON.stringify(tally, null, 2)).toEqual([])
		// A run in which the delete always won is not a pass: the soundness checks
		// above only bite on a clone that actually served something.
		expect(tally["clone ok"] ?? 0, JSON.stringify(tally, null, 2)).toBeGreaterThan(0)
	}, 1_800_000)
})

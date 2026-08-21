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
 * Probabilistic. The swept delete-start delays are NOT the source's: it froze
 * one absolute-millisecond table ([0..120]ms) across three actors whose walls
 * differ by multiples, so on any box the delete crowded into each actor's head
 * and never raced its later phases. Each run instead times one un-raced
 * instance of EACH actor (a clone, a repack, a push) and sweeps the delete
 * across FRACTIONS of that actor's own measured wall (0–97%), so the arms land
 * across the whole operation per mode. That calibration is also why 12
 * iterations carry the coverage the source spread over 20 (ruling 5,
 * docs/2026-08-20-test-efficiency.md). The per-round pre-race state is COPIED
 * from one of two templates — encoded tier for the clone/push modes, raw for
 * the repack mode, whose raced actor builds the tier itself; both templates'
 * first copies are proven canonical AND byte-faithful.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps, type GitDeps } from "@/index"
import { parseOid } from "@/oid"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	type GitObjectWithOid,
	loadReachableObjects,
	repackEligibleObjects,
} from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { assertTemplateCopyFaithful, copyTemplateRepo } from "@/testing/template-repo"

const ITERS = 12
const RUNS = 120
const MODES = ["clone", "repack", "push"] as const
type Mode = (typeof MODES)[number]
/** Encoded tier for the clone/push modes; raw for repack mode, whose raced
 * actor builds the tier itself. */
const TEMPLATE: Record<Mode, string> = {
	clone: "race/delrepo/template/encoded",
	push: "race/delrepo/template/encoded",
	repack: "race/delrepo/template/raw",
}
/** Where in the mode's own measured un-raced wall each iteration's delete
 * lands: the cascade can strike any phase, so the sweep spans the whole op. */
const DELAY_FRACTIONS = [
	0, 0.03, 0.08, 0.15, 0.22, 0.3, 0.4, 0.5, 0.6, 0.72, 0.85, 0.97,
] as const

const msg = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""

describe("race — admin.deleteRepo() against a clone / repack / push in flight", () => {
	let db: IsolatedDb
	let server: GitServer
	let deps: GitDeps
	let repack: Repack
	let src = ""
	let client = ""
	let objects: GitObjectWithOid[] = []
	let tip = ""
	const calMs: Record<Mode, number> = { clone: 0, push: 0, repack: 0 }
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

		// Two templates: the per-round pre-race states, built once, copied per
		// round. Encoded for clone/push modes; raw for repack mode.
		await deps.objects.putPack(TEMPLATE.repack, objects)
		await deps.refs.setRef(TEMPLATE.repack, "refs/heads/main", tip)
		await deps.refs.setSymref(TEMPLATE.repack, "HEAD", "refs/heads/main")
		await deps.objects.putPack(TEMPLATE.clone, objects)
		await deps.refs.setRef(TEMPLATE.clone, "refs/heads/main", tip)
		await deps.refs.setSymref(TEMPLATE.clone, "HEAD", "refs/heads/main")
		await repack.repack(TEMPLATE.clone)
		const refsAtTip = [
			{ kind: "direct" as const, name: "refs/heads/main", oid: parseOid(tip) },
			{ kind: "symbolic" as const, name: "HEAD", target: "refs/heads/main" },
		]
		for (const [template, encodings] of [
			[TEMPLATE.repack, { kind: "exact", objects: [] }],
			[TEMPLATE.clone, { kind: "exact", objects: repackEligibleObjects(objects) }],
		] as const) {
			const proof = `${template}/copy-proof`
			await copyTemplateRepo(db.sql, template, proof)
			await assertCanonicalStoreFixture(db.sql, proof, {
				encodings,
				objects,
				refs: refsAtTip,
			})
			await assertTemplateCopyFaithful(db.sql, template, proof)
		}

		// Calibrate each raced actor once, un-raced, timed wall-to-wall: the
		// delete's swept delays are fractions of the actor's OWN wall.
		const calClone = "race/delrepo/cal/clone"
		await copyTemplateRepo(db.sql, TEMPLATE.clone, calClone)
		const calCloneDest = join(mkdtempSync(join(tmpdir(), "delrepo-cal-")), "c")
		scratch.push(calCloneDest)
		let calStart = Date.now()
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			`http://127.0.0.1:${server.port}/${calClone}`,
			calCloneDest,
		])
		calMs.clone = Date.now() - calStart

		const calRepack = "race/delrepo/cal/repack"
		await copyTemplateRepo(db.sql, TEMPLATE.repack, calRepack)
		calStart = Date.now()
		await repack.repack(calRepack)
		calMs.repack = Date.now() - calStart

		const calPush = "race/delrepo/cal/push"
		await copyTemplateRepo(db.sql, TEMPLATE.clone, calPush)
		await spawnGit(["reset", "-q", "--hard", tip], { cwd: client })
		writeFileSync(join(client, "del.txt"), "cal\n")
		await spawnGit(["add", "del.txt"], { cwd: client })
		await spawnGit(["commit", "-q", "-m", "cal"], { cwd: client })
		calStart = Date.now()
		await spawnGit(
			[
				"push",
				"-q",
				`http://127.0.0.1:${server.port}/${calPush}`,
				"HEAD:refs/heads/main",
			],
			{ cwd: client },
		)
		calMs.push = Date.now() - calStart
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
		// Overlap telemetry — recorded, not asserted: whether each round's delete
		// landed inside the raced actor's window ("in"), spilled past it
		// ("straddle"), or fired after the actor finished ("late", a wasted arm).
		const overlaps = { in: 0, late: 0, straddle: 0 }

		outer: for (let i = 0; i < ITERS; i++) {
			for (const mode of MODES) {
				const repo = `race/delrepo/${mode}/${i}`
				const url = `http://127.0.0.1:${server.port}/${repo}`
				// Pre-race state in one copy of the mode's template.
				await copyTemplateRepo(db.sql, TEMPLATE[mode], repo)

				const fraction = DELAY_FRACTIONS[i % DELAY_FRACTIONS.length] as number
				const delay = Math.round(fraction * calMs[mode])
				const dest = join(mkdtempSync(join(tmpdir(), `delrepo-${mode}-`)), "c")
				scratch.push(dest)
				const problems: string[] = []
				let actorErr: unknown
				let repackErr: unknown
				const raceStart = Date.now()
				let actorSettleMs = 0
				let deleteSettleMs = 0
				const timedDelete = () =>
					sleep(delay)
						.then(() => deps.admin.deleteRepo(repo))
						.finally(() => {
							deleteSettleMs = Date.now() - raceStart
						})

				if (mode === "clone") {
					await Promise.allSettled([
						spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
							.catch((e) => {
								actorErr = e
							})
							.finally(() => {
								actorSettleMs = Date.now() - raceStart
							}),
						timedDelete(),
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
						repack
							.repack(repo)
							.catch((e) => {
								repackErr = e
							})
							.finally(() => {
								actorSettleMs = Date.now() - raceStart
							}),
						timedDelete(),
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
						spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: client })
							.catch((e) => {
								actorErr = e
							})
							.finally(() => {
								actorSettleMs = Date.now() - raceStart
							}),
						timedDelete(),
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

				overlaps[
					delay >= actorSettleMs
						? "late"
						: deleteSettleMs <= actorSettleMs
							? "in"
							: "straddle"
				]++
				rmSync(dest, { force: true, recursive: true })
				if (problems.length > 0) {
					breaks.push(
						`iteration ${i}, mode ${mode}, delete at +${delay}ms: ${problems.join(" | ")}`,
					)
					break outer
				}
			}
		}

		console.log(
			`overlap telemetry (recorded, not asserted): delete vs raced actor — in=${overlaps.in} straddle=${overlaps.straddle} late=${overlaps.late}`,
		)
		expect(breaks, JSON.stringify(tally, null, 2)).toEqual([])
		// A run in which the delete always won is not a pass: the soundness checks
		// above only bite on a clone that actually served something.
		expect(tally["clone ok"] ?? 0, JSON.stringify(tally, null, 2)).toBeGreaterThan(0)
	}, 1_800_000)
})

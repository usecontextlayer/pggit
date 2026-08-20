/**
 * RACE: a repack committing MID-CLONE / MID-FETCH — the delta-pack design's
 * central safety claim (D1: "benign BY CONSTRUCTION, the served set comes from
 * the canonical inventory and encodings are only additive"). This tries to
 * falsify it.
 *
 * Why a LARGE repo: `buildPack` reads content in batches of PACK_BATCH=1000 and
 * joins `git_pack_encoding` fresh in EVERY batch. Only a repo whose served set
 * spans many batches gives a concurrent repack a window to change the tier
 * between one batch's read and the next — so object A of the same pack is
 * emitted raw-deflated while object B, read 200ms later, is emitted as a
 * REF_DELTA against an object that already went out in whole form.
 *
 * Modes (all three run):
 *   clone      — full clone of a NEVER-repacked repo, repack fired mid-flight
 *   half       — repo partly repacked, more history pushed, repack mid-clone
 *   fetch      — real INCREMENTAL fetch (client sends haves) racing a repack
 *
 * Verdict is git's: clone/fetch exit status, `git fsck --strict`, and the
 * client's object set vs the source repo's.
 *
 * Converted from `breakage/race--clone-vs-repack.ts` (`--iters=30 --runs=1200
 * --mode=all`). Probabilistic: the iteration count, the mode sweep and the swept
 * repack-start delays are frozen exactly as the script ran them. The fixture size
 * is load-bearing — the bug needs a served set spanning many 1000-object batches.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import type { PackInputObject } from "@/pack/write-pack"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { allObjectOids, loadReachableObjects } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 30
const RUNS = 1200
const MODES = ["clone", "half", "fetch"] as const

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe("race — repack committing mid-clone / mid-fetch", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let srcBase = ""
	let src = ""
	let baseObjects: PackInputObject[] = []
	let fullObjects: PackInputObject[] = []
	let baseRefs: string[] = []
	let fullRefs: string[] = []
	let srcOidsFull: string[] = []
	let head = ""
	const scratch: string[] = []

	beforeAll(async () => {
		// Two fast-import builds of the SAME deterministic history: `full` strictly
		// extends `base` (same pinned identity + clock ⇒ the shared prefix is
		// byte-identical), which is what makes the incremental mode a real fetch with
		// haves rather than a disjoint second repo.
		srcBase = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS + 40 })
		scratch.push(srcBase, src)
		baseObjects = await loadReachableObjects(srcBase, ["--all"])
		baseRefs = (await spawnGit(["show-ref"], { cwd: srcBase })).stdout.trim().split("\n")
		head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()
		fullObjects = await loadReachableObjects(src, ["--all"])
		fullRefs = (await spawnGit(["show-ref"], { cwd: src })).stdout.trim().split("\n")
		srcOidsFull = await allObjectOids(src)
		const baseTip = (
			await spawnGit(["rev-parse", "HEAD"], { cwd: srcBase })
		).stdout.trim()
		const ancestor = await spawnGit(["merge-base", "--is-ancestor", baseTip, "HEAD"], {
			cwd: src,
		}).then(
			() => true,
			() => false,
		)
		if (!ancestor)
			throw new Error("fixture: base history is not a prefix of full history")

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		store = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		repack = createRepack(db.sql)
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("a clone/fetch raced by a repack lands complete and fsck-clean", async () => {
		const breaks: string[] = []
		const setRefs = async (repo: string, lines: string[]): Promise<void> => {
			for (const line of lines) {
				const [oid, name] = line.split(" ")
				if (oid && name) await refs.setRef(repo, name, oid)
			}
			await refs.setSymref(repo, "HEAD", head)
		}

		outer: for (let i = 0; i < ITERS; i++) {
			// Sweep the repack's start across the whole clone, so it commits between
			// different pairs of the serve path's batch reads.
			const delay = [0, 5, 20, 50, 90, 150, 220, 320, 450, 600, 800, 1100][
				i % 12
			] as number

			for (const mode of MODES) {
				const repo = `race/clone-repack/${mode}/${i}`
				const dest = join(mkdtempSync(join(tmpdir(), `race-cr-${mode}-`)), "c")
				scratch.push(dest)
				const url = `http://127.0.0.1:${server.port}/${repo}`
				const problems: string[] = []

				try {
					if (mode === "clone") {
						// Never repacked: every object serves raw until the racing pass lands.
						await store.putPack(repo, fullObjects)
						await setRefs(repo, fullRefs)
						const settled = await Promise.allSettled([
							spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest]),
							sleep(delay).then(() => repack.repack(repo)),
						])
						for (const s of settled) {
							if (s.status === "rejected") problems.push(`${s.reason}`)
						}
					} else if (mode === "half") {
						// Tier already covers the OLD history; the new history is pending, so
						// the racing pass adds encodings for objects the clone is mid-read on.
						await store.putPack(repo, baseObjects)
						await setRefs(repo, baseRefs)
						await repack.repack(repo)
						await store.putPack(repo, fullObjects)
						await setRefs(repo, fullRefs)
						const settled = await Promise.allSettled([
							spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest]),
							sleep(delay).then(() => repack.repack(repo)),
						])
						for (const s of settled) {
							if (s.status === "rejected") problems.push(`${s.reason}`)
						}
					} else {
						// A real incremental fetch: clone the OLD tip first (so the client
						// sends haves), advance the server, then race fetch against repack.
						await store.putPack(repo, baseObjects)
						await setRefs(repo, baseRefs)
						await repack.repack(repo)
						await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
						await store.putPack(repo, fullObjects)
						await setRefs(repo, fullRefs)
						const settled = await Promise.allSettled([
							spawnGit(["-c", "protocol.version=2", "fetch", "-q", "origin"], {
								cwd: dest,
							}),
							sleep(Math.min(delay, 60)).then(() => repack.repack(repo)),
						])
						for (const s of settled) {
							if (s.status === "rejected") problems.push(`${s.reason}`)
						}
						if (problems.length === 0) {
							await spawnGit(["merge", "-q", "--ff-only", "origin/main"], { cwd: dest })
						}
					}

					if (problems.length === 0) {
						await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
						const got = await allObjectOids(dest)
						if (got.join(",") !== srcOidsFull.join(",")) {
							problems.push(
								`object set mismatch: client ${got.length} vs source ${srcOidsFull.length}`,
							)
						}
					}
				} catch (err) {
					problems.push(err instanceof Error ? err.message : String(err))
				}

				if (problems.length > 0) {
					breaks.push(
						`iteration ${i}, mode ${mode}, repack at +${delay}ms: ${problems.join(" | ")}`,
					)
					break outer
				}
				rmSync(dest, { force: true, recursive: true })
			}
		}

		expect(breaks).toEqual([])
	}, 3_600_000)
})

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
 * Each iteration's pre-race state is now assembled by COPYING a template repo's
 * rows instead of re-seeding it through `putPack`, because that fixture assembly —
 * not the raced operation — was 28% of the whole gate's wall time
 * (docs/2026-08-20-test-efficiency.md, lever 1(a)); the states themselves are
 * unchanged, and each template's first copy is proven against the canonical
 * object/ref identity its seeding established.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	branchAndTagRefsOf,
	type CanonicalStoreFixture,
	type CanonicalStoreRef,
	loadReachableObjects,
	repackEligibleObjects,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { copyTemplateRepo } from "@/testing/template-repo"

const ITERS = 30
const RUNS = 1200
const MODES = ["clone", "half", "fetch"] as const

/** The pre-race server state each mode races against — seeded ONCE, copied per
 * iteration. `half` and `fetch` race the SAME server state (the tier covers the
 * old history while the new history is still pending) and differ only in what the
 * client already holds, so they share one template. */
const TEMPLATE = {
	clone: "race/clone-repack/template/full-raw",
	fetch: "race/clone-repack/template/half",
	half: "race/clone-repack/template/half",
} as const

describe("race — repack committing mid-clone / mid-fetch", () => {
	let db: IsolatedDb
	let server: GitServer
	let repack: Repack
	let srcOidsFull: string[] = []
	/** A client cloned from the `half` template while it was still at the BASE
	 * state — `fetch` mode's un-raced setup, deduplicated across iterations. */
	let fetchClientBase = ""
	const scratch: string[] = []

	beforeAll(async () => {
		// Two fast-import builds of the SAME deterministic history: `full` strictly
		// extends `base` (same pinned identity + clock ⇒ the shared prefix is
		// byte-identical), which is what makes the incremental mode a real fetch with
		// haves rather than a disjoint second repo.
		const srcBase = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		const src = await createAppendOnlyRepo({ docs: 4, runs: RUNS + 40 })
		scratch.push(srcBase, src)
		const baseObjects = await loadReachableObjects(srcBase, ["--all"])
		const baseRefs = await branchAndTagRefsOf(srcBase)
		const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()
		const fullObjects = await loadReachableObjects(src, ["--all"])
		const fullRefs = await branchAndTagRefsOf(src)
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

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const store = fixture.deps.objects
		const refs = fixture.deps.refs
		repack = createRepack(db.sql)

		const setRefs = async (
			repo: string,
			entries: { name: string; oid: string }[],
		): Promise<void> => {
			for (const entry of entries) {
				await refs.setRef(repo, entry.name, entry.oid)
			}
			await refs.setSymref(repo, "HEAD", head)
		}

		// Never repacked: every object serves raw until a racing pass lands.
		await store.putPack(TEMPLATE.clone, fullObjects)
		await setRefs(TEMPLATE.clone, fullRefs)

		// Tier already covers the OLD history; the new history is pending, so a racing
		// pass adds encodings for objects a read is mid-flight on.
		await store.putPack(TEMPLATE.half, baseObjects)
		await setRefs(TEMPLATE.half, baseRefs)
		await repack.repack(TEMPLATE.half)
		// `fetch` mode's client, cloned from the template WHILE it is still at base —
		// that is what makes the per-iteration fetch incremental (the client sends
		// haves). Only this un-raced setup clone is deduplicated; the raced fetch is a
		// fresh, fully real one every iteration.
		fetchClientBase = join(mkdtempSync(join(tmpdir(), "race-cr-fetch-base-")), "c")
		scratch.push(fetchClientBase)
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			repoUrl(server, TEMPLATE.half),
			fetchClientBase,
		])
		// The DELTA only: a real second push carries the history that arrived, not
		// every base object re-sent to be conflict-skipped.
		const baseOids = new Set(baseObjects.map((object) => object.oid))
		await store.putPack(
			TEMPLATE.half,
			fullObjects.filter((object) => !baseOids.has(object.oid)),
		)
		await setRefs(TEMPLATE.half, fullRefs)

		// The anchored identity proof (docs/2026-08-20-test-efficiency.md): one copy of
		// each template, checked against the same canonical object/ref identity its
		// seeding established, so the copy path can never drift from the ingest path
		// silently. Both templates hold the FULL object set at the FULL refs; they
		// differ only in how much of the encoding tier is populated.
		const refsAtFull: CanonicalStoreRef[] = [
			...fullRefs.map(({ name, oid }) => ({ kind: "direct" as const, name, oid })),
			{ kind: "symbolic", name: "HEAD", target: head },
		]
		const identities: readonly (readonly [string, CanonicalStoreFixture])[] = [
			[
				TEMPLATE.clone,
				{
					// EMPTY, not unchecked: "never repacked, so every object serves raw" is
					// the whole premise of `clone` mode, and it is what the copy must carry.
					encodings: { kind: "exact", objects: [] },
					objects: fullObjects,
					refs: refsAtFull,
				},
			],
			[
				TEMPLATE.half,
				{
					// The repack ran over the base state ALONE and repack only ever adds
					// rows, so exactly the base objects carry an encoding here.
					encodings: { kind: "exact", objects: repackEligibleObjects(baseObjects) },
					objects: fullObjects,
					refs: refsAtFull,
				},
			],
		]
		for (const [template, expected] of identities) {
			const proof = `${template}/copy-proof`
			await copyTemplateRepo(db.sql, template, proof)
			await assertCanonicalStoreFixture(db.sql, proof, expected)
		}
	}, 900_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("a clone/fetch raced by a repack lands complete and fsck-clean", async () => {
		const breaks: string[] = []

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
				const url = repoUrl(server, repo)
				const problems: string[] = []

				try {
					// Objects, derived rows, encodings and refs all land in one copy — the
					// template already carries the refs this mode's pre-race state needs.
					await copyTemplateRepo(db.sql, TEMPLATE[mode], repo)

					if (mode === "fetch") {
						// A real incremental fetch: the client holds the OLD tip (so it sends
						// haves) while the server is already advanced; race it against a repack.
						cpSync(fetchClientBase, dest, { recursive: true })
						await spawnGit(["remote", "set-url", "origin", url], { cwd: dest })
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
					} else {
						const settled = await Promise.allSettled([
							spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest]),
							sleep(delay).then(() => repack.repack(repo)),
						])
						for (const s of settled) {
							if (s.status === "rejected") problems.push(`${s.reason}`)
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

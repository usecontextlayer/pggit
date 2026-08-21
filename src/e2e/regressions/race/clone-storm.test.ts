/**
 * RACE: N concurrent `git clone`s of one repo while repack passes keep landing —
 * correctness AND throughput under the load the delta tier was built for.
 *
 * This is the shape a production cold-start actually has: several bridges pulling
 * the same workspace repo at once while the drain's repack pass commits under
 * them. Every clone reads `git_pack_encoding` fresh per 1000-object batch, so
 * different clones (and different batches of the SAME clone) see different tiers.
 * The design says that is benign because encodings are additive; this drives it
 * hard enough to find out, and records the wall-clock spread while it does.
 *
 * Verdict: every clone must exit 0, pass `git fsck --strict`, and hold exactly
 * the source repo's object set. Timings are reported, not asserted — they ride on
 * the assertion's message so a red round prints the spread that produced it.
 *
 * Converted from `breakage/race--clone-storm.ts` (`--iters=10 --runs=400
 * --clones=8 --repacks=3`). The race is probabilistic: the iteration count IS
 * the test, so the loop, its counts and its start staggers are frozen exactly
 * as the script ran them — there is no swept delay dimension here to calibrate
 * or trim; the storm's near-simultaneous starts are the shape. Only the
 * per-round seeding changed: the pre-race state (full history, no tier — the
 * raced repacks build it) is COPIED from a template proven canonical AND
 * byte-faithful on its first copy.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseOid } from "@/oid"
import type { GitServer } from "@/server"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	type GitObjectWithOid,
	loadReachableObjects,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { assertTemplateCopyFaithful, copyTemplateRepo } from "@/testing/template-repo"

const ITERS = 10
const RUNS = 400
const CLONES = 8
const REPACKS = 3
const TEMPLATE = "race/storm/template"

const msg = (e: unknown) =>
	(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""

describe("race — clone storm: concurrent clones vs landing repack passes", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let src = ""
	let objects: GitObjectWithOid[] = []
	let srcOids: string[] = []
	let tip = ""
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		srcOids = await allObjectOids(src)
		tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		repack = createRepack(db.sql)

		// Template: full history, no tier — the raced repacks build it per round.
		await store.putPack(TEMPLATE, objects)
		await refs.setRef(TEMPLATE, "refs/heads/main", tip)
		await refs.setSymref(TEMPLATE, "HEAD", "refs/heads/main")
		const proof = `${TEMPLATE}/copy-proof`
		await copyTemplateRepo(db.sql, TEMPLATE, proof)
		await assertCanonicalStoreFixture(db.sql, proof, {
			encodings: { kind: "exact", objects: [] },
			objects,
			refs: [
				{ kind: "direct", name: "refs/heads/main", oid: parseOid(tip) },
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			],
		})
		await assertTemplateCopyFaithful(db.sql, TEMPLATE, proof)
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("every clone of every round is sound: exit 0, fsck-clean, exact object set", async () => {
		const breaks: string[] = []
		const timings: string[] = []
		// Overlap telemetry — recorded, not asserted: how many of the round's
		// repack passes ran while at least one clone was still being served.
		const overlaps: Record<string, number> = {}

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const repo = `race/storm/${i}`
			const url = repoUrl(server, repo)
			// Pre-race state in one copy: full history, no tier yet.
			await copyTemplateRepo(db.sql, TEMPLATE, repo)

			const dests = Array.from({ length: CLONES }, (_, k) => {
				const d = join(mkdtempSync(join(tmpdir(), `storm-${k}-`)), "c")
				scratch.push(d)
				return d
			})
			const t0 = Date.now()
			const cloneTimes: number[] = []
			let lastCloneSettleMs = 0
			const repackWindows: { end: number; start: number }[] = []
			const settled = await Promise.allSettled([
				...dests.map(async (d, k) => {
					await sleep(k * 12)
					const s = Date.now()
					await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, d])
					cloneTimes.push(Date.now() - s)
					lastCloneSettleMs = Math.max(lastCloneSettleMs, Date.now() - t0)
				}),
				...Array.from({ length: REPACKS }, (_, k) =>
					sleep(k * 90)
						.then(() => repack.repack(repo))
						.finally(() => {
							repackWindows.push({ end: Date.now() - t0, start: k * 90 })
						}),
				),
			])
			const wall = Date.now() - t0
			const repacksInWindow = repackWindows.filter(
				(w) => w.start < lastCloneSettleMs,
			).length
			overlaps[`repacksInCloneWindow=${repacksInWindow}`] =
				(overlaps[`repacksInCloneWindow=${repacksInWindow}`] ?? 0) + 1
			const problems = settled
				.filter((s) => s.status === "rejected")
				.map((s) => msg((s as PromiseRejectedResult).reason))

			if (problems.length === 0) {
				for (const d of dests) {
					try {
						await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: d })
						const got = await allObjectOids(d)
						if (got.join(",") !== srcOids.join(",")) {
							problems.push(
								`object set mismatch in ${d}: ${got.length}/${srcOids.length}`,
							)
						}
					} catch (e) {
						problems.push(`fsck: ${msg(e)}`)
					}
				}
			}

			cloneTimes.sort((a, b) => a - b)
			timings.push(
				`iter ${i} wall=${wall}ms clones=${cloneTimes.length}/${CLONES} ` +
					`min=${cloneTimes[0] ?? "-"}ms med=${cloneTimes[cloneTimes.length >> 1] ?? "-"}ms ` +
					`max=${cloneTimes[cloneTimes.length - 1] ?? "-"}ms`,
			)
			for (const d of dests) rmSync(d, { force: true, recursive: true })
			if (problems.length > 0) {
				breaks.push(`iteration ${i}: ${problems.join(" | ")}`)
			}
		}

		console.log(`overlap telemetry (recorded, not asserted): ${JSON.stringify(overlaps)}`)
		expect(
			breaks,
			`${ITERS} rounds x ${CLONES} clones vs ${REPACKS} repack passes\n${timings.join("\n")}`,
		).toEqual([])
	}, 900_000)
})

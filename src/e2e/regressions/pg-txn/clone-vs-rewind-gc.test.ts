/**
 * Postgres transaction regression — a clone raced by a ref rewind + gc(0).
 *
 * HUNT: a clone's closure computation is NOT under one snapshot — the reachability
 * walk's batched derived-row, tree-content, and blob-presence reads, followed by
 * the content/encoding reads, are separate statements on the pool. So
 * race a ref REWIND plus `gc(graceSeconds: 0)` into the middle of a clone of the
 * old tip and try to falsify the claim:
 *
 *   the client always gets either a COMPLETE pack or a CLEAN error (an in-band
 *   ERR / an HTTP failure git reports sensibly) — never a corrupt pack, never an
 *   fsck-dirty clone, never a silently short one.
 *
 * FAULT INJECTED: none beyond legitimate concurrency — a `setRef` rewind through
 * the store's own RefStore (the shape a force-push era leaves behind) and a
 * `gc(0)` pass, both fired at a randomized offset into an in-flight clone.
 *
 * VERDICT is git's:
 *   - clone exited 0  → `fsck --strict` must be clean AND `rev-list --objects
 *     --all` must enumerate the whole thing (a short pack fails one of these)
 *   - clone failed    → the message must be a transport/refusal ("hung up",
 *     "HTTP 500", "not our ref", "upload-pack"), not a corruption diagnostic
 *     ("did not receive expected object", "pack is corrupt", "index-pack failed",
 *     "unable to read", "bad object")
 *
 * The fixture scale is 1200 append-only runs over a 12-iteration loop. Fractional delays avoid absolute milliseconds, which tie
 * the race to one machine's serve speed — measured here, the want-presence check
 * lands seconds into the serve, so a fixed sub-second spread can lose all 12
 * races and starve the anti-vacuousness floor below. Each run instead times one
 * un-raced calibration clone and sweeps the rewind across FRACTIONS of that
 * measured wall (2%–150%): the early arms keep hunting the mid-serve window, and
 * the tail arms land after the serve so complete clones stay reachable on any box.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type GcResult } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit } from "@/testing/spawn-git"

const ITERS = 12
const RUNS = 1200

/** Diagnostics that mean the SERVER handed git something it could not use. */
const CORRUPTION = [
	"did not receive expected object",
	"pack is corrupt",
	"index-pack failed",
	"unable to read",
	"bad object",
	"object of unexpected type",
	"early eof",
	"pack has bad object",
	"inflate",
]
/** Diagnostics that are a clean refusal / transport failure. */
const CLEAN = [
	"hung up",
	"http 500",
	"the requested url returned error",
	"not our ref",
	"upload-pack",
	"remote error",
	"rpc failed",
]

type Verdict =
	| "complete"
	| "broken-clone"
	| "corrupt-pack"
	| "clean-refusal"
	| "unclassified"
type RaceOutcome = {
	iter: number
	delayMs: number
	gc: GcResult
	verdict: Verdict
	detail: string
}

describe("regressions/pg-txn — clone vs. ref rewind + gc(0)", () => {
	let db: IsolatedDb
	let admin: Sql
	let appSql: Sql
	let server: GitServer
	let src = ""
	let root = ""
	const outcomes: RaceOutcome[] = []

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		root = mkdtempSync(join(tmpdir(), "pggit-txn-clonerace-"))
		src = await createAppendOnlyRepo({ runs: RUNS })
		admin = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 3,
			onnotice: () => {},
		})
		appSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 8,
			onnotice: () => {},
		})
		server = await serveOnPort(createGitApp(createGitDeps(appSql)), 0)

		const commits = await commitsOldestFirst(src, "main")
		const tip = commits[commits.length - 1]
		const early = commits[3]
		if (!tip || !early) throw new Error("fixture too short to rewind")

		// Calibrate: one un-raced clone of the same fixture, timed wall-to-wall.
		// The raced delays are fractions of this measurement, so the sweep tracks
		// the box's actual serve speed instead of a frozen machine's.
		const calRepo = "txn/clonerace-cal"
		const calPush = await attemptGit(
			[
				"push",
				"-q",
				`http://127.0.0.1:${server.port}/${calRepo}`,
				`${tip}:refs/heads/main`,
			],
			src,
		)
		if (!calPush.ok) throw new Error(`calibration push failed: ${calPush.stderr}`)
		const calDest = join(root, "c-cal")
		const calStart = Date.now()
		const calClone = await attemptGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			"--mirror",
			`http://127.0.0.1:${server.port}/${calRepo}`,
			calDest,
		])
		const serveMs = Date.now() - calStart
		if (!calClone.ok) throw new Error(`calibration clone failed: ${calClone.stderr}`)
		rmSync(calDest, { force: true, recursive: true })

		const DELAY_FRACTIONS = [
			0.02, 0.08, 0.15, 0.25, 0.35, 0.45, 0.55, 0.7, 0.85, 1.0, 1.2, 1.5,
		]
		for (let i = 0; i < ITERS; i++) {
			const repo = `txn/clonerace-${i}`
			const url = `http://127.0.0.1:${server.port}/${repo}`
			const push = await attemptGit(["push", "-q", url, `${tip}:refs/heads/main`], src)
			if (!push.ok) throw new Error(`seed push failed: ${push.stderr}`)
			// Half the runs carry an encoding tier, so the delta path is raced too.
			if (i % 2 === 1) await createRepack(admin).repack(repo)
			const refs = createRefStore(admin)
			const gc = createGc(admin)

			const dest = join(root, `c-${i}`)
			const fraction = DELAY_FRACTIONS[i]
			if (fraction === undefined) throw new Error(`no delay fraction for iter ${i}`)
			const delayMs = Math.max(10, Math.round(fraction * serveMs))
			const clone = attemptGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--mirror",
				url,
				dest,
			])
			await sleep(delayMs)
			// The race: rewind the ref, then reclaim everything past it with zero grace.
			await refs.setRef(repo, "refs/heads/main", early)
			const gcResult = await gc.gc(repo, { graceSeconds: 0, maintain: false })
			const res = await clone

			let verdict: Verdict
			let detail = ""
			if (res.ok) {
				const fsck = await attemptGit(["fsck", "--strict", "--no-dangling"], dest)
				const revList = await attemptGit(["rev-list", "--objects", "--all"], dest)
				if (!fsck.ok || !revList.ok) {
					verdict = "broken-clone"
					detail = `clone exited 0 but ${
						fsck.ok ? "rev-list FAILED" : "fsck --strict FAILED"
					}: ${(fsck.ok ? revList.stderr : fsck.stderr).trim().slice(0, 200)}`
				} else {
					verdict = "complete"
					detail = `${revList.stdout.split("\n").filter(Boolean).length} objects, fsck clean`
				}
			} else {
				const msg = res.stderr.toLowerCase()
				const corrupt = CORRUPTION.find((k) => msg.includes(k))
				const cleanKey = CLEAN.find((k) => msg.includes(k))
				const tail = res.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 260)
				if (corrupt) {
					verdict = "corrupt-pack"
					detail = `clone failed with a CORRUPTION diagnostic "${corrupt}" — ${tail}`
				} else if (cleanKey) {
					verdict = "clean-refusal"
					detail = `clean refusal (${cleanKey})`
				} else {
					verdict = "unclassified"
					detail = `clone failed with an unclassified message — ${tail}`
				}
			}
			outcomes.push({ delayMs, detail, gc: gcResult, iter: i, verdict })
			rmSync(dest, { force: true, recursive: true })
		}
	}, 1_800_000)

	afterAll(async () => {
		await server?.close()
		await appSql?.end()
		await admin?.end()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
		if (src) rmSync(src, { force: true, recursive: true })
	})

	const describeOf = (o: RaceOutcome) =>
		`iter ${o.iter} (delay ${o.delayMs}ms): ${o.detail}`

	it("ran every race and reclaimed something on the way", () => {
		expect(outcomes).toHaveLength(ITERS)
		expect(outcomes.some((o) => o.gc.deletedObjects > 0)).toBe(true)
		// The clone side needs the same floor the GC side already has: every verdict
		// below fails only on corruption, so a server that refused all 12 raced
		// clones passes them all while serving nothing.
		expect(
			outcomes.filter((o) => o.verdict === "complete").length,
			outcomes.map(describeOf).join("\n"),
		).toBeGreaterThan(0)
	})

	it("never serves a pack git calls corrupt", () => {
		expect(outcomes.filter((o) => o.verdict === "corrupt-pack").map(describeOf)).toEqual(
			[],
		)
	})

	it("a clone that exits 0 is fsck --strict clean and complete", () => {
		expect(outcomes.filter((o) => o.verdict === "broken-clone").map(describeOf)).toEqual(
			[],
		)
	})

	it("every failed clone failed with a clean transport/refusal diagnostic", () => {
		expect(outcomes.filter((o) => o.verdict === "unclassified").map(describeOf)).toEqual(
			[],
		)
	})
})

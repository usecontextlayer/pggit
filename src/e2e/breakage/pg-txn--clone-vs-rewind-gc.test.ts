/**
 * BREAKAGE (pg-txn) — a clone raced by a ref rewind + gc(0).
 * Converted from `breakage/pg-txn--clone-vs-rewind-gc.ts`; its rationale verbatim:
 *
 * HUNT: a clone's closure computation is NOT under one snapshot — the recursive
 * edge CTE, the tree-content reads, the blob-presence probes, and the per-batch
 * content/encoding reads are all separate statements on different connections. So
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
 * The source script exits non-zero when the claim is falsified; the assertions
 * below encode the CORRECT contract, so a reproduction shows up as a red test.
 * The fixture scale (1200 append-only runs) and the 12-iteration randomized-delay
 * loop are the source's — the race lives in that timing spread.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type GcResult } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

describe("breakage/pg-txn — clone vs. ref rewind + gc(0)", () => {
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

		const commits = (
			await spawnGit(["rev-list", "--reverse", "main"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		const tip = commits[commits.length - 1]
		const early = commits[3]
		if (!tip || !early) throw new Error("fixture too short to rewind")

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
			const delayMs = 40 + ((i * 97) % 900)
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

/**
 * Lifecycle breakage — repo deletion and recreation, five cycles, with components
 * built FRESH each cycle (so the stale-resolver defect covered by
 * `lifecycle--repo-recreate-silent-noop-repack` is out of the way and only
 * data-level resurrection is under test).
 *
 * Asks: does anything from a previous incarnation survive the cascade and attach
 * itself to the new repo? Same wire name, same object OIDs, new `repos.id` — an
 * encoding or ref row that outlived its repo would either FK-fail on
 * write or serve stale bytes. Each cycle ends with a clone compared byte-for-byte
 * against a file:// reference remote holding the same visible history.
 *
 * Full scale: 90 seed commits, five delete/recreate cycles.
 *
 * Originated as breakage probe `lifecycle--repo-recreate-cycles.ts` (exit 1 when
 * a cycle resurrected state from a previous incarnation); fixed.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack, type RepackResult } from "@/store/repack"
import { buildLifecycleSource, commitsOldestFirst } from "@/testing/append-only-repo"
import {
	compareMirrorClones,
	type MirrorComparison,
	requiredAt,
} from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { captureTestResult, type TestResult } from "@/testing/test-result"

const REPO = "workspace/slate/cycled"
const CYCLES = 5

type CycleResult = TestResult<MirrorComparison> & {
	cycle: number
	first: RepackResult
	converged: RepackResult
}

describe("lifecycle breakage — repo recreate cycles", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const cycles: CycleResult[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-cycles-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildLifecycleSource(src, 90)
		const commits = await commitsOldestFirst(src, "main")
		const tip = requiredAt(commits, commits.length - 1, "main commit history")
		const mid = requiredAt(commits, 45, "main commit history")

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
		await spawnGit(["push", "-q", ref, `${tip}:refs/heads/main`], { cwd: src })

		const deps = createGitDeps(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		for (let c = 0; c < CYCLES; c++) {
			// FRESH components each cycle — the documented-safe usage
			const repack = createRepack(db.sql)
			const gc = createGc(db.sql)
			const refs = createRefStore(db.sql)

			await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
			const first = await repack.repack(REPO)
			// churn: rewind, gc, advance again, repack
			await refs.setRef(REPO, "refs/heads/main", mid)
			await gc.gc(REPO, { batchLimit: 1_000_000, graceSeconds: 0 })
			await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
			await repack.repack(REPO)
			const converged = await repack.repack(REPO)

			const a = dir(`pg-${c}`)
			const b = dir(`rf-${c}`)
			const comparison = await captureTestResult(() =>
				compareMirrorClones({ dest: a, url }, { dest: b, url: `file://${ref}` }),
			)
			cycles.push({ ...comparison, converged, cycle: c, first })
			if (comparison.kind === "failed") {
				// No deleteRepo here: the source leaves a failed cycle's incarnation in
				// place, so the next cycle runs against it rather than a fresh repo.
				continue
			}
			rmSync(a, { force: true, recursive: true })
			rmSync(b, { force: true, recursive: true })

			// tear the whole repo down and let the next cycle recreate it
			await deps.admin.deleteRepo(REPO)
		}
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("encodes a freshly recreated repo from scratch on every cycle", () => {
		expect(
			cycles
				.filter((c) => c.first.wholes + c.first.deltas === 0)
				.map((c) => `cycle ${c.cycle}: ${JSON.stringify(c.first)}`),
		).toEqual([])
	})

	it("converges the repack on every cycle", () => {
		expect(
			cycles
				.filter((c) => c.converged.deltas !== 0 || c.converged.wholes !== 0)
				.map((c) => `cycle ${c.cycle}: ${JSON.stringify(c.converged)}`),
		).toEqual([])
	})

	it("serves a clonable repo on every cycle", () => {
		expect(
			cycles.flatMap((c) =>
				c.kind === "failed" ? [`cycle ${c.cycle}: ${String(c.error).slice(0, 250)}`] : [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			cycles.flatMap((c) =>
				c.kind === "succeeded" &&
				(c.value.objects.onlyServed.length > 0 || c.value.objects.onlyOracle.length > 0)
					? [
							`cycle ${c.cycle}: onlyServed=${c.value.objects.onlyServed.length} onlyOracle=${c.value.objects.onlyOracle.length}`,
						]
					: [],
			),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(
			cycles.flatMap((c) =>
				c.kind === "succeeded" ? [{ cycle: c.cycle, refs: c.value.served.refs }] : [],
			),
		).toEqual(
			cycles.flatMap((c) =>
				c.kind === "succeeded" ? [{ cycle: c.cycle, refs: c.value.oracle.refs }] : [],
			),
		)
	})

	it("serves byte-identical objects to the oracle", () => {
		expect(
			cycles.flatMap((c) =>
				c.kind === "succeeded" && c.value.served.digest !== c.value.oracle.digest
					? [`cycle ${c.cycle}`]
					: [],
			),
		).toEqual([])
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			cycles.flatMap((c) =>
				c.kind === "succeeded" && c.value.served.fsck.length > 0
					? [`cycle ${c.cycle}: ${c.value.served.fsck}`]
					: [],
			),
		).toEqual([])
	})
})

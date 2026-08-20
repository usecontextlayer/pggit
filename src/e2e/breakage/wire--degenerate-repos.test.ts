/**
 * WIRE — degenerate repository states through the repack + deltified serve path:
 * the shapes where "there is nothing to delta" must still be exactly right.
 * (Converted from `breakage/wire--degenerate-repos.ts`.)
 *
 *   1. A repo name never written: clone must behave as it did before the tier.
 *   2. An empty repo (HEAD unborn, refs pushed then… nothing) — repack over it.
 *   3. A single orphan commit (one commit, no parents) — repack, clone.
 *   4. Repack run TWICE (the frozen-policy claim: the second pass writes nothing
 *      and cannot change what a client sees).
 *   5. Repack run BEFORE anything is pushed, then a push, then a clone (the
 *      mixed encoded/unencoded state).
 *   6. A tags-only fetch (`refs/tags/*`) against a repacked repo.
 *   7. A `want` the repo does not have — the in-band ERR path, after repack.
 *
 * Every assertion encodes the CORRECT outcome, so a red test IS the bug.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import {
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { attemptGit, GitCommandError, spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const REPO = "workspace/probe/solo"
const NEVER_REPO = "workspace/probe/never"

type Counts = { wholes: number; deltas: number }

describe("wire — degenerate repository states under the encoding tier", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	let unknownRepack: Counts
	let unknownCloneRefs = ""
	let repackBeforePush: Counts
	let soloRepack: Counts
	let secondRepack: Counts
	let soloClone: TestResult<string>
	let soloSrcTip = ""
	let mixedClone: TestResult<string>
	let mixedSrcTip = ""
	let tagsFetch: TestResult<string>
	let tagsWant = ""
	let missingWantOutcome = ""

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const base = `http://127.0.0.1:${server.port}`
		const repack = createRepack(db.sql)

		// 1. A repo name never written.
		unknownRepack = await repack.repack(NEVER_REPO)
		const neverDest = join(mk("empty"), "c")
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			`${base}/${NEVER_REPO}`,
			neverDest,
		])
		// `show-ref` exits 1 on a repo with no refs — that is the empty case, not a fault.
		try {
			unknownCloneRefs = (await spawnGit(["show-ref"], { cwd: neverDest })).stdout.trim()
		} catch (error) {
			if (!(error instanceof GitCommandError) || error.code !== 1) throw error
		}

		// 2/3 + 5 (first half). A single orphan commit; repack BEFORE the push has
		// nothing to encode.
		const src = mk("src")
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "only.txt"), "one\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "solo"], { cwd: src })
		const url = `${base}/${REPO}`
		repackBeforePush = await repack.repack(REPO)

		await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], { cwd: src })
		soloRepack = await repack.repack(REPO)
		// 4. The second pass must be a no-op.
		secondRepack = await repack.repack(REPO)

		const solo = join(mk("solo"), "c")
		soloClone = await captureTestResult(async () => {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, solo])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: solo })
			return (await spawnGit(["rev-parse", "HEAD"], { cwd: solo })).stdout.trim()
		})
		soloSrcTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		// 5 (second half). Push MORE without repacking: a mixed encoded/unencoded state.
		writeFileSync(join(src, "only.txt"), "two\n")
		writeFileSync(join(src, "extra.txt"), "extra\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "second"], { cwd: src })
		await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], { cwd: src })

		const mixed = join(mk("mixed"), "c")
		mixedClone = await captureTestResult(async () => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"-c",
				"transfer.fsckobjects=true",
				"clone",
				"-q",
				url,
				mixed,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: mixed })
			return (await spawnGit(["rev-parse", "HEAD"], { cwd: mixed })).stdout.trim()
		})
		mixedSrcTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		// 6. Tags-only fetch against a repacked repo.
		await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: src })
		await spawnGit(["push", "-q", url, "refs/tags/v1:refs/tags/v1"], { cwd: src })
		await repack.repack(REPO)
		const tagsOnly = join(mk("tags"), "c")
		await spawnGit(["init", "-q", tagsOnly])
		tagsFetch = await captureTestResult(async () => {
			await spawnGit(
				[
					"-c",
					"protocol.version=2",
					"-c",
					"transfer.fsckobjects=true",
					"fetch",
					"-q",
					url,
					"refs/tags/*:refs/tags/*",
				],
				{ cwd: tagsOnly },
			)
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: tagsOnly })
			return (
				await spawnGit(["rev-parse", "refs/tags/v1"], { cwd: tagsOnly })
			).stdout.trim()
		})
		tagsWant = (await spawnGit(["rev-parse", "refs/tags/v1"], { cwd: src })).stdout.trim()

		// 7. A want the repo does not have — must be a clean in-band ERR, not a 500.
		const missing = `${"0".repeat(39)}1`
		const errDest = join(mk("err"), "c")
		await spawnGit(["init", "-q", errDest])
		const missingWant = await attemptGit(
			["-c", "protocol.version=2", "fetch", "-q", url, missing],
			errDest,
		)
		missingWantOutcome = missingWant.ok ? "ACCEPTED" : missingWant.stderr
	}, 300_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("repack of a repo name never written writes nothing", () => {
		expect(unknownRepack).toEqual({ deltas: 0, wholes: 0 })
	})

	it("a clone of a repo name never written produces no refs", () => {
		expect(unknownCloneRefs).toBe("")
	})

	it("repack before any push writes nothing", () => {
		expect(repackBeforePush).toEqual({ deltas: 0, wholes: 0 })
	})

	it("a one-commit repo produces no deltas", () => {
		expect(soloRepack.deltas).toBe(0)
	})

	it("a second repack pass writes nothing (frozen policy)", () => {
		expect(secondRepack).toEqual({ deltas: 0, wholes: 0 })
	})

	it("the one-commit repo clones fsck-clean at the source tip", () => {
		expect(soloClone.kind, testResultContext(soloClone, "solo clone")).toBe("succeeded")
		if (soloClone.kind === "succeeded") expect(soloClone.value).toBe(soloSrcTip)
	})

	it("a mixed encoded/unencoded repo clones fsck-clean at the source tip", () => {
		expect(mixedClone.kind, testResultContext(mixedClone, "mixed clone")).toBe(
			"succeeded",
		)
		if (mixedClone.kind === "succeeded") expect(mixedClone.value).toBe(mixedSrcTip)
	})

	it("a tags-only fetch against a repacked repo lands the exact tag", () => {
		expect(tagsFetch.kind, testResultContext(tagsFetch, "tags-only fetch")).toBe(
			"succeeded",
		)
		if (tagsFetch.kind === "succeeded") expect(tagsFetch.value).toBe(tagsWant)
	})

	it("a want the repo does not have is refused in-band, never accepted", () => {
		expect(missingWantOutcome).not.toBe("ACCEPTED")
		expect(missingWantOutcome).toMatch(/remote error|not our ref|upload-pack|error/i)
	})
})

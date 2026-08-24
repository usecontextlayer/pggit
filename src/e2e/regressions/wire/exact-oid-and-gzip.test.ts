/**
 * WIRE — request shapes that stress buildPack's inputs against the deltified tier:
 * a want that is NOT a ref tip, a want plus haves that cut it, a mirror clone, and
 * a many-ref negotiation whose request body git gzip-compresses.
 *   1. `git fetch <url> <oid>` for an OLD commit — the served set is a SUB-closure
 *      of the repo, so a delta's anchor may sit outside it.
 *   2. The same want against a client that already holds an ancestor (haves cut the
 *      anchor out of the served set — the fallback-to-whole rule).
 *   3. Many refs (so the wants list is long): clone, and a fetch whose have list is
 *      long too. Both bodies exceed git's gzip threshold, so the deltified path is
 *      driven through the `Content-Encoding: gzip` decode boundary.
 *   4. `git clone --mirror` (refs/*:refs/*, include-tag) over the same state.
 *
 * Differentially checked against a plain bare git remote wherever the shape allows.
 */
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { allObjectOids, objectBytesDigest } from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const REPO = "workspace/probe/exactoid"
const RUNS = 200
/** Branch count: enough `want` lines that git gzips the request body. */
const BRANCHES = 400

/** sha256 over every local object's raw bytes, in oid order — the byte-level oracle. */
async function bytesDigest(dir: string): Promise<string> {
	return objectBytesDigest(dir, await allObjectOids(dir))
}

type ManyRefResult = TestResult<{ refetch: TestResult<string> }>

describe("wire — exact-oid wants, long gzipped negotiations, mirror clones", () => {
	let db: IsolatedDb
	let server: GitServer
	const { cleanup: cleanupScratch, make: mk, own: ownScratch } = createScratchArena()

	const exactOid = new Map<string, TestResult<boolean>>()
	const haves = new Map<string, TestResult<string>>()
	const manyRefs = new Map<string, ManyRefResult>()
	let mirror: TestResult<number>

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS })
		ownScratch(src)
		const commits = await commitsOldestFirst(src, "HEAD")
		// Many refs: one branch every few commits.
		for (let i = 0; i < BRANCHES; i++) {
			const c = commits[(i * 7 + 3) % commits.length] as string
			await spawnGit(["update-ref", `refs/heads/b${i}`, c], { cwd: src })
		}

		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])
		await spawnGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: bare })
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const pggitUrl = repoUrl(server, REPO)
		const bareUrl = `file://${bare}`
		const remotes = [
			["pggit", pggitUrl],
			["git", bareUrl],
		] as const

		await spawnGit(["push", "-q", pggitUrl, "refs/heads/*:refs/heads/*"], { cwd: src })
		await createRepack(db.sql).repack(REPO)

		// 1. Want an OLD, non-tip commit by exact OID, into an empty repo.
		const oldCommit = commits[Math.floor(commits.length * 0.6)] as string
		for (const [label, url] of remotes) {
			const dest = join(mk(`oid-${label}`), "c")
			await spawnGit(["init", "-q", dest])
			exactOid.set(
				label,
				await captureTestResult(async () => {
					await spawnGit(
						[
							"-c",
							"protocol.version=2",
							"-c",
							"transfer.fsckobjects=true",
							"fetch",
							"-q",
							url,
							oldCommit,
						],
						{ cwd: dest },
					)
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
					const got = (await spawnGit(["cat-file", "commit", oldCommit], { cwd: dest }))
						.stdoutBytes
					const want = (await spawnGit(["cat-file", "commit", oldCommit], { cwd: src }))
						.stdoutBytes
					return got.equals(want)
				}),
			)
		}

		// 2. The same want against a client that already holds an ancestor.
		const ancestor = commits[Math.floor(commits.length * 0.3)] as string
		for (const [label, url] of remotes) {
			const dest = join(mk(`anc-${label}`), "c")
			await spawnGit(["init", "-q", dest])
			await spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, ancestor], {
				cwd: dest,
			})
			await spawnGit(["update-ref", "refs/heads/base", ancestor], { cwd: dest })
			haves.set(
				label,
				await captureTestResult(async () => {
					await spawnGit(
						[
							"-c",
							"protocol.version=2",
							"-c",
							"transfer.fsckobjects=true",
							"fetch",
							"-q",
							url,
							oldCommit,
						],
						{ cwd: dest },
					)
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
					return bytesDigest(dest)
				}),
			)
		}

		// 3. Many-ref clone (git gzips a request body this long) + a long-have fetch.
		for (const [label, url] of remotes) {
			const dest = join(mk(`many-${label}`), "c")
			const cloned = await captureTestResult(async () => {
				await spawnGit([
					"-c",
					"protocol.version=2",
					"-c",
					"transfer.fsckobjects=true",
					"clone",
					"-q",
					"--no-checkout",
					"--no-local",
					url,
					dest,
				])
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				return dest
			})
			if (cloned.kind === "failed") {
				manyRefs.set(label, cloned)
				continue
			}
			// A second fetch from a fully-populated clone: the have list is now every
			// local ref, so the request body is long AND the negotiation is non-trivial.
			const refetch = await captureTestResult(async () => {
				await spawnGit(
					[
						"-c",
						"protocol.version=2",
						"-c",
						"fetch.negotiationAlgorithm=skipping",
						"fetch",
						"-q",
						"--refetch",
						"origin",
					],
					{ cwd: dest },
				)
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				return bytesDigest(dest)
			})
			manyRefs.set(label, { kind: "succeeded", value: { refetch } })
		}

		// 4. Mirror clone (refs/*:refs/*).
		const mirrorDir = join(mk("mirror"), "m.git")
		mirror = await captureTestResult(async () => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"-c",
				"transfer.fsckobjects=true",
				"clone",
				"-q",
				"--mirror",
				pggitUrl,
				mirrorDir,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: mirrorDir })
			return (await spawnGit(["show-ref"], { cwd: mirrorDir })).stdout.trim().split("\n")
				.length
		})
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		cleanupScratch()
	})

	it("serves a want for an exact non-tip OID, byte-identical to the source", () => {
		for (const label of ["pggit", "git"]) {
			const result = exactOid.get(label)
			expect(result?.kind, result ? testResultContext(result, label) : label).toBe(
				"succeeded",
			)
			if (result?.kind === "succeeded") expect(result.value, label).toBe(true)
		}
	})

	it("serves a want whose anchor the client's haves cut out of the served set", () => {
		for (const label of ["pggit", "git"]) {
			const result = haves.get(label)
			expect(result?.kind, result ? testResultContext(result, label) : label).toBe(
				"succeeded",
			)
		}
		const pggit = haves.get("pggit")
		const git = haves.get("git")
		if (pggit?.kind === "succeeded" && git?.kind === "succeeded") {
			expect(pggit.value).toBe(git.value)
		}
	})

	it("serves a gzipped many-ref clone and a long-have refetch, matching git", () => {
		for (const label of ["pggit", "git"]) {
			const result = manyRefs.get(label)
			expect(result?.kind, result ? testResultContext(result, label) : label).toBe(
				"succeeded",
			)
			if (result?.kind === "succeeded") {
				expect(
					result.value.refetch.kind,
					testResultContext(result.value.refetch, `${label} refetch`),
				).toBe("succeeded")
			}
		}
		const pggit = manyRefs.get("pggit")
		const git = manyRefs.get("git")
		if (
			pggit?.kind === "succeeded" &&
			git?.kind === "succeeded" &&
			pggit.value.refetch.kind === "succeeded" &&
			git.value.refetch.kind === "succeeded"
		) {
			expect(pggit.value.refetch.value).toBe(git.value.refetch.value)
		}
	})

	it("serves a mirror clone (refs/*:refs/*) fsck-clean", () => {
		expect(mirror.kind, testResultContext(mirror, "mirror clone")).toBe("succeeded")
		if (mirror.kind === "succeeded") expect(mirror.value).toBeGreaterThan(0)
	})
})

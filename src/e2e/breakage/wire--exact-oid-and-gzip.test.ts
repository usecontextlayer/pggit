/**
 * WIRE — request shapes that stress buildPack's inputs against the deltified tier:
 * a want that is NOT a ref tip, a want plus haves that cut it, a mirror clone, and
 * a many-ref negotiation whose request body git gzip-compresses.
 * (Converted from `breakage/wire--exact-oid-and-gzip.ts`.)
 *
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
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/exactoid"
const RUNS = 200
/** Branch count: enough `want` lines that git gzips the request body. */
const BRANCHES = 400

async function inventory(dir: string): Promise<string[]> {
	return (
		await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], { cwd: dir })
	).stdout
		.split("\n")
		.filter(Boolean)
		.sort()
}

/** sha256 over every local object's raw bytes, in oid order — the byte-level oracle. */
async function bytesDigest(dir: string): Promise<string> {
	const oids = (await inventory(dir)).map((l) => l.split(" ")[0] as string)
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
	})
	return createHash("sha256").update(res.stdoutBytes).digest("hex")
}

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run()
		return null
	} catch (err) {
		return String(err)
	}
}

describe("wire — exact-oid wants, long gzipped negotiations, mirror clones", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	const exactOidError = new Map<string, string | null>()
	const exactOidCommitMatches = new Map<string, boolean>()
	const havesError = new Map<string, string | null>()
	const havesDigest = new Map<string, string>()
	const manyRefCloneError = new Map<string, string | null>()
	const refetchError = new Map<string, string | null>()
	const manyRefDigest = new Map<string, string>()
	let mirrorError: string | null = null
	let mirrorRefCount = 0

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS })
		scratch.push(src)
		const commits = (
			await spawnGit(["rev-list", "--reverse", "HEAD"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		// Many refs: one branch every few commits.
		for (let i = 0; i < BRANCHES; i++) {
			const c = commits[(i * 7 + 3) % commits.length] as string
			await spawnGit(["update-ref", `refs/heads/b${i}`, c], { cwd: src })
		}

		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])
		await spawnGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: bare })
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const pggitUrl = `http://127.0.0.1:${server.port}/${REPO}`
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
			const err = await errorOf(async () => {
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
			})
			exactOidError.set(label, err)
			if (err !== null) continue
			const got = (await spawnGit(["cat-file", "commit", oldCommit], { cwd: dest }))
				.stdoutBytes
			const want = (await spawnGit(["cat-file", "commit", oldCommit], { cwd: src }))
				.stdoutBytes
			exactOidCommitMatches.set(label, got.equals(want))
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
			const err = await errorOf(async () => {
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
			})
			havesError.set(label, err)
			if (err === null) havesDigest.set(label, await bytesDigest(dest))
		}

		// 3. Many-ref clone (git gzips a request body this long) + a long-have fetch.
		for (const [label, url] of remotes) {
			const dest = join(mk(`many-${label}`), "c")
			const cloneErr = await errorOf(async () => {
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
			})
			manyRefCloneError.set(label, cloneErr)
			if (cloneErr !== null) continue
			// A second fetch from a fully-populated clone: the have list is now every
			// local ref, so the request body is long AND the negotiation is non-trivial.
			refetchError.set(
				label,
				await errorOf(async () => {
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
				}),
			)
			manyRefDigest.set(label, await bytesDigest(dest))
		}

		// 4. Mirror clone (refs/*:refs/*).
		const mirror = join(mk("mirror"), "m.git")
		mirrorError = await errorOf(async () => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"-c",
				"transfer.fsckobjects=true",
				"clone",
				"-q",
				"--mirror",
				pggitUrl,
				mirror,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: mirror })
		})
		if (mirrorError === null) {
			mirrorRefCount = (await spawnGit(["show-ref"], { cwd: mirror })).stdout
				.trim()
				.split("\n").length
		}
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("serves a want for an exact non-tip OID, byte-identical to the source", () => {
		for (const label of ["pggit", "git"]) {
			expect(exactOidError.get(label), label).toBeNull()
			expect(exactOidCommitMatches.get(label), label).toBe(true)
		}
	})

	it("serves a want whose anchor the client's haves cut out of the served set", () => {
		for (const label of ["pggit", "git"]) {
			expect(havesError.get(label), label).toBeNull()
		}
		expect(havesDigest.get("pggit")).toBe(havesDigest.get("git"))
	})

	it("serves a gzipped many-ref clone and a long-have refetch, matching git", () => {
		for (const label of ["pggit", "git"]) {
			expect(manyRefCloneError.get(label), label).toBeNull()
			expect(refetchError.get(label), label).toBeNull()
		}
		expect(manyRefDigest.get("pggit")).toBe(manyRefDigest.get("git"))
	})

	it("serves a mirror clone (refs/*:refs/*) fsck-clean", () => {
		expect(mirrorError, `${mirrorRefCount} refs mirrored`).toBeNull()
	})
})

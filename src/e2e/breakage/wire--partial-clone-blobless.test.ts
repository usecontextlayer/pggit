/**
 * WIRE — `git clone --filter=blob:none` against a repacked pggit remote, then the
 * promisor (lazy) blob fetches a checkout forces.
 * (Converted from `breakage/wire--partial-clone-blobless.ts`.)
 *
 * A blobless clone's served set is commits+trees only, so tree deltas ship as
 * REF_DELTA with tree bases — the deltified path at its most exposed. Then git
 * lazily fetches individual blobs by exact OID (`want <blob>` + `filter blob:none`),
 * which drives buildPack's promisor re-add branch against the encoding tier.
 *
 * Oracle: the same sequence against a plain bare git remote over file://, plus
 * fsck and byte-level object comparison.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/blobless"
const RUNS = 120

type BloblessArm = {
	label: string
	cloneError: string | null
	fsckAfterCloneError: string | null
	/** What the filtered clone actually landed locally — the probe printed these to
	 * show the clone really is blob-light, so the promisor path is not vacuous. */
	localObjects: number
	localBlobs: number
	checkoutError: string | null
	fsckAfterCheckoutError: string | null
	lazyBlobError: string | null
	lazyBlobMatches: boolean
	worktreeDigest: string
	worktreeStatus: string
}

async function allLocalObjects(dir: string): Promise<string[]> {
	const res = await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], {
		cwd: dir,
	})
	return res.stdout.split("\n").filter(Boolean).sort()
}

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run()
		return null
	} catch (err) {
		return String(err)
	}
}

describe("wire — blobless clone + promisor fetch against the deltified path", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	const arms: BloblessArm[] = []

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS })
		scratch.push(src)
		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])
		// A plain bare repo can only serve a filtered fetch if it allows filters.
		await spawnGit(["config", "uploadpack.allowFilter", "true"], { cwd: bare })
		await spawnGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: bare })

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const pggitUrl = `http://127.0.0.1:${server.port}/${REPO}`
		const bareUrl = `file://${bare}`

		await spawnGit(["push", "-q", pggitUrl, "--all"], { cwd: src })
		await createRepack(db.sql).repack(REPO)

		// One deep blob, fetched explicitly through the promisor path below.
		const oneBlob = (
			await spawnGit(["rev-parse", "main~40:docs/doc-3.md"], { cwd: src })
		).stdout.trim()

		for (const [label, url] of [
			["pggit", pggitUrl],
			["git", bareUrl],
		] as const) {
			const dest = join(mk(`bl-${label}`), "c")
			const cloneError = await errorOf(() =>
				spawnGit([
					"-c",
					"protocol.version=2",
					"-c",
					"transfer.fsckobjects=true",
					"-c",
					"fetch.fsckobjects=true",
					"clone",
					"-q",
					"--filter=blob:none",
					"--no-checkout",
					url,
					dest,
				]),
			)
			if (cloneError !== null) {
				arms.push({
					checkoutError: null,
					cloneError,
					fsckAfterCheckoutError: null,
					fsckAfterCloneError: null,
					label,
					lazyBlobError: null,
					lazyBlobMatches: false,
					localBlobs: 0,
					localObjects: 0,
					worktreeDigest: "",
					worktreeStatus: "",
				})
				continue
			}
			const objs = await allLocalObjects(dest)
			const localBlobs = objs.filter((l) => l.includes(" blob ")).length
			// A blobless clone must still be a valid promisor repo.
			const fsckAfterCloneError = await errorOf(() =>
				spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest }),
			)

			// Now force the promisor path: check out the tree, which lazily fetches every
			// blob it needs by exact OID.
			const checkoutError = await errorOf(() =>
				spawnGit(["checkout", "-q", "main"], { cwd: dest }),
			)
			if (checkoutError !== null) {
				arms.push({
					checkoutError,
					cloneError,
					fsckAfterCheckoutError: null,
					fsckAfterCloneError,
					label,
					lazyBlobError: null,
					lazyBlobMatches: false,
					localBlobs,
					localObjects: objs.length,
					worktreeDigest: "",
					worktreeStatus: "",
				})
				continue
			}
			const fsckAfterCheckoutError = await errorOf(() =>
				spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest }),
			)

			// And a single explicit lazy fetch of one deep blob.
			let lazyBlobMatches = false
			const lazyBlobError = await errorOf(async () => {
				const got = await spawnGit(["cat-file", "blob", oneBlob], { cwd: dest })
				const want = await spawnGit(["cat-file", "blob", oneBlob], { cwd: src })
				lazyBlobMatches = got.stdoutBytes.equals(want.stdoutBytes)
			})

			// The checked-out worktree, hashed — compared between the two remotes below.
			const files = (await spawnGit(["ls-files"], { cwd: dest })).stdout
				.split("\n")
				.filter(Boolean)
			const h = createHash("sha256")
			for (const f of files.sort()) h.update(f).update(readFileSync(join(dest, f)))
			arms.push({
				checkoutError,
				cloneError,
				fsckAfterCheckoutError,
				fsckAfterCloneError,
				label,
				lazyBlobError,
				lazyBlobMatches,
				localBlobs,
				localObjects: objs.length,
				worktreeDigest: `${files.length}:${h.digest("hex")}`,
				// The clone must also agree with canonical git that the checkout is clean.
				worktreeStatus: (
					await spawnGit(["status", "--porcelain"], { cwd: dest })
				).stdout.trim(),
			})
		}
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("takes a blobless clone that is fsck-clean on both remotes", () => {
		expect(arms.length).toBe(2)
		for (const a of arms) {
			const at = `${a.label} — ${a.localObjects} local objects, ${a.localBlobs} blobs`
			expect(a.cloneError, at).toBeNull()
			expect(a.fsckAfterCloneError, at).toBeNull()
		}
		// The omission proof. Every other assertion in this file is satisfied by a
		// full unfiltered clone — a checkout of a repo that already holds every blob
		// is clean and identical — so `blob:none` is only honored if pggit lands the
		// same number of blobs the git control does, and the control lands none.
		expect(
			arms[1]?.localBlobs,
			"the git control is not blob-light — the fixture proves nothing",
		).toBe(0)
		expect(
			arms[0]?.localBlobs,
			"pggit's blobless clone landed blobs the git control did not",
		).toBe(arms[1]?.localBlobs)
	})

	it("checks out through the promisor blob path, still fsck-clean", () => {
		for (const a of arms) {
			expect(a.checkoutError, a.label).toBeNull()
			expect(a.fsckAfterCheckoutError, a.label).toBeNull()
		}
	})

	it("serves an explicitly lazy-fetched deep blob byte-identically", () => {
		for (const a of arms) {
			expect(a.lazyBlobError, a.label).toBeNull()
			expect(a.lazyBlobMatches, a.label).toBe(true)
		}
	})

	it("leaves a clean worktree identical to the one a plain git remote produces", () => {
		for (const a of arms) expect(a.worktreeStatus, a.label).toBe("")
		expect(arms[0]?.worktreeDigest).toBe(arms[1]?.worktreeDigest)
	})
})

/**
 * WIRE — `git clone --filter=blob:none` against a repacked pggit remote, then the
 * promisor (lazy) blob fetches a checkout forces.
 * A blobless clone's served set is commits+trees only, so tree deltas ship as
 * REF_DELTA with tree bases — the deltified path at its most exposed. Then git
 * lazily fetches individual blobs by exact OID (`want <blob>` + `filter blob:none`),
 * which drives `routeServeSet`'s exact-blob promisor rule against the encoding
 * tier.
 *
 * Oracle: the same sequence against a plain bare git remote over file://, plus
 * fsck and byte-level object comparison.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { objectsByType } from "@/testing/git-fixtures"
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

const REPO = "workspace/probe/blobless"
const RUNS = 120

type ClonedArm = {
	label: string
	fsckAfterClone: TestResult<void>
	/** What the filtered clone actually landed locally — the probe printed these to
	 * show the clone really is blob-light, so the promisor path is not vacuous. */
	localObjects: number
	localBlobs: number
}

type BloblessArm =
	| { kind: "clone-failed"; label: string; error: unknown }
	| (ClonedArm & { kind: "checkout-failed"; error: unknown })
	| (ClonedArm & {
			kind: "checked-out"
			fsckAfterCheckout: TestResult<void>
			lazyBlob: TestResult<boolean>
			worktreeDigest: string
			worktreeStatus: string
	  })

describe("wire — blobless clone + promisor fetch against the deltified path", () => {
	let db: IsolatedDb
	let server: GitServer
	const { cleanup: cleanupScratch, make: mk, own: ownScratch } = createScratchArena()

	const arms: BloblessArm[] = []
	const requireArms = (): [BloblessArm, BloblessArm] => {
		const [pggit, git] = arms
		if (pggit === undefined || git === undefined || arms.length !== 2) {
			throw new Error(`expected pggit and git arms, got ${arms.length}`)
		}
		return [pggit, git]
	}
	const requireClonedArms = (): [ClonedArm, ClonedArm] => {
		const [pggit, git] = requireArms()
		if (pggit.kind === "clone-failed")
			throw new Error(`pggit blobless clone failed: ${String(pggit.error)}`)
		if (git.kind === "clone-failed")
			throw new Error(`git blobless clone failed: ${String(git.error)}`)
		return [pggit, git]
	}
	const requireCheckedOutArms = (): [
		Extract<BloblessArm, { kind: "checked-out" }>,
		Extract<BloblessArm, { kind: "checked-out" }>,
	] => {
		const [pggit, git] = requireArms()
		if (pggit.kind !== "checked-out" || git.kind !== "checked-out") {
			const failed = pggit.kind !== "checked-out" ? pggit : git
			throw new Error(
				`blobless checkout did not complete: ${failed.kind === "clone-failed" || failed.kind === "checkout-failed" ? String(failed.error) : failed.kind}`,
			)
		}
		return [pggit, git]
	}

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS })
		ownScratch(src)
		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])
		// A plain bare repo can only serve a filtered fetch if it allows filters.
		await spawnGit(["config", "uploadpack.allowFilter", "true"], { cwd: bare })
		await spawnGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: bare })

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const pggitUrl = repoUrl(server, REPO)
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
			const clone = await captureTestResult(() =>
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
			if (clone.kind === "failed") {
				arms.push({ error: clone.error, kind: "clone-failed", label })
				continue
			}
			const objs = await objectsByType(dest)
			const localBlobs = objs.filter((object) => object.type === "blob").length
			// A blobless clone must still be a valid promisor repo.
			const fsckAfterClone = await captureTestResult(async () => {
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			})

			// Now force the promisor path: check out the tree, which lazily fetches every
			// blob it needs by exact OID.
			const checkout = await captureTestResult(() =>
				spawnGit(["checkout", "-q", "main"], { cwd: dest }),
			)
			if (checkout.kind === "failed") {
				arms.push({
					error: checkout.error,
					fsckAfterClone,
					kind: "checkout-failed",
					label,
					localBlobs,
					localObjects: objs.length,
				})
				continue
			}
			const fsckAfterCheckout = await captureTestResult(async () => {
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			})

			// And a single explicit lazy fetch of one deep blob.
			const lazyBlob = await captureTestResult(async () => {
				const got = await spawnGit(["cat-file", "blob", oneBlob], { cwd: dest })
				const want = await spawnGit(["cat-file", "blob", oneBlob], { cwd: src })
				return got.stdoutBytes.equals(want.stdoutBytes)
			})

			// The checked-out worktree, hashed — compared between the two remotes below.
			const files = (await spawnGit(["ls-files"], { cwd: dest })).stdout
				.split("\n")
				.filter(Boolean)
			const h = createHash("sha256")
			for (const f of files.sort()) h.update(f).update(readFileSync(join(dest, f)))
			arms.push({
				fsckAfterCheckout,
				fsckAfterClone,
				kind: "checked-out",
				label,
				lazyBlob,
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
		await teardownGitServerFixture({ db, server })
		cleanupScratch()
	})

	it("takes a blobless clone that is fsck-clean on both remotes", () => {
		expect(arms.length).toBe(2)
		for (const a of arms) {
			const at =
				a.kind === "clone-failed"
					? `${a.label}: ${String(a.error)}`
					: `${a.label} — ${a.localObjects} local objects, ${a.localBlobs} blobs`
			expect(a.kind, at).not.toBe("clone-failed")
			if (a.kind !== "clone-failed") {
				expect(
					a.fsckAfterClone.kind,
					testResultContext(a.fsckAfterClone, `${at} fsck`),
				).toBe("succeeded")
			}
		}
		// The omission proof. Every other assertion in this file is satisfied by a
		// full unfiltered clone — a checkout of a repo that already holds every blob
		// is clean and identical — so `blob:none` is only honored if pggit lands the
		// same number of blobs the git control does, and the control lands none.
		const [pggit, git] = requireClonedArms()
		expect(
			git.localBlobs,
			"the git control is not blob-light — the fixture proves nothing",
		).toBe(0)
		expect(
			pggit.localBlobs,
			"pggit's blobless clone landed blobs the git control did not",
		).toBe(git.localBlobs)
	})

	it("checks out through the promisor blob path, still fsck-clean", () => {
		for (const a of arms) {
			const at =
				a.kind === "clone-failed" || a.kind === "checkout-failed"
					? `${a.label}: ${String(a.error)}`
					: a.label
			expect(a.kind, at).toBe("checked-out")
			if (a.kind === "checked-out") {
				expect(
					a.fsckAfterCheckout.kind,
					testResultContext(a.fsckAfterCheckout, `${a.label} fsck after checkout`),
				).toBe("succeeded")
			}
		}
	})

	it("serves an explicitly lazy-fetched deep blob byte-identically", () => {
		for (const a of arms) {
			if (a.kind !== "checked-out") continue
			expect(a.lazyBlob.kind, testResultContext(a.lazyBlob, a.label)).toBe("succeeded")
			if (a.lazyBlob.kind === "succeeded") expect(a.lazyBlob.value, a.label).toBe(true)
		}
	})

	it("leaves a clean worktree identical to the one a plain git remote produces", () => {
		const [pggit, git] = requireCheckedOutArms()
		for (const a of [pggit, git]) expect(a.worktreeStatus, a.label).toBe("")
		expect(pggit.worktreeDigest).toBe(git.worktreeDigest)
	})
})

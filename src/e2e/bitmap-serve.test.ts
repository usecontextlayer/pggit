/**
 * The bitmap serve fast path (spine chunk 5b, S6): after a drain, a no-have
 * unfiltered fetch is answered from the epoch's bitmaps instead of the tree
 * walk — and the answer must be EXACTLY what the walk would have served. The
 * arbiter is the S6 gate: the same real-git fetch against the same repo, run
 * before and after the drain, must transfer the identical object set (and
 * fsck), across every shape the router can take:
 *
 *   - a full clone whose wants are all epoch tips (the pure-OR path, no walk)
 *   - a single-branch fetch (a want SUBSET of the tips)
 *   - a clone right after a post-drain push (want = tip descendant: frontier
 *     delta + bitmap OR)
 *   - a branch forked from MID-history pushed after the drain (the walk's
 *     exclusions lean on a tip the want never reached — boundaryExact goes
 *     false and the path must fall back, invisibly, to the full walk)
 *   - a `blob:none` filtered clone (bitmaps carry no type bits — bypassed)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	type GcFixture,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import { allObjectOids } from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "epoch/serve"

describe("bitmap-served fetches (chunk 5b)", () => {
	let fx: GcFixture
	let src = ""
	let url = ""
	let forkPoint = ""
	let tagBase = "" // c1 — the commit both tag chains peel to

	beforeAll(async () => {
		fx = await setupGcFixture()
		src = mkdtempSync(join(tmpdir(), "pggit-bmserve-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		const commit = async (name: string, content: string): Promise<string> => {
			writeFileSync(join(src, name), content)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", name], { cwd: src })
			return (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		}
		const c1 = await commit("a.txt", "one\n")
		// The fork point must be a mid-history commit NO tip peels to — the tag
		// sits on c1, so a fork from c1 would be boundary-covered and the
		// fallback shape below would silently not exercise the fallback.
		forkPoint = await commit("b.txt", "two\n")
		// A side branch and a merge, plus an annotated tag — the corpus shapes.
		await spawnGit(["checkout", "-q", "-b", "side", c1], { cwd: src })
		await commit("s.txt", "side\n")
		await spawnGit(["checkout", "-q", "main"], { cwd: src })
		await spawnGit(["merge", "-q", "--no-ff", "-m", "merge side", "side"], { cwd: src })
		await spawnGit(["tag", "-a", "-m", "v1", "v1", c1], { cwd: src })
		// A CHAINED tag (tag object pointing at a tag object): its epoch bitmap
		// carries the whole chain, and a hit at its PEELED commit must subtract
		// exactly the chain — the epochServe semantics the last test pins.
		await spawnGit(["tag", "-a", "-m", "vmeta", "vmeta", "v1"], { cwd: src })
		tagBase = c1
		await commit("c.txt", "three\n")

		url = repoUrl(fx, REPO)
		await spawnGit(
			["push", "-q", url, "main", "side", "refs/tags/v1", "refs/tags/vmeta"],
			{
				cwd: src,
			},
		)
	}, 120_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
		if (src) rmSync(src, { force: true, recursive: true })
	})

	/** Clone (optionally filtered/single-branch), fsck, return the odb oids. */
	async function cloneOids(extra: string[] = []): Promise<string[]> {
		const dest = mkdtempSync(join(tmpdir(), "pggit-bmserve-dest-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				...extra,
				url,
				dest,
			])
			await spawnGit(["fsck", "--full", "--no-dangling"], { cwd: dest })
			return await allObjectOids(dest)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	}

	/** Fetch exactly one ref into a fresh empty repo; fsck; return the oids. */
	async function fetchOneOids(refspec: string): Promise<string[]> {
		const dest = mkdtempSync(join(tmpdir(), "pggit-bmserve-one-"))
		try {
			await spawnGit(["init", "-q", dest])
			// --no-tags: fetch would otherwise auto-follow the annotated tag into
			// the transfer (include-tag), and the rev-list expectations below are
			// single-ref closures.
			await spawnGit(
				["-c", "protocol.version=2", "fetch", "-q", "--no-tags", url, refspec],
				{
					cwd: dest,
				},
			)
			await spawnGit(["fsck", "--full", "--no-dangling"], { cwd: dest })
			return await allObjectOids(dest)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	}

	it("a full clone after the drain transfers the identical set (pure bitmap OR)", async () => {
		const before = await cloneOids()
		// Huge grace: the drain must only PRODUCE the epoch, never reclaim here.
		const gc = await fx.gc.gc(REPO, { graceSeconds: 365 * 24 * 60 * 60 })
		expect(gc.epoch).toBe("rebuilt")
		const after = await cloneOids()
		expect(after).toEqual(before)
	})

	it("a single-branch fetch (want subset of tips) is unchanged by the drain", async () => {
		const oids = await fetchOneOids("refs/heads/side:refs/heads/side")
		const expected = (
			await spawnGit(["rev-list", "--objects", "side"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(0, 40))
			.sort()
		expect(oids).toEqual(expected)
	})

	it("a clone right after a post-drain push (tip descendant want) stays exact", async () => {
		writeFileSync(join(src, "d.txt"), "four\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "post-drain"], { cwd: src })
		await spawnGit(["push", "-q", url, "main"], { cwd: src })

		const got = await cloneOids()
		const expected = (
			await spawnGit(["rev-list", "--objects", "--all"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(0, 40))
			.sort()
		expect(got).toEqual(expected)
	})

	it("a mid-history fork pushed after the drain fetches exactly (loud fallback shape)", async () => {
		// Fork below every tip: the fork point sits INSIDE the epoch, so the
		// delta walk's exclusions lean on tips the want never reaches —
		// boundaryExact goes false and the serve must fall back to the walk.
		await spawnGit(["checkout", "-q", "-b", "forked", forkPoint], { cwd: src })
		writeFileSync(join(src, "fork.txt"), "forked\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "forked"], { cwd: src })
		await spawnGit(["push", "-q", url, "forked"], { cwd: src })
		await spawnGit(["checkout", "-q", "main"], { cwd: src })

		const oids = await fetchOneOids("refs/heads/forked:refs/heads/forked")
		const expected = (
			await spawnGit(["rev-list", "--objects", "forked"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(0, 40))
			.sort()
		expect(oids).toEqual(expected)
	})

	it("a blob:none clone bypasses the bitmaps and stays correct", async () => {
		// Re-drain so the epoch covers everything pushed above (advanced or
		// rebuilt — either way the fast path is live again for full clones).
		const gc = await fx.gc.gc(REPO, { graceSeconds: 365 * 24 * 60 * 60 })
		expect(["advanced", "rebuilt"]).toContain(gc.epoch)
		const filtered = await cloneOids(["--filter=blob:none", "--no-checkout"])
		const full = await cloneOids()
		// The filtered odb is a strict subset missing ONLY blobs the checkoutless
		// clone never fetched; every commit and tree still arrives. STRICT is
		// load-bearing: a server that ignores the filter and ships everything
		// must fail here, not pass a subset check vacuously.
		expect(filtered.every((o) => full.includes(o))).toBe(true)
		expect(filtered.length).toBeLessThan(full.length)
		const blobs = (
			await spawnGit(
				[
					"rev-list",
					"--objects",
					"--all",
					"--filter=blob:none",
					"--filter-print-omitted",
				],
				{ cwd: src },
			)
		).stdout
			.split("\n")
			.filter((l) => l.startsWith("~"))
			.map((l) => l.slice(1, 41))
		expect(blobs.length).toBeGreaterThan(0)
		for (const b of blobs) expect(filtered).not.toContain(b)
		const commitsAndTrees = (
			await spawnGit(["rev-list", "--objects", "--filter=blob:none", "--all"], {
				cwd: src,
			})
		).stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(0, 40))
			.sort()
		for (const o of commitsAndTrees) expect(filtered).toContain(o)
	})

	it("a fork at the tag chains' peeled commit serves via chain subtraction — exactly", async () => {
		// A new branch whose parent IS the tags' peeled commit: the delta walk
		// hits that commit as a boundary, and its coverage comes from a TAG
		// tip's bitmap minus the tag chain. Fetched --no-tags, the chain must
		// be absent; auto-following tags, present.
		await spawnGit(["checkout", "-q", "-b", "atbase", tagBase], { cwd: src })
		writeFileSync(join(src, "atbase.txt"), "atbase\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "atbase"], { cwd: src })
		await spawnGit(["push", "-q", url, "atbase"], { cwd: src })
		await spawnGit(["checkout", "-q", "main"], { cwd: src })

		const bare = await fetchOneOids("refs/heads/atbase:refs/heads/atbase")
		const expected = (
			await spawnGit(["rev-list", "--objects", "atbase"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(0, 40))
			.sort()
		expect(bare).toEqual(expected)
		const v1Oid = (
			await spawnGit(["rev-parse", "refs/tags/v1"], { cwd: src })
		).stdout.trim()
		const vmetaOid = (
			await spawnGit(["rev-parse", "refs/tags/vmeta"], { cwd: src })
		).stdout.trim()
		expect(bare).not.toContain(v1Oid)
		expect(bare).not.toContain(vmetaOid)

		// The positive twin: tag auto-follow ships both chain tags, since they
		// point (transitively) into the transferred history.
		const dest = mkdtempSync(join(tmpdir(), "pggit-bmserve-tags-"))
		try {
			await spawnGit(["init", "-q", dest])
			await spawnGit(
				[
					"-c",
					"protocol.version=2",
					"fetch",
					"-q",
					url,
					"refs/heads/atbase:refs/heads/atbase",
				],
				{ cwd: dest },
			)
			await spawnGit(["fsck", "--full", "--no-dangling"], { cwd: dest })
			const followed = await allObjectOids(dest)
			expect(followed).toContain(v1Oid)
			expect(followed).toContain(vmetaOid)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

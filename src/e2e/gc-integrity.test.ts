import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	cloneAndFsck,
	derivedRows,
	derivedRowViolations,
	type GcFixture,
	gitReachableOids,
	objectOids,
	pushDenied,
	pushFile,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
	withTempDir,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"

/**
 * GC integrity contract — `docs/2026-06-24-force-commit-gc-design.md` §4,
 * retargeted onto the spine's derived rows (git_edge is gone, S2):
 *
 *   GC-5 — Object⟺derived-rows invariant (every surviving commit/tag object
 *          keeps its `git_commit`/`git_tag` row; no row survives its object).
 *   GC-6 — Idempotence (GC∘GC == GC; the second run deletes nothing).
 *   GC-7 — Reachable set is exactly git's (graceSeconds: 0, incl. annotated tags).
 *
 * OBSERVABLE-ONLY: assertions touch only the real `git` oracle (clone/fetch/fsck,
 * `gitReachableOids`), Postgres rows (`objectOids`/`derivedRows`/`git_ref`), and
 * the `gc()` return value — never GC internals (temp tables, batch/transaction
 * shape). Grace is deterministic: every reclaiming run uses `graceSeconds: 0`,
 * never a wall-clock wait.
 */

/** git_object/git_tag `target_type` codes, for building oracle lines. */
const TYPE_CODE: Record<string, number> = { blob: 3, commit: 1, tag: 4, tree: 2 }

/**
 * The real-git derived rows of an on-disk repo — the independent oracle for the
 * surviving `git_commit`/`git_tag` set, in `derivedRows`' canonical text form.
 * Values come from git's OWN readings (`git log --format`, `cat-file tag`), so a
 * store-side parse bug cannot echo into the expectation. Generation is absent by
 * design: git exposes no per-commit generation surface here, and the dedicated
 * derivation suite pins it (commit-graph-derivation.test.ts).
 */
async function gitDerivedRows(dir: string): Promise<string[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const reachable = new Set(await gitReachableOids(dir))
	const lines: string[] = []
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (!oid || !type || !reachable.has(oid)) continue
		if (type === "commit") {
			const out = (
				await spawnGit(["log", "-1", "--format=%T %P %ct", oid], { cwd: dir })
			).stdout.trim()
			const tokens = out.split(/\s+/)
			const tree = tokens[0]
			const time = tokens[tokens.length - 1]
			const parents = tokens.slice(1, -1)
			lines.push(`commit ${oid} tree=${tree} parents=${parents.join(",")} time=${time}`)
		} else if (type === "tag") {
			const body = (await spawnGit(["cat-file", "tag", oid], { cwd: dir })).stdout
			const target = body
				.split("\n")
				.find((l) => l.startsWith("object "))
				?.slice("object ".length)
				.trim()
			const targetType = body
				.split("\n")
				.find((l) => l.startsWith("type "))
				?.slice("type ".length)
				.trim()
			const code = targetType === undefined ? undefined : TYPE_CODE[targetType]
			if (!target || code === undefined) {
				throw new Error(`gitDerivedRows: malformed tag ${oid} in oracle repo`)
			}
			lines.push(`tag ${oid} target=${target} type=${code}`)
		}
	}
	return lines.sort()
}

/**
 * Push a commit on `refs/heads/main` PLUS an annotated tag on `refs/tags/v1` (which
 * points at the tag OBJECT, peeling to the commit) through the served pggit, KEEPING
 * the source repo so it can be the real-git survivor oracle. The scaffold `pushFile`
 * discards its source and only touches `refs/heads/main`; the GC-7 annotated-tag
 * scenario needs the peeled-tag ref live AND the on-disk oracle, so it gets a local
 * push that does both. Returns the src dir (kept until the caller's `withTempDir`
 * closes) for `gitReachableOids`.
 */
async function pushCommitAndTag(
	fx: Pick<GcFixture, "server">,
	repo: string,
	src: string,
	content: string,
): Promise<void> {
	const url = repoUrl(fx, repo)
	await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
	writeFileSync(join(src, "file.txt"), content)
	await spawnGit(["add", "."], { cwd: src })
	await spawnGit(["commit", "-q", "-m", "c"], { cwd: src })
	await spawnGit(["tag", "-a", "v1", "-m", "release"], { cwd: src })
	// Plain push: under deny-non-FF this helper is only ever called against a
	// FRESH repo (both refs are creates); the orphan producer is pushDenied.
	await spawnGit(["push", url, "HEAD:refs/heads/main", "refs/tags/v1:refs/tags/v1"], {
		cwd: src,
	})
}

/**
 * Push a TWO-commit history with a NESTED tree through the served pggit, KEEPING the
 * source repo as the real-git survivor oracle. Every deterministic example elsewhere
 * in this file uses flat single-root commits, so two live shapes are otherwise never
 * exercised by an example (only by the thin property tests): a commit with a REAL
 * parent link — denied pushes orphan via *independent roots* with no parent — and a
 * nested subtree — `pushFile` writes a flat `file.txt` with no directory. This
 * builds both into the LIVE tip:
 *   - commit A roots `dir/a.txt` (root tree → subtree `dir/` → blob);
 *   - commit B (child of A) adds `dir/b.txt`, so B's row carries `parents=[A]` and
 *     its root tree still nests `dir/`.
 * `refs/heads/main` is pushed at B; `refs/heads/other` is pushed at the PARENT
 * commit A, so A and its tree/blob stay reachable through a SECOND ref — exercising
 * multi-ref reachability — while everything in the prior orphan-producing push stays
 * unreachable. The source dir is kept (until the caller's `withTempDir` closes) so
 * `gitReachableOids`/`gitDerivedRows` can read its live topology. Returns the two
 * commit oids for tip assertions.
 */
async function pushNested(
	fx: Pick<GcFixture, "server">,
	repo: string,
	src: string,
): Promise<{ parent: string; tip: string }> {
	const url = repoUrl(fx, repo)
	await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
	mkdirSync(join(src, "dir"))
	writeFileSync(join(src, "dir", "a.txt"), "a\n")
	await spawnGit(["add", "."], { cwd: src })
	await spawnGit(["commit", "-q", "-m", "a"], { cwd: src })
	const parent = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
	writeFileSync(join(src, "dir", "b.txt"), "b\n")
	await spawnGit(["add", "."], { cwd: src })
	await spawnGit(["commit", "-q", "-m", "b"], { cwd: src })
	const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
	// Plain push: fresh repo, both refs are creates (deny-non-FF era).
	await spawnGit(["push", url, "HEAD:refs/heads/main", `${parent}:refs/heads/other`], {
		cwd: src,
	})
	return { parent, tip }
}

describe("GC integrity — derived rows, idempotence, exact reachable set (§4 GC-5/6/7)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	// GC-5 — Object⟺derived-rows invariant.
	it("GC-5: leaves no derived row for a deleted object after reclaiming orphans", async () => {
		const repo = "gc5-no-dangling"
		// Seed the live tip, then two DENIED pushes from independent repos: their
		// ingested-but-refused commit/tree/blob objects (and rows) are orphans.
		await pushFile(fx, repo, { content: "v1\n" })
		await pushDenied(fx, repo, { content: "v2\n" })
		await pushDenied(fx, repo, { content: "v3\n" })

		// graceSeconds: 0 reclaims every unreachable object now, no aging needed.
		const result = await fx.gc.gc(repo, { graceSeconds: 0 })
		// Orphans WERE swept (otherwise the invariant below is vacuous).
		expect(result.deletedObjects).toBeGreaterThan(0)

		// Both directions of the invariant hold (the 0009 cascades took the orphans'
		// rows inside the object DELETEs; every survivor keeps its row).
		expect(await derivedRowViolations(fx.db, repo)).toEqual([])
	})

	it("GC-5: every surviving commit/tag keeps its exact derived row (matches git's own readings)", async () => {
		const repo = "gc5-complete-edges"
		const final = await pushFile(fx, repo, { content: "v1\n" })
		await pushDenied(fx, repo, { content: "v2\n" })
		await pushDenied(fx, repo, { content: "v3\n" })

		// Reconstruct the surviving tip on disk to derive its real-git edge topology —
		// the independent oracle for "complete edge set, nothing wrongly deleted".
		const expectedRows = await withTempDir("pggit-gc5-oracle-", async (dir) => {
			await spawnGit(["init", "-q"], { cwd: dir })
			// Fetch into a real local ref, not just FETCH_HEAD: the row/closure oracle
			// walks `rev-list --all`, which only sees `refs/` entries — a bare FETCH_HEAD
			// is invisible to it, leaving the expected set wrongly empty. A non-default
			// ref name avoids colliding with the fresh repo's unborn current branch.
			await spawnGit(
				[
					"-c",
					"protocol.version=2",
					"fetch",
					repoUrl(fx, repo),
					"refs/heads/main:refs/heads/oracle",
				],
				{ cwd: dir },
			)
			expect(
				(await spawnGit(["rev-parse", "FETCH_HEAD"], { cwd: dir })).stdout.trim(),
			).toBe(final.head)
			return gitDerivedRows(dir)
		})

		await fx.gc.gc(repo, { graceSeconds: 0 })

		// Surviving derived rows == exactly what git derives from the reachable
		// objects. This pins BOTH directions: no row survives a deleted object, and
		// no surviving object's row was wrongly swept or corrupted.
		expect(await derivedRows(fx.db, repo)).toEqual(expectedRows)
		expect(await derivedRowViolations(fx.db, repo)).toEqual([])
	})

	// GC-6 — Idempotence: GC∘GC == GC.
	it("GC-6: a second consecutive GC deletes nothing", async () => {
		const repo = "gc6-idempotent-counts"
		await pushFile(fx, repo, { content: "v1\n" })
		await pushDenied(fx, repo, { content: "v2\n" })

		const first = await fx.gc.gc(repo, { graceSeconds: 0 })
		expect(first.deletedObjects).toBeGreaterThan(0)

		const second = await fx.gc.gc(repo, { graceSeconds: 0 })
		expect(second).toEqual({ deletedObjects: 0, epoch: "unchanged" })
	})

	it("GC-6: row sets and a clone are byte-identical after the second GC", async () => {
		const repo = "gc6-idempotent-state"
		const final = await pushFile(fx, repo, { content: "v1\n" })
		await pushDenied(fx, repo, { content: "v2\n" })
		await pushDenied(fx, repo, { content: "v3\n" })

		await fx.gc.gc(repo, { graceSeconds: 0 })
		const objAfter1 = await objectOids(fx.db, repo)
		const rowsAfter1 = await derivedRows(fx.db, repo)
		const refsAfter1 = await fx.refs.listRefs(repo)
		const cloneAfter1 = await cloneAndFsck(fx, repo)

		await fx.gc.gc(repo, { graceSeconds: 0 })
		// Postgres surfaces unchanged by the second run.
		expect(await objectOids(fx.db, repo)).toEqual(objAfter1)
		expect(await derivedRows(fx.db, repo)).toEqual(rowsAfter1)
		expect(await fx.refs.listRefs(repo)).toEqual(refsAfter1)
		// Git surface unchanged: same tip, same object set, same content, fsck-clean.
		const cloneAfter2 = await cloneAndFsck(fx, repo)
		expect(cloneAfter2).toEqual(cloneAfter1)
		expect(cloneAfter2.head).toBe(final.head)
	})

	// GC-7 — Reachable set is exactly git's (graceSeconds: 0).
	it("GC-7: survivors equal git's reachable closure after denied pushes", async () => {
		const repo = "gc7-exact-reachable"
		// The LIVE push's source closure is the only reachable set; pushFile returns
		// the real-git `rev-list --objects --all` oracle for that single-commit repo.
		// The two denied pushes only contribute orphans.
		const final = await pushFile(fx, repo, { content: "v1\n" })
		await pushDenied(fx, repo, { content: "v2\n" })
		await pushDenied(fx, repo, { content: "v3\n" })

		await fx.gc.gc(repo, { graceSeconds: 0 })

		// Neither over- nor under-deletes: Postgres survivor set == git's reachable set.
		expect(await objectOids(fx.db, repo)).toEqual([...final.reachable].sort())
	})

	it("GC-7: survivors include the annotated-tag object and its peeled target", async () => {
		const repo = "gc7-annotated-tag"
		// The live scenario first: a commit + annotated tag into the FRESH repo,
		// KEEPING the source as the survivor oracle. The tag ref points at the tag
		// OBJECT (peeling to the commit), so the closure must include the tag
		// object itself plus the peeled commit/tree/blob.
		await withTempDir("pggit-gc7-tag-src-", async (src) => {
			await pushCommitAndTag(fx, repo, src, "tagged\n")
			const expected = await gitReachableOids(src) // includes the annotated-tag object

			// Then a DENIED push contributes orphans (its objects must be reclaimed).
			await pushDenied(fx, repo, { content: "stale\n" })

			await fx.gc.gc(repo, { graceSeconds: 0 })

			// Exactly git's reachable set — the annotated-tag object is kept (peeled
			// targets exercised), the denied push's objects are gone.
			expect(await objectOids(fx.db, repo)).toEqual(expected)
		})

		// And the served repo still clones clean over both the branch and the tag ref.
		const cloneMain = await cloneAndFsck(fx, repo, "refs/heads/main")
		expect(cloneMain.fileContent).toBe("tagged\n")
		const cloneTag = await cloneAndFsck(fx, repo, "refs/tags/v1")
		expect(cloneTag.fileContent).toBe("tagged\n")
	})

	// GC-5 + GC-7 over a LIVE history that actually exercises a real parent link
	// and a nested subtree — the gap the flat single-root examples above leave to
	// the property tests. The live tip is a two-commit chain with a nested `dir/`;
	// a second ref keeps the parent commit reachable (multi-ref), while a denied
	// push's objects are orphaned so GC reclaims non-vacuously.
	it("GC-5/GC-7: keeps the full parent-linked derived rows and exact closure of a nested two-commit history", async () => {
		const repo = "gc57-nested-parent-subtree"
		await withTempDir("pggit-gc57-src-", async (src) => {
			// The live nested history lands first (fresh repo — creates only)…
			const { parent, tip } = await pushNested(fx, repo, src)
			// …then a DENIED push contributes flat orphans, so GC reclaims
			// non-vacuously.
			await pushDenied(fx, repo, { content: "stale\n" })

			// Independent real-git oracles over the kept source: the exact reachable
			// closure (GC-7) and the exact derived-row set including a real
			// parent-linked commit row (GC-5), across BOTH refs.
			const expectedOids = await gitReachableOids(src)
			const expectedRows = await gitDerivedRows(src)
			// Guard the fixture itself: the live history really does carry a commit
			// with a parent, else this example would silently test nothing new.
			expect(expectedRows.some((l) => / parents=[0-9a-f]{40}/.test(l))).toBe(true)

			await fx.gc.gc(repo, { graceSeconds: 0 })

			// GC-7: Postgres survivor set == git's reachable closure (parent A reachable
			// via `refs/heads/other`, tip B via `refs/heads/main`); the denied push gone.
			expect(await objectOids(fx.db, repo)).toEqual(expectedOids)
			// GC-5: surviving derived rows == git's own readings exactly (the parent
			// link kept in content order, none wrongly swept)…
			expect(await derivedRows(fx.db, repo)).toEqual(expectedRows)
			// …and the object⟺derived-rows invariant is clean.
			expect(await derivedRowViolations(fx.db, repo)).toEqual([])

			// Both live refs clone clean: tip B over main, parent A over other.
			const cloneMain = await cloneAndFsck(fx, repo, "refs/heads/main", "dir/b.txt")
			expect(cloneMain.head).toBe(tip)
			expect(cloneMain.fileContent).toBe("b\n")
			const cloneOther = await cloneAndFsck(fx, repo, "refs/heads/other", "dir/a.txt")
			expect(cloneOther.head).toBe(parent)
			expect(cloneOther.fileContent).toBe("a\n")
		})
	})
})

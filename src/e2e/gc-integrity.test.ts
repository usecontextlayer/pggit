import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	cloneAndFsck,
	edgeRows,
	type GcFixture,
	gitReachableOids,
	objectOids,
	pushFile,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
	withTempDir,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"

/**
 * GC integrity contract — `docs/2026-06-24-force-commit-gc-design.md` §4:
 *
 *   GC-5 — No dangling edges / object⟺edges invariant.
 *   GC-6 — Idempotence (GC∘GC == GC; the second run deletes nothing).
 *   GC-7 — Reachable set is exactly git's (graceSeconds: 0, incl. annotated tags).
 *
 * OBSERVABLE-ONLY: assertions touch only the real `git` oracle (clone/fetch/fsck,
 * `gitReachableOids`), Postgres rows (`objectOids`/`edgeRows`/`git_ref`), and the
 * `gc()` return value — never GC internals (temp tables, batch/transaction shape).
 * Grace is deterministic: every reclaiming run uses `graceSeconds: 0`, never a
 * wall-clock wait. These RED now (the `createGc` stub throws) and GREEN once GC is
 * correctly implemented.
 */

/** Hex `git_object` OIDs that no longer exist among the survivors but which some
 * surviving `git_edge` still points at (as parent OR child). The §4 GC-5
 * dangling-edge anti-join: this set MUST be empty after GC. */
async function danglingEdgeOids(
	db: Pick<GcFixture["db"], "sql">,
	repo: string,
): Promise<string[]> {
	const rows = await db.sql<{ oid: string }[]>`
		select encode(e.parent, 'hex') as oid
		from git_edge e
		join repos r on r.id = e.repo_id
		where r.name = ${repo}
			and not exists (
				select 1 from git_object o
				where o.repo_id = e.repo_id and o.oid = e.parent
			)
		union
		select encode(e.child, 'hex') as oid
		from git_edge e
		join repos r on r.id = e.repo_id
		where r.name = ${repo}
			and not exists (
				select 1 from git_object o
				where o.repo_id = e.repo_id and o.oid = e.child
			)
		order by oid
	`
	return rows.map((row) => row.oid)
}

/**
 * The real-git topology edges of an on-disk repo — the independent oracle for the
 * surviving edge set (GC-5's "complete edge set" direction). For every reachable
 * commit/tree/annotated-tag object it derives the same kinds GC stores in
 * `git_edge` (`object/edges.ts`): commit→tree (1), commit→parent (2),
 * tree→subtree (3), tag→target (5). tree→blob is deliberately NOT an edge (§4.3),
 * so blobs and gitlinks (mode 160000) are skipped — matching the store. Sorted
 * `{parent, child, kind}`, directly comparable to `edgeRows`.
 */
async function gitEdgeRows(
	dir: string,
): Promise<{ parent: string; child: string; kind: number }[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const reachable = new Set(await gitReachableOids(dir))
	const edges: { parent: string; child: string; kind: number }[] = []
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (!oid || !type || !reachable.has(oid)) continue
		if (type === "commit") {
			const tree = (
				await spawnGit(["rev-parse", `${oid}^{tree}`], { cwd: dir })
			).stdout.trim()
			edges.push({ child: tree, kind: 1, parent: oid })
			const body = (await spawnGit(["cat-file", "commit", oid], { cwd: dir })).stdout
			for (const bodyLine of body.split("\n")) {
				if (bodyLine === "") break // headers end at the blank line
				if (bodyLine.startsWith("parent ")) {
					edges.push({
						child: bodyLine.slice("parent ".length).trim(),
						kind: 2,
						parent: oid,
					})
				}
			}
		} else if (type === "tree") {
			const entries = (await spawnGit(["ls-tree", oid], { cwd: dir })).stdout
			for (const entryLine of entries.trim().split("\n")) {
				if (!entryLine) continue
				const tab = entryLine.indexOf("\t")
				const [mode, etype, eoid] = entryLine.slice(0, tab).split(" ")
				// tree→subtree only; tree→blob is not an edge, gitlinks live elsewhere.
				if (etype === "tree" && mode !== "160000" && eoid) {
					edges.push({ child: eoid, kind: 3, parent: oid })
				}
			}
		} else if (type === "tag") {
			const target = (await spawnGit(["cat-file", "tag", oid], { cwd: dir })).stdout
				.split("\n")
				.find((l) => l.startsWith("object "))
				?.slice("object ".length)
				.trim()
			if (target) edges.push({ child: target, kind: 5, parent: oid })
		}
	}
	return edges.sort(
		(a, b) =>
			a.parent.localeCompare(b.parent) ||
			a.child.localeCompare(b.child) ||
			a.kind - b.kind,
	)
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
	await spawnGit(
		["push", "--force", url, "HEAD:refs/heads/main", "refs/tags/v1:refs/tags/v1"],
		{ cwd: src },
	)
}

/**
 * Push a TWO-commit history with a NESTED tree through the served pggit, KEEPING the
 * source repo as the real-git survivor oracle. Every deterministic example elsewhere
 * in this file uses flat single-root commits, so two live edge kinds are otherwise
 * never exercised by an example (only by the thin property tests): a real
 * commit→parent (kind 2) — force-commits orphan via *independent roots* with no
 * parent — and a tree→subtree (kind 3) — `pushFile` writes a flat `file.txt` with no
 * nested directory. This builds both into the LIVE tip:
 *   - commit A roots `dir/a.txt` (root tree → subtree `dir/` → blob);
 *   - commit B (child of A) adds `dir/b.txt`, so B carries a `parent A` header
 *     (kind 2) and its root tree still nests `dir/` (kind 3).
 * `refs/heads/main` is force-pushed at B; `refs/heads/other` is pushed at the PARENT
 * commit A, so A and its tree/blob stay reachable through a SECOND ref — exercising
 * multi-ref reachability — while everything in the prior orphan-producing push stays
 * unreachable. The source dir is kept (until the caller's `withTempDir` closes) so
 * `gitReachableOids`/`gitEdgeRows` can read its live topology. Returns the two commit
 * oids for tip assertions.
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
	await spawnGit(
		["push", "--force", url, "HEAD:refs/heads/main", `${parent}:refs/heads/other`],
		{ cwd: src },
	)
	return { parent, tip }
}

describe("GC integrity — edges, idempotence, exact reachable set (§4 GC-5/6/7)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	// GC-5 — No dangling edges / object⟺edges invariant.
	it("GC-5: leaves no edge pointing at a deleted object after reclaiming orphans", async () => {
		const repo = "gc5-no-dangling"
		// Seed, then force-commit twice from independent repos so the first two pushes'
		// commit/tree/blob objects (and their edges) are orphaned and eligible.
		await pushFile(fx, repo, { content: "v1\n" })
		await pushFile(fx, repo, { content: "v2\n", force: true })
		await pushFile(fx, repo, { content: "v3\n", force: true })

		// graceSeconds: 0 reclaims every unreachable object now, no aging needed.
		const result = await fx.gc.gc(repo, { graceSeconds: 0 })
		// Orphans WERE swept (otherwise the invariant below is vacuous).
		expect(result.deletedObjects).toBeGreaterThan(0)
		expect(result.deletedEdges).toBeGreaterThan(0)

		// (a) No surviving edge references a non-surviving object (Postgres anti-join).
		expect(await danglingEdgeOids(fx.db, repo)).toEqual([])
	})

	it("GC-5: every surviving object keeps its complete edge set (matches git's topology)", async () => {
		const repo = "gc5-complete-edges"
		await pushFile(fx, repo, { content: "v1\n" })
		await pushFile(fx, repo, { content: "v2\n", force: true })
		const final = await pushFile(fx, repo, { content: "v3\n", force: true })

		// Reconstruct the surviving tip on disk to derive its real-git edge topology —
		// the independent oracle for "complete edge set, nothing wrongly deleted".
		const expectedEdges = await withTempDir("pggit-gc5-oracle-", async (dir) => {
			await spawnGit(["init", "-q"], { cwd: dir })
			await spawnGit(
				["-c", "protocol.version=2", "fetch", repoUrl(fx, repo), "refs/heads/main"],
				{
					cwd: dir,
				},
			)
			expect(
				(await spawnGit(["rev-parse", "FETCH_HEAD"], { cwd: dir })).stdout.trim(),
			).toBe(final.head)
			return gitEdgeRows(dir)
		})

		await fx.gc.gc(repo, { graceSeconds: 0 })

		// Surviving git_edge rows == exactly the reachable topology git derives. This
		// pins BOTH directions: no edge survives for a deleted object, and no edge of a
		// surviving object was wrongly swept.
		expect(await edgeRows(fx.db, repo)).toEqual(expectedEdges)
		// And the dangling anti-join is still clean.
		expect(await danglingEdgeOids(fx.db, repo)).toEqual([])
	})

	// GC-6 — Idempotence: GC∘GC == GC.
	it("GC-6: a second consecutive GC deletes nothing", async () => {
		const repo = "gc6-idempotent-counts"
		await pushFile(fx, repo, { content: "v1\n" })
		await pushFile(fx, repo, { content: "v2\n", force: true })

		const first = await fx.gc.gc(repo, { graceSeconds: 0 })
		expect(first.deletedObjects).toBeGreaterThan(0)

		const second = await fx.gc.gc(repo, { graceSeconds: 0 })
		expect(second).toEqual({ deletedEdges: 0, deletedObjects: 0 })
	})

	it("GC-6: row sets and a clone are byte-identical after the second GC", async () => {
		const repo = "gc6-idempotent-state"
		await pushFile(fx, repo, { content: "v1\n" })
		await pushFile(fx, repo, { content: "v2\n", force: true })
		const final = await pushFile(fx, repo, { content: "v3\n", force: true })

		await fx.gc.gc(repo, { graceSeconds: 0 })
		const objAfter1 = await objectOids(fx.db, repo)
		const edgeAfter1 = await edgeRows(fx.db, repo)
		const refsAfter1 = await fx.refs.listRefs(repo)
		const cloneAfter1 = await cloneAndFsck(fx, repo)

		await fx.gc.gc(repo, { graceSeconds: 0 })
		// Postgres surfaces unchanged by the second run.
		expect(await objectOids(fx.db, repo)).toEqual(objAfter1)
		expect(await edgeRows(fx.db, repo)).toEqual(edgeAfter1)
		expect(await fx.refs.listRefs(repo)).toEqual(refsAfter1)
		// Git surface unchanged: same tip, same object set, same content, fsck-clean.
		const cloneAfter2 = await cloneAndFsck(fx, repo)
		expect(cloneAfter2).toEqual(cloneAfter1)
		expect(cloneAfter2.head).toBe(final.head)
	})

	// GC-7 — Reachable set is exactly git's (graceSeconds: 0).
	it("GC-7: survivors equal git's reachable closure after a force-commit", async () => {
		const repo = "gc7-exact-reachable"
		await pushFile(fx, repo, { content: "v1\n" })
		await pushFile(fx, repo, { content: "v2\n", force: true })
		// The LAST push's source closure is the only reachable set; pushFile returns
		// the real-git `rev-list --objects --all` oracle for that single-commit repo.
		const final = await pushFile(fx, repo, { content: "v3\n", force: true })

		await fx.gc.gc(repo, { graceSeconds: 0 })

		// Neither over- nor under-deletes: Postgres survivor set == git's reachable set.
		expect(await objectOids(fx.db, repo)).toEqual([...final.reachable].sort())
	})

	it("GC-7: survivors include the annotated-tag object and its peeled target", async () => {
		const repo = "gc7-annotated-tag"
		// First, an orphan-producing plain push on main (its objects must be reclaimed).
		await pushFile(fx, repo, { content: "stale\n" })

		// Then a commit + annotated tag, KEEPING the source as the survivor oracle. The
		// tag ref points at the tag OBJECT (peeling to the commit), so the closure must
		// include the tag object itself plus the peeled commit/tree/blob.
		await withTempDir("pggit-gc7-tag-src-", async (src) => {
			await pushCommitAndTag(fx, repo, src, "tagged\n")
			const expected = await gitReachableOids(src) // includes the annotated-tag object

			await fx.gc.gc(repo, { graceSeconds: 0 })

			// Exactly git's reachable set — the annotated-tag object is kept (peeled
			// targets exercised), the stale main objects are gone.
			expect(await objectOids(fx.db, repo)).toEqual(expected)
		})

		// And the served repo still clones clean over both the branch and the tag ref.
		const cloneMain = await cloneAndFsck(fx, repo, "refs/heads/main")
		expect(cloneMain.fileContent).toBe("tagged\n")
		const cloneTag = await cloneAndFsck(fx, repo, "refs/tags/v1")
		expect(cloneTag.fileContent).toBe("tagged\n")
	})

	// GC-5 + GC-7 over a LIVE history that actually exercises commit→parent (kind 2)
	// and tree→subtree (kind 3) edges — the gap the flat single-root examples above
	// leave to the property tests. The live tip is a two-commit chain with a nested
	// `dir/`; a second ref keeps the parent commit reachable (multi-ref), while a
	// prior plain push is orphaned so GC reclaims non-vacuously.
	it("GC-5/GC-7: keeps the full parent+subtree edge topology and exact closure of a nested two-commit history", async () => {
		const repo = "gc57-nested-parent-subtree"
		// Orphan-producing prior push: its flat commit/tree/blob become unreachable once
		// `main` is force-moved to the nested history below, so GC has real work to do.
		await pushFile(fx, repo, { content: "stale\n" })

		await withTempDir("pggit-gc57-src-", async (src) => {
			const { parent, tip } = await pushNested(fx, repo, src)

			// Independent real-git oracles over the kept source: the exact reachable
			// closure (GC-7) and the exact reachable edge topology including kind-2
			// (commit→parent) and kind-3 (tree→subtree) (GC-5), across BOTH refs.
			const expectedOids = await gitReachableOids(src)
			const expectedEdges = await gitEdgeRows(src)
			// Guard the fixture itself: the live history really does carry a parent edge
			// and a nested subtree, else this example would silently test nothing new.
			expect(expectedEdges.some((e) => e.kind === 2)).toBe(true) // commit→parent
			expect(expectedEdges.some((e) => e.kind === 3)).toBe(true) // tree→subtree

			await fx.gc.gc(repo, { graceSeconds: 0 })

			// GC-7: Postgres survivor set == git's reachable closure (parent A reachable
			// via `refs/heads/other`, tip B via `refs/heads/main`); the stale push gone.
			expect(await objectOids(fx.db, repo)).toEqual(expectedOids)
			// GC-5: surviving git_edge rows == git's reachable topology exactly (the
			// kind-2 parent edge and kind-3 subtree edge are kept, none wrongly swept)…
			expect(await edgeRows(fx.db, repo)).toEqual(expectedEdges)
			// …and no surviving edge points at a deleted object.
			expect(await danglingEdgeOids(fx.db, repo)).toEqual([])

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

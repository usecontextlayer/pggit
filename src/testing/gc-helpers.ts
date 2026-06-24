import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { allObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/**
 * Shared scaffolding for the GC behavioural suite
 * (`docs/2026-06-24-force-commit-gc-design.md` §4). Everything here is
 * OBSERVABLE-ONLY: the real `git` oracle (clone/fetch/fsck/rev-list), Postgres
 * rows (`git_object`/`git_edge`), and the `gc()` return value. Nothing probes GC
 * internals (temp tables, batch counts, CTE/transaction shape) — those stay free
 * to change. Grace is made deterministic by controlling `graceSeconds` and
 * `created_at` (see `ageObjects`), never by sleeping on the wall clock.
 */

/** The full per-suite fixture: one real Postgres container + an isolated schema,
 * the object/ref stores, a served git app, and the GC under test. */
export type GcFixture = {
	container: StartedPostgreSqlContainer
	db: IsolatedDb
	server: GitServer
	objects: ObjectStore
	refs: RefStore
	gc: Gc
}

/**
 * Stand up the whole fixture (call in `beforeAll`, timeout 180_000): start
 * Postgres, carve an isolated schema, build the stores + GC over its porsager
 * client, and serve the git app on an ephemeral port. Repos are auto-created on
 * first push, so no repo setup is needed here.
 */
export async function setupGcFixture(): Promise<GcFixture> {
	const container = await startPostgres()
	const db = await createIsolatedSchema(container.getConnectionUri())
	const objects = createObjectStore(db.sql)
	const refs = createRefStore(db.sql)
	const gc = createGc(db.sql)
	const server = await serveOnPort(createGitApp({ objects, refs }), 0)
	return { container, db, gc, objects, refs, server }
}

/** Tear the fixture down (call in `afterAll`): close the server, drop the schema
 * (ends its pooled clients), stop the container. Tolerant of a partial setup. */
export async function teardownGcFixture(fx: Partial<GcFixture>): Promise<void> {
	await fx.server?.close()
	await fx.db?.drop()
	await fx.container?.stop()
}

/** The smart-HTTP URL of `repo` on the fixture's server (repo auto-created on
 * first push). */
export function repoUrl(fx: Pick<GcFixture, "server">, repo: string): string {
	return `http://127.0.0.1:${fx.server.port}/${repo}`
}

/** Run `fn` inside a fresh `mkdtemp` dir, always removing it afterwards. The
 * canonical "temp git workdir" wrapper so callers never leak dirs on a throw. */
export async function withTempDir<T>(
	prefix: string,
	fn: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	try {
		return await fn(dir)
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

/** Options for one push: the file written and whether to `--force` the push.
 *
 * Force-commit (the §1 workload) is modelled by `force: true` from an INDEPENDENT
 * source repo: a fresh root commit whose tree/blob differ from the prior push, so
 * the ref moves to a non-descendant and the old objects are orphaned — no literal
 * `--amend` needed, and pggit accepts the non-ff via CAS (refs-store). The first
 * push of a repo needs no force; every subsequent force-commit does. */
export type PushOpts = {
	path?: string
	content: string
	force?: boolean
}

/** What a push produced: the new HEAD oid and the full reachable object closure
 * of the source repo at that tip (the GC-1/GC-7 survivor oracle). */
export type PushResult = { head: string; reachable: string[] }

/**
 * Push a single-file commit to `refs/heads/main` from a throwaway source repo,
 * then DISCARD the source dir. `force` sends it as a non-ff `push --force`.
 * Returns the new HEAD oid and the real-git reachable closure of that single-
 * commit repo (its commit, tree, and blob) — exactly the objects GC must keep
 * for this tip. Because the source dir is discarded each call, a later
 * force-commit's orphaned objects survive only in Postgres, where GC reclaims
 * them.
 */
export async function pushFile(
	fx: Pick<GcFixture, "server">,
	repo: string,
	opts: PushOpts,
): Promise<PushResult> {
	return withTempDir("pggit-gc-src-", async (src) => {
		const url = repoUrl(fx, repo)
		const path = opts.path ?? "file.txt"
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, path), opts.content)
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c"], { cwd: src })
		const pushArgs = opts.force
			? ["push", "--force", url, "HEAD:refs/heads/main"]
			: ["push", url, "HEAD:refs/heads/main"]
		await spawnGit(pushArgs, { cwd: src })
		const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		const reachable = await gitReachableOids(src)
		return { head, reachable }
	})
}

/** The result of cloning/fetching a ref back: the FETCH_HEAD oid, the full sorted
 * object set fetched, and the checked-out content of `file`. fsck has already
 * passed (this throws otherwise). */
export type CloneResult = { head: string; objects: string[]; fileContent: string }

/**
 * Fetch `ref` (default `refs/heads/main`) into a throwaway back dir, run
 * `fsck --full` (throws on any corruption/dangling), and return the FETCH_HEAD
 * oid, the fetched object set, and the checked-out `file` content. The canonical
 * "the repo still clones clean" check — use it before AND after GC to prove
 * liveness preserved (GC-1) and idempotence (GC-6). The back dir is discarded.
 */
export async function cloneAndFsck(
	fx: Pick<GcFixture, "server">,
	repo: string,
	ref = "refs/heads/main",
	file = "file.txt",
): Promise<CloneResult> {
	return withTempDir("pggit-gc-back-", async (back) => {
		const url = repoUrl(fx, repo)
		await spawnGit(["init", "-q"], { cwd: back })
		await spawnGit(["-c", "protocol.version=2", "fetch", url, ref], { cwd: back })
		await spawnGit(["fsck", "--full"], { cwd: back })
		const head = (
			await spawnGit(["rev-parse", "FETCH_HEAD"], { cwd: back })
		).stdout.trim()
		const objects = await allObjectOids(back)
		await spawnGit(["checkout", "-q", "FETCH_HEAD"], { cwd: back })
		const fileContent = readFileSync(join(back, file), "utf8")
		return { fileContent, head, objects }
	})
}

/**
 * The real-git reachable object closure of an on-disk repo — every commit, tree,
 * blob, AND annotated-tag object reachable from any ref. `rev-list --objects
 * --all` yields commits/trees/blobs reachable from refs; `--all` includes tag
 * refs but lists their PEELED target, so the annotated-tag objects themselves are
 * added separately via `--all --objects` over `for-each-ref`'s tag oids. This is
 * the independent expected-survivors oracle for GC-7/PBT-1 (compare to the
 * surviving `git_object` rows under `graceSeconds: 0`).
 */
export async function gitReachableOids(dir: string): Promise<string[]> {
	const revList = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
	const oids = new Set<string>()
	for (const line of revList.stdout.trim().split("\n")) {
		if (!line) continue
		// `--objects` lines are `<oid>` or `<oid> <path>` — take the leading oid.
		const oid = line.split(" ", 1)[0]
		if (oid) oids.add(oid)
	}
	// Annotated-tag OBJECTS: `rev-list --objects --all` lists a tag ref's peeled
	// target, not the tag object, so add every ref oid that is itself a tag object.
	const refLines = await spawnGit(
		["for-each-ref", "--format=%(objecttype) %(objectname)"],
		{ cwd: dir },
	)
	for (const line of refLines.stdout.trim().split("\n")) {
		const [type, oid] = line.split(" ")
		if (type === "tag" && oid) oids.add(oid)
	}
	return [...oids].sort()
}

/** Every `git_object` OID (hex) stored for `repo`, sorted — the Postgres survivor
 * set. Compare to `gitReachableOids` for the GC-7 differential. */
export async function objectOids(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<string[]> {
	const rows = await db.sql<{ oid: string }[]>`
		select encode(o.oid, 'hex') as oid
		from git_object o
		join repos r on r.id = o.repo_id
		where r.name = ${repo}
		order by oid
	`
	return rows.map((row) => row.oid)
}

/** `git_object` row count for `repo` — the storage-bound observable (GC-4/PBT-2:
 * over K amend+GC cycles this must not grow with K). */
export async function countObjects(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<number> {
	const [row] = await db.sql<{ n: number }[]>`
		select count(*)::int as n
		from git_object o
		join repos r on r.id = o.repo_id
		where r.name = ${repo}
	`
	return row?.n ?? 0
}

/** One stored edge as hex `{parent, child, kind}`. */
export type EdgeRow = { parent: string; child: string; kind: number }

/** Every `git_edge` row for `repo` as hex `{parent, child, kind}`, sorted — for
 * the dangling-edge / object⟺edges invariant (GC-5). */
export async function edgeRows(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<EdgeRow[]> {
	const rows = await db.sql<EdgeRow[]>`
		select encode(e.parent, 'hex') as parent,
		       encode(e.child, 'hex') as child,
		       e.kind as kind
		from git_edge e
		join repos r on r.id = e.repo_id
		where r.name = ${repo}
		order by parent, child, kind
	`
	return rows.map((row) => ({ child: row.child, kind: row.kind, parent: row.parent }))
}

/** `git_edge` row count for `repo`. */
export async function countEdges(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<number> {
	const [row] = await db.sql<{ n: number }[]>`
		select count(*)::int as n
		from git_edge e
		join repos r on r.id = e.repo_id
		where r.name = ${repo}
	`
	return row?.n ?? 0
}

/**
 * Age EVERY `git_object` row of `repo` by shifting its `created_at` back by a
 * Postgres interval (e.g. `"1 hour"`, `"30 minutes"`). Deterministic substitute
 * for a wall-clock wait: after this, a row is "older than `graceSeconds`" without
 * any sleep. Use it to push the unreachable set past the grace cutoff so
 * `graceSeconds: 0` (or a small value) reclaims it while a huge `graceSeconds`
 * still retains it (GC-3).
 */
export async function ageObjects(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
	intervalSql: string,
): Promise<void> {
	await db.sql`
		update git_object
		set created_at = created_at - ${intervalSql}::interval
		where repo_id = (select id from repos where name = ${repo})
	`
}

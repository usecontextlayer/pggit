import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { ZERO_OID } from "@/object/oid"
import type { GitServer } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { allObjectOids, gitReachableOids } from "@/testing/git-fixtures"
import {
	repoUrl as gitServerRepoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

/**
 * Shared scaffolding for the GC behavioural suite
 * (`docs/2026-06-24-force-commit-gc-design.md` §4). Everything here is
 * OBSERVABLE-ONLY: the real `git` oracle (clone/fetch/fsck/rev-list), Postgres
 * rows (`git_object` + the derived `git_commit`/`git_tag`), and the `gc()` return value. Nothing probes GC
 * internals (temp tables, batch counts, CTE/transaction shape) — those stay free
 * to change. Grace is made deterministic by controlling `graceSeconds` and
 * `created_at` (see `ageObjects`), never by sleeping on the wall clock.
 */

/** The full per-suite fixture: an isolated schema on the shared `globalSetup` Postgres
 * container, the object/ref stores, a served git app, and the GC under test. */
export type GcFixture = {
	db: IsolatedDb
	server: GitServer
	objects: ObjectStore
	refs: RefStore
	gc: Gc
}

/**
 * Stand up the fixture (call in `beforeAll`, or per-candidate in a property): carve a
 * FRESH isolated schema (its OWN table partitions) out of the shared
 * `globalSetup` Postgres container (`pgBaseUrl`), build the stores + GC over its
 * porsager client, and serve the git app on an ephemeral port. Repos are auto-created
 * on first push, so no repo setup is needed here. The shared container is owned — and
 * stopped — by `globalSetup`, so there is no per-fixture container to tear down.
 *
 * One schema PER call is load-bearing for the stress suite: a property that seeds + GCs
 * many large repos into ONE schema lets every candidate's rows pile into the next
 * candidate's GC, and the accumulated partition skews the planner's `repo_id`/`created_at`
 * statistics until the sweep's anti-join flips from a hash-anti-join to a per-row nested
 * loop (orders of magnitude slower). A fresh schema per candidate keeps each GC's stats
 * representative. See the gc-stress suite.
 */
export async function setupGcFixture(): Promise<GcFixture> {
	const { db, deps, server } = await setupGitServerFixture()
	const { objects, refs } = deps
	const gc = createGc(db.sql)
	return { db, gc, objects, refs, server }
}

/** Tear the fixture down (call in `afterAll`, or per-candidate): close the server and
 * drop the schema (which ends its pooled clients). The shared container is left running
 * — `globalSetup` stops it once, after the whole run. */
export async function teardownGcFixture(fixture: GcFixture): Promise<void> {
	await teardownGitServerFixture(fixture)
}

/** The smart-HTTP URL of `repo` on the fixture's server (repo auto-created on
 * first push). */
export function repoUrl(fixture: Pick<GcFixture, "server">, repo: string): string {
	return gitServerRepoUrl(fixture.server, repo)
}

/** The file one push writes — the options `pushFile` and `pushDenied` share. */
type PushContent = {
	path?: string
	content: string
}

/** `pushFile`'s options: the file written, and whether to REWIND the ref to
 * the new (non-descendant) commit at the STORE level afterwards.
 *
 * The wire refuses non-fast-forward moves, but the STORE still executes any
 * CAS-valid ref move. Rewound states remain reachable through operator surgery,
 * and the GC suites need to test the store-level workload "the ref moved to a
 * non-descendant; the old closure is orphaned" independently of push policy.
 * Mechanically, the new root is pushed to a throwaway ref, `main` is CAS-moved to
 * it through the store, and the throwaway ref is store-deleted. The denied-push
 * orphan flow is covered separately by `pushDenied` (`gc/denied-push`,
 * `gc/integrity`). */
type PushOptions = PushContent & {
	rewind?: boolean
}

/** What a push produced: the new HEAD oid and the full reachable object closure
 * of the source repo at that tip (the GC-1/GC-7 survivor oracle). */
export type PushResult = { head: string; reachable: string[] }

/**
 * Push a single-file commit to `refs/heads/main` from a throwaway source repo,
 * then DISCARD the source dir. Returns the new HEAD oid and the real-git
 * reachable closure of that single-commit repo (its commit, tree, and blob) —
 * exactly the objects GC must keep for this tip.
 */
export async function pushFile(
	fixture: Pick<GcFixture, "server" | "refs">,
	repo: string,
	options: PushOptions,
): Promise<PushResult> {
	return withTempDir("pggit-gc-src-", async (sourceDirectory) => {
		const url = repoUrl(fixture, repo)
		const path = options.path ?? "file.txt"
		await spawnGit(["init", "-q", "-b", "main"], { cwd: sourceDirectory })
		writeFileSync(join(sourceDirectory, path), options.content)
		await spawnGit(["add", "."], { cwd: sourceDirectory })
		await spawnGit(["commit", "-q", "-m", "c"], { cwd: sourceDirectory })
		const head = (
			await spawnGit(["rev-parse", "HEAD"], { cwd: sourceDirectory })
		).stdout.trim()
		if (options.rewind) {
			// Land the objects via a throwaway CREATE, then rewind `main` through
			// the store (see PushOptions.rewind for why this bypasses the wire policy).
			const temporaryRef = `refs/heads/rewind-${head.slice(0, 12)}`
			await spawnGit(["push", url, `HEAD:${temporaryRef}`], { cwd: sourceDirectory })
			const current = (await fixture.refs.listRefs(repo)).find(
				(ref) => ref.name === "refs/heads/main",
			)
			// A rewind's whole point is orphaning an EXISTING tip; falling back to a
			// create here would silently under-exercise the GC workload.
			if (!current) {
				throw new Error(
					`pushFile rewind: refs/heads/main missing in ${repo} — seed the ref before rewinding it`,
				)
			}
			const moved = await fixture.refs.applyRefUpdates(
				repo,
				[
					{
						newOid: head,
						oldOid: current.oid,
						ref: "refs/heads/main",
					},
					{ newOid: ZERO_OID, oldOid: head, ref: temporaryRef },
				],
				false,
			)
			if (moved.some((ok) => !ok)) {
				throw new Error(`pushFile rewind: store ref updates failed (${moved})`)
			}
		} else {
			await spawnGit(["push", url, "HEAD:refs/heads/main"], {
				cwd: sourceDirectory,
			})
		}
		const reachable = await gitReachableOids(sourceDirectory)
		return { head, reachable }
	})
}

/**
 * Push a fresh single-file root commit to `refs/heads/<name>` from a throwaway
 * source (then discard it) — the side-branch creator, the suites' one ADDITIVE
 * op (new objects, nothing orphaned). `pushFile` only ever targets
 * `refs/heads/main`, so a side branch needs this raw push; it mirrors
 * `pushFile`'s "independent root, discard the source" shape so the branch's
 * objects survive only in Postgres (where a later store-level delete orphans
 * them). Plain push — the fresh ref is a CREATE, which the deny-non-FF wire
 * policy allows.
 */
export async function pushBranch(
	fixture: Pick<GcFixture, "server">,
	repo: string,
	branch: string,
	content: string,
): Promise<void> {
	await withTempDir("pggit-gcsch-br-", async (src) => {
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, `${branch}.txt`), content)
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c"], { cwd: src })
		await spawnGit(["push", repoUrl(fixture, repo), `HEAD:refs/heads/${branch}`], {
			cwd: src,
		})
	})
}

/**
 * Denied-push orphan generator: attempt a `push --force` of an INDEPENDENT root
 * commit and expect the server to report `ng` (`non-fast-forward`). The wire
 * protocol ingests the pack
 * BEFORE the policy pass, so the denied push's objects land in Postgres as
 * unreachable orphans while the ref stays untouched — exactly the garbage GC
 * exists to reclaim. Returns the denied tip and its would-be closure (the
 * orphan oracle). Throws if the push unexpectedly SUCCEEDS.
 */
export async function pushDenied(
	fixture: Pick<GcFixture, "server">,
	repo: string,
	options: PushContent,
): Promise<PushResult> {
	return withTempDir("pggit-gc-denied-", async (sourceDirectory) => {
		const url = repoUrl(fixture, repo)
		const path = options.path ?? "file.txt"
		await spawnGit(["init", "-q", "-b", "main"], { cwd: sourceDirectory })
		writeFileSync(join(sourceDirectory, path), options.content)
		await spawnGit(["add", "."], { cwd: sourceDirectory })
		await spawnGit(["commit", "-q", "-m", "c"], { cwd: sourceDirectory })
		const push = await attemptGit(
			["push", "--force", url, "HEAD:refs/heads/main"],
			sourceDirectory,
		)
		if (push.ok) {
			throw new Error("pushDenied: the force push unexpectedly succeeded")
		}
		if (!/non-fast-forward/i.test(push.stderr)) {
			throw new Error(`pushDenied: unexpected git failure: ${push.stderr.trim()}`)
		}
		const head = (
			await spawnGit(["rev-parse", "HEAD"], { cwd: sourceDirectory })
		).stdout.trim()
		const reachable = await gitReachableOids(sourceDirectory)
		return { head, reachable }
	})
}

/** The result of cloning/fetching a ref back: the FETCH_HEAD oid, the full sorted
 * object set fetched, and the checked-out content of `filePath`. fsck has already
 * passed (this throws otherwise). */
type CloneResult = { head: string; objects: string[]; fileContent: string }

/**
 * Fetch `refName` (default `refs/heads/main`) into a throwaway clone directory, run
 * `fsck --full` (throws on any corruption/dangling), and return the FETCH_HEAD
 * oid, the fetched object set, and the checked-out `filePath` content. The canonical
 * "the repo still clones clean" check — use it before AND after GC to prove
 * liveness preserved (GC-1) and idempotence (GC-6). The clone directory is discarded.
 */
export async function cloneAndFsck(
	fixture: Pick<GcFixture, "server">,
	repo: string,
	refName = "refs/heads/main",
	filePath = "file.txt",
): Promise<CloneResult> {
	return withTempDir("pggit-gc-back-", async (cloneDirectory) => {
		const url = repoUrl(fixture, repo)
		await spawnGit(["init", "-q"], { cwd: cloneDirectory })
		await spawnGit(["-c", "protocol.version=2", "fetch", url, refName], {
			cwd: cloneDirectory,
		})
		await spawnGit(["fsck", "--full"], { cwd: cloneDirectory })
		const head = (
			await spawnGit(["rev-parse", "FETCH_HEAD"], { cwd: cloneDirectory })
		).stdout.trim()
		const objects = await allObjectOids(cloneDirectory)
		await spawnGit(["checkout", "-q", "FETCH_HEAD"], { cwd: cloneDirectory })
		const fileContent = readFileSync(join(cloneDirectory, filePath), "utf8")
		return { fileContent, head, objects }
	})
}

/** Canonical git's reachable OIDs after fetching the served `main` ref. */
export async function servedMainReachableOids(
	fixture: Pick<GcFixture, "server">,
	repo: string,
): Promise<string[]> {
	return withTempDir("pggit-reachable-main-", async (dir) => {
		await spawnGit(["init", "-q"], { cwd: dir })
		await spawnGit(
			["-c", "protocol.version=2", "fetch", repoUrl(fixture, repo), "refs/heads/main"],
			{ cwd: dir },
		)
		await spawnGit(["update-ref", "refs/heads/main", "FETCH_HEAD"], { cwd: dir })
		return gitReachableOids(dir)
	})
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
	if (row === undefined)
		throw new Error(`countObjects: aggregate returned no row for ${repo}`)
	return row.n
}

/**
 * The derived `git_commit`/`git_tag` rows for `repo` in ONE canonical sorted
 * text form — `commit <oid> tree=<t> parents=<p1,p2> time=<epoch>` /
 * `tag <oid> target=<t> type=<code>` — so suites can snapshot and diff the whole
 * object⟺derived-rows surface with plain array equality (GC-5).
 */
export async function derivedRows(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<string[]> {
	const commits = await db.sql<{ line: string }[]>`
		select 'commit ' || encode(c.oid, 'hex')
			|| ' tree=' || encode(c.tree_oid, 'hex')
			|| ' parents=' || coalesce(
				(select string_agg(encode(p.h, 'hex'), ',' order by p.ord)
					from unnest(c.parents) with ordinality as p(h, ord)), '')
			|| ' time=' || c.commit_time as line
		from git_commit c
		join repos r on r.id = c.repo_id
		where r.name = ${repo}
	`
	const tags = await db.sql<{ line: string }[]>`
		select 'tag ' || encode(t.oid, 'hex')
			|| ' target=' || encode(t.target_oid, 'hex')
			|| ' type=' || t.target_type as line
		from git_tag t
		join repos r on r.id = t.repo_id
		where r.name = ${repo}
	`
	return [...commits, ...tags].map((r) => r.line).sort()
}

/** Derived-row count (`git_commit` + `git_tag`) for `repo`. */
export async function countDerivedRows(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<number> {
	const [row] = await db.sql<{ n: number }[]>`
		select (select count(*) from git_commit c join repos r on r.id = c.repo_id where r.name = ${repo})::int
			+ (select count(*) from git_tag t join repos r on r.id = t.repo_id where r.name = ${repo})::int as n
	`
	if (row === undefined) {
		throw new Error(`countDerivedRows: aggregate returned no row for ${repo}`)
	}
	return row.n
}

/** Commit/tag OBJECTS with no derived row, plus derived rows whose object is
 * gone — both directions of the object⟺derived-rows invariant in one probe.
 * MUST come back empty after any pass: the first direction is "every stored
 * commit has its derived row", the second is the 0009 FK cascade doing GC's
 * bookkeeping. (The stray direction is DDL-guaranteed; asserting it pins the
 * cascade wiring against a future migration regression.) */
export async function derivedRowViolations(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<string[]> {
	const rows = await db.sql<{ oid: string }[]>`
		select 'row-missing:' || encode(o.oid, 'hex') as oid
		from git_object o join repos r on r.id = o.repo_id
		where r.name = ${repo} and (
			(o.type = 1 and not exists (
				select 1 from git_commit c where c.repo_id = o.repo_id and c.oid = o.oid))
			or (o.type = 4 and not exists (
				select 1 from git_tag t where t.repo_id = o.repo_id and t.oid = o.oid)))
		union all
		select 'object-missing:' || encode(c.oid, 'hex') as oid
		from git_commit c join repos r on r.id = c.repo_id
		where r.name = ${repo} and not exists (
			select 1 from git_object o where o.repo_id = c.repo_id and o.oid = c.oid)
		union all
		select 'object-missing:' || encode(t.oid, 'hex') as oid
		from git_tag t join repos r on r.id = t.repo_id
		where r.name = ${repo} and not exists (
			select 1 from git_object o where o.repo_id = t.repo_id and o.oid = t.oid)
		order by oid
	`
	return rows.map((row) => row.oid)
}

async function requireExistingRepoId(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<string> {
	const [row] = await db.sql<{ id: string }[]>`
		select id::text as id from repos where name = ${repo}
	`
	if (row === undefined) {
		throw new Error(
			`GC test helper requires repo ${JSON.stringify(repo)} to exist; use repoGcState for presence`,
		)
	}
	return row.id
}

/**
 * The repo's `git_pack_encoding` rows in ONE canonical sorted text form —
 * `<oid> base=<hex|whole> size=<n> data=<md5>` — so suites can prove rows were
 * created, and that a later pass left existing rows BYTE-IDENTICAL (SCH-R2,
 * repack's frozen policy observed through the drain), with plain array
 * equality. The md5 is Postgres's, over the stored deflated bytes.
 */
export async function encodingRows(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<string[]> {
	const repoId = await requireExistingRepoId(db, repo)
	const rows = await db.sql<{ line: string }[]>`
		select encode(e.oid, 'hex')
			|| ' base=' || coalesce(encode(e.base_oid, 'hex'), 'whole')
			|| ' size=' || e.data_size
			|| ' data=' || md5(e.data) as line
		from git_pack_encoding e
		where e.repo_id = ${repoId}::bigint
	`
	return rows.map((r) => r.line).sort()
}

/** Coverage violations of the encoding tier for `repo` — both directions of the
 * object⟺encoding invariant a repack-enabled drain owes (SCH-R1): a sub-cap
 * `git_object` with no encoding row (`row-missing:<oid>`), and an encoding row
 * whose object is gone (`object-missing:<oid>` — DDL-guaranteed by the 0008
 * cascades; asserting it pins the wiring, exactly like `derivedRowViolations`).
 * MUST come back empty after a repack-enabled drain covers a repo. */
export async function encodingViolations(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<string[]> {
	const repoId = await requireExistingRepoId(db, repo)
	const rows = await db.sql<{ oid: string }[]>`
		select 'row-missing:' || encode(o.oid, 'hex') as oid
		from git_object o
		where o.repo_id = ${repoId}::bigint and o.size < ${MAX_INLINE_BYTEA_BYTES}
			and not exists (
				select 1 from git_pack_encoding e
				where e.repo_id = o.repo_id and e.oid = o.oid)
		union all
		select 'object-missing:' || encode(e.oid, 'hex') as oid
		from git_pack_encoding e
		where e.repo_id = ${repoId}::bigint and not exists (
			select 1 from git_object o where o.repo_id = e.repo_id and o.oid = e.oid)
		order by oid
	`
	return rows.map((row) => row.oid)
}

/** The repo's `last_repack_at` watermark — non-null iff a repack pass COMPLETED
 * for it (`repack()` stamps it itself on success; the drain never writes it).
 * Presence belongs to `repoGcState`; this focused helper requires the repo. */
export async function repoRepackStamp(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<Date | null> {
	const [row] = await db.sql<{ last_repack_at: Date | null }[]>`
		select last_repack_at from repos where name = ${repo}
	`
	if (row === undefined) {
		throw new Error(
			`repoRepackStamp: repo ${JSON.stringify(repo)} does not exist; use repoGcState for presence`,
		)
	}
	return row.last_repack_at
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

/** The repo's presence plus its two GC-scheduling timestamps — the durable activity
 * signal the background drain polls (docs/2026-06-24-gc-scheduler-design.md §2).
 * An absent row is distinct from a present row whose timestamp is not yet set.
 * Observable surface for SCH-1/SCH-2 (a push stamps `last_pushed_at`) and
 * SCH-3/SCH-4 (a drain advances `last_gc_at`). */
export type RepoGcState =
	| { kind: "absent" }
	| { kind: "present-unpushed" }
	| { kind: "pushed-never-drained"; pushedAt: Date }
	| { kind: "pushed-and-drained"; pushedAt: Date; gcAt: Date }

export async function repoGcState(
	db: Pick<IsolatedDb, "sql">,
	repo: string,
): Promise<RepoGcState> {
	const [row] = await db.sql<{ last_pushed_at: Date | null; last_gc_at: Date | null }[]>`
		select last_pushed_at, last_gc_at from repos where name = ${repo}
	`
	if (row === undefined) return { kind: "absent" }
	if (row.last_pushed_at === null) {
		if (row.last_gc_at !== null) {
			throw new Error(`repoGcState: ${repo} was drained without ever being pushed`)
		}
		return { kind: "present-unpushed" }
	}
	if (row.last_gc_at === null) {
		return { kind: "pushed-never-drained", pushedAt: row.last_pushed_at }
	}
	return {
		gcAt: row.last_gc_at,
		kind: "pushed-and-drained",
		pushedAt: row.last_pushed_at,
	}
}

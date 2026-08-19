import type { Sql, TransactionSql } from "postgres"
import { type Database, initKysely } from "@/database"
import { type CopyValue, copyInsert } from "@/database/copy-insert"
import type { ReposId } from "@/database/models/public/Repos"
import type { FileDiff, FileEntry } from "@/object/tree-diff"
import { ancestry } from "@/store/reachability"
import { createRepoResolver, type RepoResolver } from "@/store/repo-resolver"

export type RepoFileProjection = ReturnType<typeof createRepoFileProjection>

/** Row-write batches for the incremental path (value-list binds; one bind per
 * element, wire cap 65,534). */
const APPLY_BATCH = 1000

/** How the walking side of a push projection is supplied (spine chunk 4): the
 * SQL half (this module) decides WHICH plan applies — no-op, full rebuild,
 * incremental diff, or skip — under the branch's lock, and calls back for the
 * tree-walk half it needs. `fullList` is the whole tip (`buildFileList`);
 * `diffFrom(basisCommit)` is the file-level difference basis→tip
 * (`diffFileLists`). */
export type ProjectionPlanner = {
	fullList: () => Promise<{ files: FileEntry[] }>
	diffFrom: (basisCommit: string) => Promise<FileDiff>
}

/** What one push projection did — surfaced for tests/observability; callers
 * ignore it. `skipped` is the monotonic guard: a newer push already projected
 * past this oid, and rebuilding backwards is the race this table exists to end. */
export type ApplyOutcome = "noop" | "rebuilt" | "diffed" | "skipped"

/**
 * Write-only maintainer of `repo_file`: the slim per-branch-tip `path → (mode,
 * blob_oid)` index that IS pggit's public read surface. Reads never go through this
 * module — a consumer queries `repo_file ⋈ git_object` (on `oid = blob_oid`) with
 * direct SQL, the one read mechanism (docs/2026-06-26-read-surface-sharpening-design.md).
 * It is a derived projection of the canonical objects — no duplicate blob bytes, no
 * orphan reaper — droppable and rebuildable at will.
 *
 * Maintenance is DIFF-DRIVEN since spine chunk 4: `repo_file_head` persists which
 * commit each branch's rows reflect, and a push moves the projection FORWARD from
 * that basis — never rebuilds backwards, never infers the basis from the push
 * command (R12: an inferred basis makes a torn projection representable). A
 * one-file push writes a handful of rows instead of two full snapshots.
 */
export function createRepoFileProjection(pg: Sql, repoResolver?: RepoResolver) {
	const db = initKysely<Database>(pg)
	const repos = repoResolver ?? createRepoResolver(db)

	return {
		/**
		 * Bring `refName`'s snapshot to `newOid` (R13). The plan is decided and the
		 * trees are walked OUTSIDE any transaction — the walks read through the
		 * shared pool, and holding a pool connection open while borrowing more from
		 * the same pool is a self-deadlock at `max: 1` and a starvation wedge under
		 * concurrent pushes at any size. The WRITE phase is then one short,
		 * read-free transaction, serialized per branch by an advisory xact lock
		 * (the head row's FOR UPDATE alone cannot serialize the
		 * not-yet-existing-row case), which RE-CHECKS the basis under the lock: if
		 * another push advanced it while we walked, the walk is stale and the whole
		 * decision re-runs against the new basis. Per attempt:
		 *   head = newOid            → no-op (idempotent replay);
		 *   head absent              → full rebuild + insert head (first sync, new
		 *                              branch, post-clearRepo — one path);
		 *   newOid descends from head → apply the diff, advance head;
		 *   otherwise                → SKIP: a newer push already projected past us.
		 *                              Never rebuild backwards — and never
		 *                              "defensively" rebuild from newOid, which would
		 *                              reintroduce the backwards-move race.
		 */
		async applyRefAdvance(
			repoId: string,
			refName: string,
			newOid: string,
			planner: ProjectionPlanner,
		): Promise<ApplyOutcome> {
			const id = await repos.ensureRepoId(repoId)
			const readBasis = async (): Promise<string | null> => {
				const [row] = await pg<{ commit: string }[]>`
					select encode(commit_oid, 'hex') as commit from repo_file_head
					where repo_id = ${id}::bigint and ref_name = ${refName}`
				return row?.commit ?? null
			}

			// Bounded retries: a basis moving mid-walk needs a concurrent push to the
			// SAME branch landing inside our walk window — rare, and each retry walks
			// from the fresher basis, so progress is monotone.
			for (let attempt = 0; attempt < 3; attempt++) {
				const basis = await readBasis()
				if (basis === newOid) return "noop"

				// The descendant guard (one ancestry probe over the commit rows). The
				// basis commit is reachable from the live tip whenever this passes, so
				// its object — and every tree the diff walks — is GC-safe.
				if (basis !== null) {
					const forward = await ancestry(db, id, newOid, [Buffer.from(basis, "hex")])
					if (!forward) return "skipped"
				}
				const plan =
					basis === null
						? { files: (await planner.fullList()).files, kind: "rebuilt" as const }
						: { diff: await planner.diffFrom(basis), kind: "diffed" as const }

				const outcome = await pg.begin(async (tx): Promise<ApplyOutcome | "stale"> => {
					await tx`select pg_advisory_xact_lock(hashtextextended(${`${id}/${refName}`}, 0))`
					const [head] = await tx<{ commit: string }[]>`
						select encode(commit_oid, 'hex') as commit from repo_file_head
						where repo_id = ${id}::bigint and ref_name = ${refName} for update`
					if ((head?.commit ?? null) !== basis) return "stale"

					if (plan.kind === "rebuilt") {
						await replaceBranchRows(tx, id, refName, plan.files)
						await tx`insert into repo_file_head (repo_id, ref_name, commit_oid)
							values (${id}::bigint, ${refName}, ${Buffer.from(newOid, "hex")})`
						return "rebuilt"
					}
					for (let i = 0; i < plan.diff.removed.length; i += APPLY_BATCH) {
						const chunk = plan.diff.removed.slice(i, i + APPLY_BATCH)
						await tx`delete from repo_file
							where repo_id = ${id}::bigint and ref_name = ${refName}
								and path = any(${chunk})`
					}
					for (let i = 0; i < plan.diff.upserts.length; i += APPLY_BATCH) {
						const chunk = plan.diff.upserts.slice(i, i + APPLY_BATCH)
						await tx`insert into repo_file (repo_id, ref_name, path, mode, blob_oid)
							select ${id}::bigint, ${refName}, u.path, u.mode, decode(u.blob, 'hex')
							from unnest(
								${chunk.map((f) => f.path)}::text[],
								${chunk.map((f) => f.mode)}::text[],
								${chunk.map((f) => f.blobOid)}::text[]
							) as u(path, mode, blob)
							on conflict (repo_id, ref_name, path)
								do update set mode = excluded.mode, blob_oid = excluded.blob_oid`
					}
					await tx`update repo_file_head set commit_oid = ${Buffer.from(newOid, "hex")}
						where repo_id = ${id}::bigint and ref_name = ${refName}`
					return "diffed"
				})
				if (outcome !== "stale") return outcome
			}
			throw new Error(
				`repo-view: projection basis for ${repoId} ${refName} moved on every attempt — concurrent pushes are outrunning the walk`,
			)
		},

		/** Drop a repo's entire projection (all branches + their recorded bases) —
		 * the clean slate for a full rebuild. No blob bytes to reap. */
		async clearRepo(repoId: string): Promise<void> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return
			await pg.begin(async (tx) => {
				await tx`delete from repo_file where repo_id = ${id}::bigint`
				await tx`delete from repo_file_head where repo_id = ${id}::bigint`
			})
		},

		/** Drop `refName`'s snapshot and its recorded basis (branch deleted). */
		async dropRefSnapshot(repoId: string, refName: string): Promise<void> {
			const id = await repos.resolveRepoId(repoId)
			if (id === null) return
			await pg.begin(async (tx) => {
				await tx`delete from repo_file
					where repo_id = ${id}::bigint and ref_name = ${refName}`
				await tx`delete from repo_file_head
					where repo_id = ${id}::bigint and ref_name = ${refName}`
			})
		},
	}

	/** Replace a branch's rows wholesale (the full-rebuild path — today's code,
	 * verbatim in shape): COPY into staging has no bind-parameter ceiling, so a
	 * tip with any file count lands in a single statement. */
	async function replaceBranchRows(
		tx: TransactionSql,
		id: ReposId,
		refName: string,
		files: FileEntry[],
	): Promise<void> {
		const rows: CopyValue[][] = files.map((f) => [
			{ t: "int8", v: id },
			{ t: "text", v: refName },
			{ t: "text", v: f.path },
			{ t: "text", v: f.mode },
			{ t: "bytea", v: Buffer.from(f.blobOid, "hex") },
		])
		await tx`delete from repo_file where repo_id = ${id}::bigint and ref_name = ${refName}`
		await copyInsert(
			tx,
			"repo_file",
			["repo_id", "ref_name", "path", "mode", "blob_oid"],
			rows,
		)
	}
}

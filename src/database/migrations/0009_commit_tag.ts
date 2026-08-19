import { type Kysely, sql } from "kysely"
import { OBJECT_TYPE_CODE } from "@/database/object-type-codes"
import { computeGenerations } from "@/object/commit-graph"
import { deriveCommitRow, deriveTagRow } from "@/object/derive"
import { PACK_OBJ_TYPE } from "@/pack/object-header"

// The derived-state spine, chunk 1 (docs/2026-08-17-derived-state-spine-design.md):
// one row per commit and per annotated tag, derived from `git_object.content` (the
// raw-content authority, D1) at ingest and backfilled here for pre-existing repos.
//
// `git_commit.parents` is ORDERED (content order) — the kind-2 edge SET threw
// parent order away, which is why repack re-parsed every commit body; the ordered
// array is the honest data structure. `generation` is `1 + max(gen(parents))`,
// computed at ingest in one topological pass; NULL ≡ infinity ("no pruning") and
// is ABSORBING — never recomputed when a missing parent arrives later. The finite
// region carries the strict `gen(parent) < gen(child)` invariant the frontier's
// exactness rests on (chunk 2). `commit_time` is the committer epoch — the
// frontier's tiebreak within and without generation regions.
//
// Both tables take the delete-aware reloptions profile (0005/0008): their rows die
// by FK cascade on every GC pass, so 0003's insert-only profile is exactly wrong
// here. No child-direction (secondary) index on either — nothing walks upward;
// every walk enters by PK. Hygiene is DDL (D7/D14 extended): the cascade onto
// `git_object` removes a reclaimed object's row inside the same DELETE.
//
// KEPT IN STEP: `git_edge` derivation continues unchanged through slice S1 (the
// closure still walks it); S2 retires it.

const COMMIT_TAG_PARTITIONS = 16

// The 0008 delete-aware leaf profile. `parents` / `tree_oid` are varlena, so a
// TOAST relation exists and the toast.* keys are meaningful (octopus parents can
// TOAST), even though typical rows stay inline.
const LEAF_RELOPTS = [
	"fillfactor = 100",
	"autovacuum_vacuum_insert_scale_factor = 0.0",
	"autovacuum_vacuum_insert_threshold = 10000",
	"autovacuum_vacuum_scale_factor = 0.02",
	"autovacuum_vacuum_threshold = 1000",
	"autovacuum_vacuum_cost_delay = 0",
	"autovacuum_freeze_min_age = 0",
	"toast.autovacuum_vacuum_insert_scale_factor = 0.0",
	"toast.autovacuum_vacuum_insert_threshold = 10000",
	"toast.autovacuum_vacuum_scale_factor = 0.02",
	"toast.autovacuum_vacuum_threshold = 1000",
	"toast.autovacuum_vacuum_cost_delay = 0",
	"toast.autovacuum_freeze_min_age = 0",
].join(", ")

/** Insert derived commit rows, ≤ this many per statement (six array binds per
 * statement regardless of row count; the chunk only bounds payload size). */
const BACKFILL_BATCH = 5000

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		create table git_commit (
			repo_id     bigint  not null,
			oid         bytea   not null,
			tree_oid    bytea   not null,
			parents     bytea[] not null,
			commit_time bigint  not null,
			generation  int,
			primary key (repo_id, oid),
			constraint git_commit_oid_len check (length(oid) = 20 and length(tree_oid) = 20),
			constraint git_commit_object_fk
				foreign key (repo_id, oid) references git_object (repo_id, oid) on delete cascade
		) partition by hash (repo_id)
	`.execute(db)

	await sql`
		create table git_tag (
			repo_id     bigint   not null,
			oid         bytea    not null,
			target_oid  bytea    not null,
			target_type smallint not null,
			primary key (repo_id, oid),
			constraint git_tag_oid_len check (length(oid) = 20 and length(target_oid) = 20),
			constraint git_tag_object_fk
				foreign key (repo_id, oid) references git_object (repo_id, oid) on delete cascade
		) partition by hash (repo_id)
	`.execute(db)

	for (const table of ["git_commit", "git_tag"]) {
		for (let remainder = 0; remainder < COMMIT_TAG_PARTITIONS; remainder++) {
			await sql`
				create table ${sql.raw(`${table}_p${remainder}`)}
					partition of ${sql.raw(table)}
					for values with (modulus ${sql.raw(String(COMMIT_TAG_PARTITIONS))}, remainder ${sql.raw(String(remainder))})
					with (${sql.raw(LEAF_RELOPTS)})
			`.execute(db)
		}
	}

	await backfill(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table if exists git_tag`.execute(db)
	await sql`drop table if exists git_commit`.execute(db)
}

/**
 * Derive rows for every commit/tag object already stored — pre-0009 repos have
 * objects but no rows, and the S1 consumers treat a missing row as a loud error,
 * never a parse-the-body fallback. Bodies are parsed app-side with the same
 * parsers ingest uses (one grammar, one truth); generations are computed per repo
 * in ONE topological pass (per-row lookups against a partially-backfilled table
 * would be quadratic round-trips). A parent object a repo does not hold (denied-
 * push residue swept before this migration ran, force-push-era holes) derives
 * NULL, absorbing — exactly what ingest would have derived.
 */
async function backfill(db: Kysely<unknown>): Promise<void> {
	const repos = await sql<{ repo_id: string }>`
		select distinct repo_id from git_object
		where type in (${PACK_OBJ_TYPE.COMMIT}, ${PACK_OBJ_TYPE.TAG})
	`.execute(db)

	for (const { repo_id } of repos.rows) {
		const commits = await sql<{ oid: Buffer; content: Buffer }>`
			select oid, content from git_object
			where repo_id = ${repo_id}::bigint and type = ${PACK_OBJ_TYPE.COMMIT}
		`.execute(db)
		const derived = commits.rows.map((r) => ({
			oid: r.oid.toString("hex"),
			row: deriveCommitRow(r.content),
		}))
		const generations = computeGenerations(
			new Map(derived.map((d) => [d.oid, d.row.parents])),
			new Map(),
		)
		for (let i = 0; i < derived.length; i += BACKFILL_BATCH) {
			const chunk = derived.slice(i, i + BACKFILL_BATCH)
			// Array binds only — a bytea[] cannot be bound directly (the driver
			// serializes Buffer[] as one bytea), so parents travel as hex text and
			// decode server-side, order pinned by WITH ORDINALITY.
			await sql`
				insert into git_commit (repo_id, oid, tree_oid, parents, commit_time, generation)
				select ${repo_id}::bigint, decode(u.oid, 'hex'), decode(u.tree, 'hex'),
					(select coalesce(array_agg(decode(p.h, 'hex') order by p.ord), '{}'::bytea[])
						from unnest(string_to_array(nullif(u.parents, ''), ' ')) with ordinality as p(h, ord)),
					u.commit_time, u.generation
				from unnest(
					${chunk.map((d) => d.oid)}::text[],
					${chunk.map((d) => d.row.treeOid)}::text[],
					${chunk.map((d) => d.row.parents.join(" "))}::text[],
					${chunk.map((d) => d.row.commitTime)}::bigint[],
					${chunk.map((d) => generations.get(d.oid) ?? null)}::int[]
				) as u(oid, tree, parents, commit_time, generation)
				on conflict do nothing
			`.execute(db)
		}

		const tags = await sql<{ oid: Buffer; content: Buffer }>`
			select oid, content from git_object
			where repo_id = ${repo_id}::bigint and type = ${PACK_OBJ_TYPE.TAG}
		`.execute(db)
		const tagRows = tags.rows.map((r) => ({
			oid: r.oid.toString("hex"),
			row: deriveTagRow(r.content),
		}))
		for (let i = 0; i < tagRows.length; i += BACKFILL_BATCH) {
			const chunk = tagRows.slice(i, i + BACKFILL_BATCH)
			await sql`
				insert into git_tag (repo_id, oid, target_oid, target_type)
				select ${repo_id}::bigint, decode(u.oid, 'hex'), decode(u.target, 'hex'), u.target_type
				from unnest(
					${chunk.map((t) => t.oid)}::text[],
					${chunk.map((t) => t.row.targetOid)}::text[],
					${chunk.map((t) => OBJECT_TYPE_CODE[t.row.targetType])}::int[]
				) as u(oid, target, target_type)
				on conflict do nothing
			`.execute(db)
		}
	}
}

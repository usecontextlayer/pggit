import { type Kysely, sql } from "kysely"

// pggit derived pack-encoding tier (docs/2026-08-15-delta-pack-design.md, D1/D2/D6).
//
// One OPTIONAL row per object: its reusable wire encoding — `data` is deflated
// bytes served verbatim into a pack (deflate(raw object) when `base_oid` is NULL,
// deflate(delta program) against `base_oid` otherwise). DERIVED, never
// authoritative: `git_object` remains the object inventory and raw-content
// authority, and a missing encoding row just means the serve path falls back to
// deflating raw content as it always has. Star topology holds depth at ≤ 1
// structurally — a delta's base is always a whole ("anchor") encoding — so there
// is no depth column; the invariant "a base row has base_oid IS NULL" is enforced
// by the repack policy and pinned by e2e test, not by DDL (a self-join CHECK
// cannot express it).
//
// `data_size` is the inflated length of what `data` holds — the object's size for
// a whole row, the DELTA PROGRAM's length for a delta row. The pack object header
// varint needs exactly this value; `git_object.size` cannot serve both meanings.
//
// `data` is already zlib-deflated, so its column storage is EXTERNAL (out-of-line,
// no second compression pass) — inline STORAGE on the partitioned parent
// propagates to partitions, like inline COMPRESSION does (0001_init.ts).
//
// The tier's hygiene (design D7) is DDL, not code: two FK cascades onto
// `git_object` mean a reclaimed object's encoding row — and every delta row
// anchored on it — dies inside the very DELETE that removes the object,
// atomically per statement. GC therefore has no encoding sweep to run, a torn
// tier is unrepresentable, and a no-op GC pass pays the tier nothing. The
// object-side cascade looks rows up through the tier's own PK; the base-side
// cascade needs the partial index below.
//
// Repack only ever ADDS rows (frozen policy, D4); deletion is entirely the
// cascades'. The cascade churn is still real DELETE traffic, so the leaf
// reloptions take the delete-aware profile the GC sweep already gave
// git_object/git_edge (0005), not the insert-only profile.

const ENCODING_PARTITIONS = 16

const ENCODING_LEAF_RELOPTS = [
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

export async function up(db: Kysely<unknown>): Promise<void> {
	// ON DELETE CASCADE from day one: repo deletion is a bare DELETE on repos
	// (repo-admin.ts) whose whole teardown IS the cascade (0007) — a plain FK here
	// would make the first repo deletion after this migration fail loudly.
	await sql`
		create table git_pack_encoding (
			repo_id   bigint not null references repos (id) on delete cascade,
			oid       bytea  not null,
			base_oid  bytea,
			data_size int    not null,
			data      bytea  storage external not null,
			primary key (repo_id, oid),
			constraint git_pack_encoding_oid_len check (length(oid) = 20),
			constraint git_pack_encoding_base_len check (base_oid is null or length(base_oid) = 20),
			constraint git_pack_encoding_base_not_self check (base_oid is distinct from oid),
			constraint git_pack_encoding_object_fk
				foreign key (repo_id, oid) references git_object (repo_id, oid) on delete cascade,
			constraint git_pack_encoding_base_fk
				foreign key (repo_id, base_oid) references git_object (repo_id, oid) on delete cascade
		) partition by hash (repo_id)
	`.execute(db)

	for (let remainder = 0; remainder < ENCODING_PARTITIONS; remainder++) {
		await sql`
			create table ${sql.raw(`git_pack_encoding_p${remainder}`)}
				partition of git_pack_encoding
				for values with (modulus ${sql.raw(String(ENCODING_PARTITIONS))}, remainder ${sql.raw(String(remainder))})
				with (${sql.raw(ENCODING_LEAF_RELOPTS)})
		`.execute(db)
	}

	// The base-side cascade's lookup path: deleting a git_object row must find the
	// delta rows anchored on it. The object-side cascade rides the PK; this one
	// needs its own index — partial, because whole encodings (base_oid NULL) can
	// never match a non-null referenced key.
	await sql`
		create index git_pack_encoding_base on git_pack_encoding (repo_id, base_oid)
			where base_oid is not null
	`.execute(db)

	// The repack drain's watermark, exactly the last_gc_at pattern (0004): stamped
	// by the drain at pass start, compared against last_pushed_at for eligibility,
	// deliberately UNINDEXED so the per-push stamp stays HOT.
	await sql`alter table repos add column last_repack_at timestamptz`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`alter table repos drop column if exists last_repack_at`.execute(db)
	await sql`drop table if exists git_pack_encoding`.execute(db)
}

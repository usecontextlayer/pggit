import { type Kysely, sql } from "kysely"

// The derived-state spine, chunk 5b (slice S6): reachability bitmaps — the
// cold-clone analog of git's `.bitmap`. Each repo carries at most ONE live
// **epoch**: a sorted, concatenated array of all live oids (`oids`, 20 bytes
// each; bit *i* ⇔ `oids[i*20..]`), plus one CRoaring-serialized bitmap per ref
// tip over that ordering. Produced by the GC pass (the walk is already in hand
// there); consumed by the no-have serve path and by GC's own next pass.
//
// `epoch` appears in BOTH keys deliberately (not observability): bitmap bits are
// POSITIONAL against one epoch's array, and the composite FK makes cross-epoch
// skew unrepresentable — replacing the epoch row cascades every old-epoch bitmap
// away atomically, so a bitmap can never be read against a different epoch's
// array. The `tip_oid` FK onto `git_object` makes half the rewind guard DDL: a
// rewound-and-reclaimed former tip's bitmap row cascades away with the object.
//
// Neither table is partitioned (one small row per repo / per tip). `storage
// external` is declared inline; both tables are UNPARTITIONED, so the catalog
// check reads `pg_attribute.attstorage = 'e'` straight off them (no leaves).

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		create table git_reach_epoch (
			repo_id bigint not null references repos (id) on delete cascade,
			epoch   bigint not null,
			tips    bytea  storage external not null,
			oids    bytea  storage external not null,
			primary key (repo_id),
			constraint git_reach_epoch_addr unique (repo_id, epoch),
			constraint git_reach_epoch_tips_len check (length(tips) % 20 = 0),
			constraint git_reach_epoch_oids_len check (length(oids) % 20 = 0)
		)
	`.execute(db)

	await sql`
		create table git_reach_bitmap (
			repo_id bigint not null,
			epoch   bigint not null,
			tip_oid bytea  not null,
			bits    bytea  storage external not null,
			primary key (repo_id, tip_oid),
			constraint git_reach_bitmap_tip_len check (length(tip_oid) = 20),
			constraint git_reach_bitmap_epoch_fk
				foreign key (repo_id, epoch)
				references git_reach_epoch (repo_id, epoch) on delete cascade,
			constraint git_reach_bitmap_tip_fk
				foreign key (repo_id, tip_oid)
				references git_object (repo_id, oid) on delete cascade
		)
	`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop table if exists git_reach_bitmap`.execute(db)
	await sql`drop table if exists git_reach_epoch`.execute(db)
}

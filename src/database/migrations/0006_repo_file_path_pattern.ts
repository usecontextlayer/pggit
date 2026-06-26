import { type Kysely, sql } from "kysely"

// The list-by-prefix read contract
// (docs/2026-06-26-read-surface-sharpening-design.md §5). `repo_file`'s PRIMARY KEY
// (repo_id, ref_name, path) is a btree in the database's DEFAULT collation, which
// Postgres will NOT use to turn `path LIKE 'prefix%'` into an index range: only the
// `C`/`POSIX` collation or a `*_pattern_ops` opclass yields the byte-wise `~>=~` / `~<~`
// range operators a prefix scan needs (the projection's own listing already forces
// `COLLATE "C"` to get git's byte order — proof the default isn't C). Without this index
// the prefix predicate degrades to a per-ref Filter — a full scan of every file at the
// tip, the consumer's hottest read.
//
// `text_pattern_ops` is byte-wise and collation-independent, which is exactly right:
// it ranges the prefix, matches git's byte-order path semantics (so it is safe for the
// non-UTF-8 paths the server already stores), and its ordering can serve a byte-ordered
// listing too. The PK is untouched — it keeps exact-path equality and row uniqueness.
// `repo_file` is HASH-partitioned, so a CREATE INDEX on the parent cascades to every leaf.

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		create index repo_file_path_pattern
			on repo_file (repo_id, ref_name, path text_pattern_ops)
	`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`drop index if exists repo_file_path_pattern`.execute(db)
}

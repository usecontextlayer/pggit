import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"

// §5 of docs/2026-06-26-read-surface-sharpening-design.md: the list-by-prefix read
// (`path LIKE 'prefix%'`) is the consumer's hottest read, and it MUST be served by an
// index RANGE — not a per-ref Filter. repo_file's PRIMARY KEY (repo_id, ref_name, path)
// is a btree in the database's DEFAULT collation, which Postgres will NOT use for a
// LIKE-prefix index condition; only a `C`/`POSIX` collation or a `*_pattern_ops` opclass
// produces the byte-wise `~>=~` / `~<~` range operators a prefix scan needs. Migration
// 0006 adds exactly that index. This test pins the behaviour, not the migration: with
// the index, EXPLAIN shows the prefix as an Index Cond (the `~>=~` pattern operator);
// without it, the LIKE degrades to a Filter and `~>=~` never appears.
describe("repo_file — list-by-prefix is index-served (§5)", () => {
	let db: IsolatedDb
	let repoId: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const [repo] = await db.sql<{ id: string }[]>`
			insert into repos (name) values ('prefix-bench') returning id
		`
		if (!repo) throw new Error("expected an inserted repo")
		// One ref, 500 files; only 5 share the queried prefix, so an index range is
		// strictly cheaper than scanning every file at the tip and filtering — the
		// planner has a real reason to prefer the pattern index over the PK.
		await db.sql`
			insert into repo_file (repo_id, ref_name, path, mode, blob_oid)
			select ${repo.id}, 'refs/heads/main',
				case when g < 5 then 'sessions/keep/' || g || '.jsonl'
				     else 'other/dir/' || lpad(g::text, 4, '0') || '.txt' end,
				'100644',
				decode(lpad(to_hex(g), 40, '0'), 'hex')
			from generate_series(0, 499) as g
		`
		// Give the planner real column stats (the autovacuum-analyzed steady state a
		// populated repo reaches), so its index choice is deterministic, not a
		// no-stats guess.
		await db.sql`analyze repo_file`
		repoId = repo.id
	})

	afterAll(async () => {
		await db?.drop()
	})

	it("creates the partitioned pattern index (migration 0006)", async () => {
		// Scope to THIS test's schema: pg_indexes spans every schema, and the shared
		// container holds many isolated `t_<uuid>` schemas at once — each with its own
		// `repo_file_path_pattern` — so an unscoped count is polluted by siblings.
		const rows = await db.sql<{ indexname: string }[]>`
			select indexname from pg_indexes
			where schemaname = ${db.schema} and indexname = 'repo_file_path_pattern'
		`
		expect(rows).toHaveLength(1)
	})

	it("turns `path LIKE 'prefix%'` into an index range, not a filter", async () => {
		// Correctness first: the prefix predicate selects exactly the 5 seeded files.
		const hits = await db.sql<{ path: string }[]>`
			select path from repo_file
			where repo_id = ${repoId} and ref_name = 'refs/heads/main'
				and path like 'sessions/keep/%'
			order by path collate "C"
		`
		expect(hits).toHaveLength(5)

		// The §5 guarantee: the prefix is an index Cond (the byte-wise `~>=~` range op),
		// not a post-scan Filter. enable_seqscan=off removes the small-table seq-scan
		// option so the comparison is purely between the available indexes — the PK
		// (which can only Filter the LIKE) and the pattern index (which can range it).
		let plan = ""
		await db.sql.begin(async (tx) => {
			await tx`set local enable_seqscan = off`
			const rows = await tx<Record<string, string>[]>`
				explain (costs off)
				select path from repo_file
				where repo_id = ${repoId} and ref_name = 'refs/heads/main'
					and path like 'sessions/keep/%'
			`
			plan = rows.map((r) => r["QUERY PLAN"]).join("\n")
		})
		expect(plan).toContain("~>=~")
	})
})

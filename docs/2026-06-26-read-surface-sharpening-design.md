# pggit — read-surface sharpening: `repo_file` is the public read API

- **Date:** 2026-06-26
- **Status:** **IMPLEMENTED 2026-06-26** — full gate green (biome `--error-on-warnings`,
  `tsc -b`, `tsdown` build, vitest 278 passed). What landed: the three read methods +
  `withContent` helper + `SnapshotFile`/`SnapshotFileContent` types deleted and
  `createSnapshotStore`→`createRepoFileProjection` (file now `repo-view/repo-file-projection.ts`,
  write-only); migration `0006_repo_file_path_pattern` (the §5 `text_pattern_ops` index,
  behaviour-tested in `repo-view/repo-file-index.test.ts`); the `./schema` export (§6,
  `src/schema.ts` → `dist/schema.d.mts`); and the two `listFiles` tests rewritten to direct
  SQL (§3.5). The §1 invariant — one read mechanism, no read-API method in `src` or tests —
  now holds.
- **Scope:** the **read surface only** — what a consumer uses to read file state out of
  a repo. Removes the half-built read-API methods on the snapshot store, and finishes
  the `repo_file` contract (the prefix index + a published schema export) so direct SQL
  is a *complete* read API, not a partial one. **No change** to the smart-HTTP wire
  protocol, the write/projection path, GC/reachability/drain, or any git-server behaviour.
- **Lineage:** builds directly on the repo_view collapse of the Postgres-native storage
  redesign (`internal/archived/2026-06-22-pggit-postgres-native-storage-redesign.md` §4.5
  — which made `repo_file` a slim `path → (mode, blob_oid)` index and `git_object` the
  content). Serves the **read plane** of the consuming project's `~/.claude` persistence
  design (`internal/in-progress/2026-06-24-claude-home-persistence-design.md` §4). Bare
  `§N` below refers to **this** doc.
- **Motivation:** with objects stored one row each and content joinable from `git_object`,
  *"a branch's working tree is plain SQL"* is already pggit's headline (README). This doc
  makes that the **only** read mechanism — there is no read-API library and no read HTTP
  endpoint. A wrapper API over a co-hosted SQL projection is pure ceremony; the schema
  **is** the API.

---

## 1. The sharpening

**pggit exposes two surfaces, by access mode, and that is the whole read story:**

1. **Writes + clones → smart-HTTP** (the git wire protocol: `info/refs`,
   `git-upload-pack`, `git-receive-pack`). Capture (force-push) and restore
   (`git clone`/`fetch`) ride this, with stock `git`. **Unchanged.**
2. **Reads → `repo_file` SQL, queried *directly*.** `repo_file` is a **public,
   directly-queryable projection** — consumers `SELECT` it themselves. Being directly
   queryable was always the point of the Postgres-native storage redesign; a wrapper API
   over a table is indirection we delete.

**Invariant — exactly one read mechanism.** There is *one* way to read `repo_file`, and it
is direct SQL on `repo_file ⋈ git_object`. No read-API method exists in pggit and none may
be reintroduced — **in `src` or in the tests**. The tests read through the *same* SQL
surface a consumer uses, so the suite is itself the conformance check that the published
contract is real and sufficient. Any function that wraps a `repo_file` read (the deleted
`listFiles`/`readFile`/`readSnapshot`) is exactly the indirection this doc removes. A test
asserting via a read-API method is an internal inconsistency, not a convenience.

## 2. Grounding — verified true today (2026-06-26), so the change is safe

The premise was checked against the source before committing to it:

- **`git_object.content` is the raw inflated body** — "no `<type> <size>\0` loose header,
  no zlib (that is the content seam)" (`migrations/0001_init.ts:47-49`). So a consumer
  doing `SELECT content … WHERE oid = blob_oid` gets **directly usable file bytes**, with
  no decode step. This is the make-or-break fact for "reads are just SQL," and it holds.
- **Exact-path read is already indexed.** `repo_file`'s PRIMARY KEY is
  `(repo_id, ref_name, path)` (`migrations/0002_repo_file.ts:31`) — the read-by-path shape
  needs no new index.
- **The README already documents the direct-SQL read** (`select f.path, f.mode, o.content
  from repo_file f join git_object o …`). This doc makes the public story authoritative; it
  does not invent it.
- **The read-API methods have zero production callers.** `readFile`/`readSnapshot`: none at
  all. `listFiles`: two callers, both tests (`repo-view/behaviour.test.ts:266-267`,
  `e2e/non-utf8-paths.test.ts:120`). The read API existed for a consumer that now queries
  directly.
- **The indirect-read set is closed and small.** A full audit (2026-06-26) of *every*
  `repo_file` reference found the only non-direct-SQL reads are those three `listFiles` call
  sites across two test files; every other touch is a write (`delete`/`copyInsert`) or a
  comment. So §3 removes a **complete** set, not a partial one — and one of those two files
  (`behaviour.test.ts`) *already* reads `repo_file` via direct SQL (`queryFiles` /
  `fileRowCount`, `:53-73`), so the consistent pattern already lives beside the inconsistent
  one.

## 3. What changes

1. **Remove the read methods** from `repo-view/snapshot-store.ts`: `listFiles`, `readFile`,
   `readSnapshot` (and the `withContent()` join helper, `SnapshotFile` /
   `SnapshotFileContent` types they exist to serve).
2. **Rename the surviving write-only thing** so "SnapshotStore" stops implying a read API:
   `createSnapshotStore` → `createRepoFileProjection` (type `RepoFileProjection`). What
   stays is the **projection maintainer**: `clearRepo` / `dropRefSnapshot` /
   `rebuildRefSnapshot`, driven by `syncRefSnapshot` on receive-pack
   (`repo-view/rebuild.ts` → `protocol/receive-pack.ts:238`). This is what *populates* the
   queryable projection; it is the whole reason the table stays current.
3. **Add the prefix index** (§5) — the one schema change that makes the *list-by-prefix*
   read shape an actual index range scan rather than a per-ref filter.
4. **Publish the schema** (§6) — export the `repo_file` + `git_object` Kysely models so a
   consumer can type its queries against a stable shape without reaching into internals.
5. **Rewrite the two `listFiles` tests onto the contract — the whole indirect-read set
   (§2).** Removing `listFiles` breaks exactly two tests; rewrite both to read `repo_file`
   via direct SQL so pggit and its tests are internally consistent (one read mechanism):
   - `repo-view/behaviour.test.ts:266-271` (dedup) asserts `path` + `blob_oid` (same content
     → same OID). The file **already has the template** — the `queryFiles` / `fileRowCount`
     direct-SQL helpers (`:53-73`); add a sibling `SELECT f.path, f.blob_oid …` read and
     compare the two `blob_oid`s.
   - `e2e/non-utf8-paths.test.ts:120-130` asserts only the lossy-decoded `path`; replace the
     call with a direct `SELECT f.path FROM repo_file f JOIN repos r … WHERE r.name='repo'
     AND f.ref_name='refs/heads/main'` against its existing SQL handle.
   - **`clearRepo` stays** (`behaviour.test.ts:292`) — it is a write/maintenance op
     (wipe-the-projection), not a read, and the test deliberately uses the public
     maintenance API over raw `DELETE`s.

   This is a feature, not a cost: the tests become the **first consumer that dogfoods the
   published read contract** (and `non-utf8-paths` keeps exercising the byte-order path
   semantics the §5 index depends on).

## 4. The read contract (the public interface)

```
repo_file (repo_id, ref_name, path, mode, blob_oid)   -- the per-branch-tip path index
git_object (repo_id, oid, type, size, content)        -- content joined on oid = blob_oid
```

- **Two query shapes, both plain SQL:**
  - **read-by-path** (exact): `repo_file ⋈ git_object WHERE repo_id=? AND ref_name=? AND
    path=?` → `content`. Served by the PK btree.
  - **list-by-prefix / pattern**: `SELECT path, mode, blob_oid … WHERE repo_id=? AND
    ref_name=? AND path LIKE 'prefix%'` (+ a depth predicate like `AND path NOT LIKE
    'prefix%/%'` for top-level-only). Served by the **`text_pattern_ops` index in §5** —
    *not* by the PK (see §5 for why).
- **`ref_name = 'refs/heads/main'`** for the single-branch force-push model — `repo_file`
  is the **branch-tip** projection (latest captured state). There is **no per-file
  history** in `repo_file`; history is the git objects, read over the wire.
- Order by `path COLLATE "C"` (or rely on the `text_pattern_ops` index ordering, §5) to
  match `git ls-tree -r` byte order regardless of the database's default collation.

## 5. Correction — the prefix index (this is part of the contract, not an impl detail)

The list-by-prefix shape is the consumer's **primary** read (e.g. listing one session
bucket's files under a path prefix). It is **not** index-backed by the existing PK, and the
gap is collation-shaped:

- The PK `(repo_id, ref_name, path)` is a btree in the **database's default collation**.
  That default is **not `C`** — proven by the fact that every byte-ordered read of the
  projection must force `ORDER BY path COLLATE "C"` to get git's order (the now-deleted
  `listFiles` did; the `indexRows` test helper and migration `0006`'s rationale do today).
- Postgres only uses a btree for a `LIKE 'prefix%'` predicate when the column uses the
  `C`/`POSIX` collation or a `*_pattern_ops` opclass. With a non-`C` default and no
  pattern-ops index, `path LIKE 'prefix%'` **cannot** become an index range: after
  partition pruning and seeking on the `repo_id`/`ref_name` equality prefix, **every file
  at that ref is read and filtered**. For a large tip (the `~/.claude` bucket model) that
  is a full per-ref scan on the hottest read.

**Fix — ship a partitioned pattern-ops index alongside the projection:**

```sql
create index repo_file_path_pattern
  on repo_file (repo_id, ref_name, path text_pattern_ops);
```

`text_pattern_ops` is byte-wise and collation-independent, which is exactly right here:

- it makes `LIKE 'prefix%'` an index **range** scan;
- it matches **git's byte-order path semantics** — the same reason `listFiles` reached for
  `COLLATE "C"` — so it is safe for the **non-UTF8 paths** the repo already handles
  (`e2e/non-utf8-paths.test.ts`);
- its byte ordering can also serve the `ORDER BY path` listing.

`repo_file` is HASH-partitioned by `repo_id` (`0002_repo_file.ts`), so a `CREATE INDEX` on
the partitioned parent cascades to every leaf — no per-partition DDL. The PK is untouched;
it keeps serving exact-path equality and the row-uniqueness constraint.

**Verified (2026-06-26) — the index needs statistics to be chosen.** With the index present
but the table freshly populated and un-analyzed, the planner *still* picks the PK index-only
scan: without column stats it cannot see that a prefix is selective, so the `LIKE` stays a
`Filter`. After `ANALYZE` — the autovacuum-analyzed steady state a live repo reaches, since
`repo_file`'s leaves are tuned for aggressive insert-autovacuum in `0002_repo_file.ts` — it
switches to the `text_pattern_ops` range (`~>=~`). The behavioural test
(`repo-view/repo-file-index.test.ts`) pins exactly this: seed 500 rows where only 5 share a
prefix, `ANALYZE`, then assert the `EXPLAIN` plan shows the `~>=~` index Cond, not a `Filter`.

## 6. Correction — publish the schema (real work, not a one-liner)

"Export the read contract" is genuine package-surface work, currently unbuilt:

- pggit ships only `exports: { ".": "./dist/index.mjs" }`, and `index.ts` exports
  `createGitApp` / `GitAppDeps` and the GC trio (`createGc` / `createGcScheduler` / …) —
  **not** the data models.
- The generated Kysely models already exist
  (`src/database/models/public/{RepoFile,GitObject,PublicSchema}.ts`) but are **not** in the
  public surface.

**Fix —** add a `./schema` export subpath (`@usecontextlayer/pggit/schema`) that re-exports
the `RepoFile` + `GitObject` row types (and the `PublicSchema`/`DB` interface a Kysely
handle binds to), and make it land in `dist` (tsdown entry + `package.json#exports`). A
consumer then types its queries against the **published** shape — the concrete realization
of "the schema is the API."

## 7. Boundaries (what stays true)

- **pggit stays domain-generic.** It knows `repo_id`, `path`, `blob`, `ref` — never
  "sessions", "buckets", or any view layout. All domain semantics live in the **consumer**.
  The generic path index (§5) + the domain query is the same split as everywhere else.
- **The projection is derived + rebuildable** (drop and rebuild from the canonical git
  objects via `syncRefSnapshot`); it is **never** source of truth.
- **GC / reachability / drain** (already shipped) are unaffected — they operate on the
  canonical objects; `repo_file` is rebuilt alongside, and the new index rebuilds with it.

## 8. The trade we accept

Querying `repo_file` directly makes **its schema a public contract** — consumers couple to
the two-table shape, so it can't change freely. Accepted: the schema is small, stable, and
already the README's documented interface; we own both sides; and the alternative (a
read-API library/HTTP layer over a co-hosted SQL projection) is pure indirection. The schema
*is* the API.

## 9. Consumer wiring (orientation — the consumer owns the domain)

pggit is **standalone** and domain-generic, so *how* a consumer mounts and queries it is the
consumer's concern. For orientation: a consumer mounts `createGitApp` at `/git` for the wire
protocol, and is handed a Kysely/SQL handle to the **same** Postgres to query
`repo_file ⋈ git_object` directly via the published `./schema` types (§6). Every domain
semantic — which path prefixes mean what, file-type filters, view layout — lives in the
consumer, not here.

**First consumer:** the ContextLayer slate platform (`packages/platform`), whose read routes
query `repo_file` for the `~/.claude` session model. The session / bucket / view semantics —
and the route-level detail — are owned by the consumer-side design
(`internal/in-progress/2026-06-24-claude-home-persistence-design.md` §4), **not** by this
doc.

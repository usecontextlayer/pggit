# The derived-state spine: one commit relation, content-driven reachability, frontier serving

**Date:** 2026-08-17 · **Status:** DESIGN DECIDED — chunks 1–4 and the chunk-5 decisions (R15–R21) were each explicitly approved by the user 2026-08-17, and **chunk 5b was explicitly approved by the user after the session audit surfaced that its first stamp had preceded the sign-off** (user: "chunk 5b is approved"). Nothing here is implemented yet.

**Frame (the user's words, stated twice as the standing rule for every fidelity-vs-idiom fork):** "remember, our goal is to build a real backend for git that's powered by postgres. we want to stay close to what git already does, and adapt what makes sense for the postgres world. we're not trying to re-invent git, just layering it on top of postgres."

**Scope.** One unified redesign of how pggit derives, stores, and serves reachability and projections — the three problems the 2026-08-16 hunt left standing, treated as one disease: S1/W5 (`git_edge` grows quadratically and is ~80% of the database), H7/W8 (a warm incremental fetch pays two full-history closures and ships trees whole), S2/W7 (every push rewrites a branch's whole `repo_file` snapshot). The user chose the unified frame over three surgical fixes (2026-08-17).

**Provenance.** Designed in Claude Code session `5a316ad0-fd4b-4c8a-8608-a526817a989d` (the same session that ran the 2026-08-16 delta-pack defect-fix pass, D11–D16 of the sibling doc). A deliberating panel (three stances propose → three critics attack → one synthesis; 7 Opus agents, run `wf_f5fa6abd-b21`) produced the draft this document co-designs from. The full episode — proposals, critiques, synthesis, script — is archived at `internal/scratch/2026-08-16-pggit-spine-redesign/`. Honest weight of that evidence: the shared brief SEEDED the candidate directions (frontier walk, drop kind-3, tree-diff primitive, incremental `repo_file`, thin-pack were lettered candidates all three were required to evaluate), so the three proposals adopting them is menu agreement, not independent corroboration; the frontier ALGORITHM specifically did NOT converge — only one proposal had git's real uninteresting-propagation (the other two sketched a stop-at CTE the correctness critic proved over-sends on merges), which is why S4 is this design's one high-risk slice. The critics produced seven ranked findings (archived README lists them); some were fixed by grafting another proposal's piece, others (the want-type router, the boundary-blacklist pricing) are critic-authored. Provenance markers: this document does NOT carry the synthesis's [V]/[A] legend — where a claim below is modelled or asserted rather than measured, it says so in place.

**Relationship to the delta-pack design** (`docs/2026-08-15-delta-pack-design.md`): that document's decisions D1–D16 stand except where explicitly amended here. This design discharges D10 (`git_edge` is its own track), extends D7/D14 (FK-cascade hygiene) to the new tables, and will amend D8 (serve rule) in the serve chunk. Two of its numbers are corrected below (§N1).

## Corrected numbers the whole design is priced against (§N1)

**"10×" defined, once:** everywhere in this document, 10× means **10× the commit count on the same append-only wide-directory shape** (≈14,900 commits vs komal's 1,490). Quadratic quantities (tree bytes, kind-3 edge rows) therefore scale ×100; linear quantities (commit rows, backfill reads) scale ×10. The overall scale TARGET named in the panel brief (~150k commits / ~1.5M objects) is 100×, called out as such where used.

- **Tree bytes are quadratic in commits on the motivating shape, like the edge rows.** komal's tree bodies are **70.36 MB raw** (measured: `internal/scratch/2026-08-15-pggit-delta-packs/measurements.md` — 9,292 tree objects; note 80.73 MB in that file is ALL objects, a figure earlier drafts and the delta-pack doc's C1 mislabeled as tree bytes). The model 64 B/entry × Σᵢ i = 64·1490²/2 ≈ 71 MB reproduces the measured figure, and 1490²/2 = 1.11 M reproduces the measured 1,099,546 kind-3 rows. Therefore **10× komal ≈ 7 GB of raw tree bytes** (modelled: ×100, quadratic) — the delta-pack doc's C1 line ("a 10× repo means ~800 MB in the platform process") is a linear mis-extrapolation of its own quadratic premise and needs the fix applied there too. (No conflict with `git_object`'s 73.37 MB on-disk total: that is the stored, TOAST-compressed figure for all objects — trees store 70.36 raw → 68.45 MB.)
- **A warm fetch is O(files at tip), not O(change):** any tree-diff of the tip reads both root trees whole — ~95 KB/side at komal, ~954 KB/side at 10×. The redesign's warm-fetch win survives (2 × 7 GB → ~1.9 MB at 10×) but no design may claim size-invariance.

---

## Chunk 1 — Storage (APPROVED 2026-08-17)

**`git_edge` is dropped entirely.** Kind-3 (tree→subtree; 1,099,546 rows / 300 MB / growth exponent 1.99 at komal) is a second copy of what tree bodies already carry — every tree body enumerates its children, and the closure already reads those bodies to enumerate blobs. It is deleted with **no replacement structure**: walks read tree content. Kinds 1/2 (commit→tree, commit→parent) become one row per commit; kind 5 (tag→target) becomes a tag row.

```sql
create table git_commit (
  repo_id     bigint  not null,
  oid         bytea   not null,
  tree_oid    bytea   not null,
  parents     bytea[] not null,   -- ORDERED (content order); '{}' for a root commit
  commit_time bigint  not null,   -- committer epoch seconds; the frontier's tiebreak within/without generations
  generation  int,                -- 1 + max(gen(parents)); NULL ≡ infinity, absorbing
  primary key (repo_id, oid),
  constraint git_commit_object_fk foreign key (repo_id, oid)
    references git_object (repo_id, oid) on delete cascade,
  constraint git_commit_oid_len check (length(oid) = 20 and length(tree_oid) = 20)
) partition by hash (repo_id);

create table git_tag (
  repo_id     bigint   not null,
  oid         bytea    not null,
  target_oid  bytea    not null,
  target_type smallint not null,
  primary key (repo_id, oid),
  constraint git_tag_object_fk foreign key (repo_id, oid)
    references git_object (repo_id, oid) on delete cascade
) partition by hash (repo_id);
```

Both hash-partitioned (16 leaves) with the **delete-aware reloptions profile of 0005/0008** — these rows die by GC cascade on every pass, so 0003's insert-only profile is exactly wrong here (0005 exists to undo it for tables GC deletes from; 0008 states the rule outright). The panel synthesis prescribed 0003's profile with a [V] mark that was not in fact verified — corrected by the session audit. **No child-direction (secondary) index on either** — nothing walks upward; every walk enters by PK.

### The load-bearing pieces

1. **`parents` is ORDERED.** The kind-2 edge *set* threw parent order away, which is exactly why `repack.commitDiffOrder` re-parses every commit body today ("parent ORDER lives only in commit content"). The ordered array is the honest data structure; the re-parse is deleted. First-parent lineage walks (repack's diff order, the frontier's boundary diffing) read it directly.
2. **`generation` is computed AT INGEST — with IN-PACK resolution — never by a later UPDATE, and NULL is absorbing.** The load-bearing half the first draft of this document dropped (caught by the session audit; the panel source had it): a git pack lists commits newest-first, so per-row computation in pack order would derive NULL for EVERY commit of a first push and absorbing-NULL would freeze that forever. Generations are computed in **one topological pass over the ingest batch** (parents in the same pack resolve locally; parents already in `git_commit` resolve by read), so NULL arises ONLY for a genuine cross-pack orphan parent (denied-push residue). `gen = 1 + max(gen(parents))` when every parent resolves finite; any absent or NULL-gen parent makes the commit NULL, and NULL propagates to every descendant ingested later — never recomputed (ingest-atomicity: no crash window can leave a half-backfilled derived scalar; critic-resolved vs P1's repack-time UPDATE and P3's non-absorbing NULL). NULL means "no pruning" (git's GENERATION_NUMBER_INFINITY). The finite region carries the strict invariant `gen(parent) < gen(child)` that chunk 2's exactness rests on; `commit_time` is the tiebreak that orders NULL regions (see R2's scoping).
3. **`git_tag` must exist as a relation** — the minimalist's app-side peeling was killed by the correctness critic: GC's live set descends tag→target chains (kind 5) from `git_ref.peeled_oid` seeds today, `peelRef`'s chain CTE is deliberately unbounded (tag-of-tag chains), and `augmentWithTags` must ship whole tag chains for client fsck. Dropping the relation is silent GC data loss on annotated-tag chains. It is ~tens of rows per repo.
4. **FK `ON DELETE CASCADE` onto `git_object` is D14's idiom extended.** GC's `sweepEdges`, `GcResult.deletedEdges`, `vacuum (analyze) git_edge`, and `reindex index git_edge_walk` are all DELETED — `sweepEdges` exists only because 0003 has no FK, and the 0008 cascade already proved the pattern. Postgres does the bookkeeping. (Breaking export change to `GcResult`/`DrainEntry`; semver treatment is an OPEN item.)
5. **Derived transactionally, asserted, never fallback-parsed.** `insertObjects` already writes object + derived rows in one transaction; it now writes `git_commit`/`git_tag` rows there (`deriveEdges` → `deriveCommitRow`/`deriveTagRow`). "Every stored commit object has a `git_commit` row" is an invariant, not a hope; consumers never fall back to parsing commit bodies when a row is missing — absence is a loud error.

### Numbers

| | today (komal) | new (komal) | at 10× |
|---|---|---|---|
| topology storage | `git_edge` 299.81 MB (206.52 MB indexes), 1.1 M kind-3 rows | `git_commit` ≈ 1,490 rows ≈ 0.25 MB + `git_tag` ≈ 0 | ~30 GB avoided (×100, quadratic) → ~1.5 MB (×10, linear) |
| database total | 373 MB | **≈ 73 MB (−80%)** | ≈ 37 GB → ≈ 6.9 GB (−81%) |
| growth exponent (topology) | 1.99 measured | 1.0 (commits) | — |
| per-push ingest (1 commit at HEAD) | ~1,492 edge rows ≈ 427 KB heap+index | **1 row ≈ 130 B** | same |

### Migration

Both new tables are pure functions of `git_object.content` (the raw-content authority, D1): a backfill parses `type in (commit, tag)` rows per repo — 1,490 body reads at komal (<1 s), ~14,900 at 10×, ~150 k at the 100× scale target (single-digit minutes, offline, resumable) — computes generations in one topo pass, writes the rows, then `drop table git_edge` reclaims ~300 MB instantly with no VACUUM. **No re-push and no live-data migration needed**, though the user has waived that constraint anyway; fresh deployments get the schema for free.

---

## Chunk 2 — Reachability (APPROVED 2026-08-17)

`reachableClosure`'s one-maximal-answer engine becomes **three shapes in one module**, each matched to its consumer. `git_object` stays the raw-content authority (D1), so a deltified tree is never in any recursion path — walks always read raw `content`.

**R1 — `fullClosure(roots, omitBlobs)`.** Level-synchronous BFS in JS: commits/tags from their tables (one batched query per level), tree children parsed from `git_object.content` in ≤1,000-oid value-list batches (the existing `LOOKUP_BATCH` idiom; value-lists because porsager cannot bind `bytea[]`). One tree parse yields subtrees AND blobs — today's separate blob-enumeration pass is absorbed, not added. Consumers: cold clone (no haves), GC's live set, tree-typed wants. Reads the same tree bytes the closure reads today (~70 MB komal, §N1), minus the 1.1 M-row CTE.

**R2 — `frontier(wants, haves)` — git's `mark_uninteresting`, and the panel's one non-negotiable.** A JS priority queue over `git_commit` keyed `generation desc` (NULL ≡ infinity pops first). NEVER a stop-at recursive CTE: a `UNION` CTE computes a monotone least fixed point, and "reachable-from-wants MINUS reachable-from-haves" is non-monotone — the subtraction must propagate through the haves' own ancestry. The killing counterexample (correctness critique): on `M ← (P, Q)` with `have Q, want M`, stopping AT `Q` never marks `Q`'s ancestors, so the walk descends `P` to the merge base and everything below it — an unbounded over-send that fails the byte-identical bar. The PQ's exactness claim is SCOPED: in the finite-generation region, chunk 1's strict `gen(parent) < gen(child)` invariant makes descending-generation pop order a valid reverse-topological order, so INTERESTING/UNINTERESTING flags propagate with no date heuristics and no SLOP; terminate when no INTERESTING entry remains. In a NULL region (cross-pack orphan residue — rare once in-pack resolution exists, chunk 1) the queue orders by `commit_time desc` (git's pre-generation fallback); a mis-ordered pop there can OVER-send — never under-send, since UNINTERESTING marks only ever propagate from have-reachable commits — and the walk has no date-slop cutoff, so completeness is unconditional. Then per new commit: `treeDiff` its root tree against its boundary parents' root trees (n-way — a merge puts each below-cut parent's tree in the boundary set); any oid seen on the old side prunes that subtree whole and accumulates into **`clientHas`** (spent by chunk 3's D8′). `omitBlobs` threads through here exactly as through R1: a `blob:none` fetch drops blob entries from the diff output — the filter's behaviour is unchanged by this design, and the promisor/lazy-want path is R4's, not the filter's.

**R3 — `ancestry(want, commons)`.** The existing negotiation CTE retargeted at `unnest(git_commit.parents)` + `git_tag` for tag wants, with a generation fast-fail for `isAncestor` (`gen(old) ≥ gen(new)` ⇒ not an ancestor, no walk).

### The load-bearing guards (critic-resolved)

- **R4 — Want-type router.** Wants partition by stored type BEFORE any walk: commit/tag → frontier; tree → `fullClosure` from that tree; blob → the blob itself. Preserves the promisor rule verbatim (a partial-clone lazy `want <blob-oid>` must not be subtracted and must not return an empty pack — two of three proposals had exactly that bug; `object-store.ts` documents the rule today).
- **R5 — Push connectivity = `frontier(newTip, boundary = pre-push ref tips)`** + one existence probe over the un-pruned set. Sound with ZERO GC change — with the premise NAMED: objects under a tip that GC's pinned snapshot saw are in the live set and cannot be swept mid-check; a tip advanced AFTER that snapshot is covered by the grace window (D13), the same defense it has today. The residual window is also today's, unchanged by this design: an orphan older than `graceSeconds` that a new push re-references can be absent from a concurrent pass's live set — D13's known trade, matching git's. Anything NOT under a tip (a denied push's stored-but-unverified orphans) is walked, not trusted. Rejected alternatives, both critic-killed: a bare existence probe (unsound — grace is per-object with no propagation, so a young orphan tree survives while the old blob it references is reclaimed, and the probe accepts a push into a corrupt graph) and a GC rewrite to recency-propagation (sound but a large blast radius bought for something the ref-tip boundary gets free; D13 stays exactly as the user decided it).
- **R6 — No connection pinning.** The walk is already multi-statement on the pool today; the encode phase sits outside any snapshot either way. Keep the loud `vanished while packing` error; do not spend a `reserve()` per fetch.

### Numbers

| consumer | today (komal) | new (komal) | new (10×, modelled) |
|---|---|---|---|
| warm fetch, 1 commit | 2 full closures: 2 × 1.1 M rows + 2 × 70 MB; ~30 RT | 1 commit row + 2 root trees + ~6 subtrees ≈ **200 KB, ~6 RT** | ~1.9 MB, ~8 RT (root-tree-bound, §N1) |
| push connectivity | full closure per ref command | ~200 KB, ~5 RT | ~1.9 MB |
| cold clone | 1.1 M-row CTE + 70 MB trees | 70 MB (CTE deleted); bitmaps (chunk 5b) take it to ~282 KB | 7 GB → ~30 MB via chunk 5b |
| GC live set | CTE + 70 MB + edge sweep | 70 MB, no edge sweep; epoch ∪ delta (chunk 5b) on the happy path | 7 GB → delta-sized |
| negotiation | kind-2/5 CTE | same CTE over `git_commit`, gen-pruned | — |

## Chunk 3 — Serve: warm fetch, thin-pack, D8′ (APPROVED 2026-08-17)

**R7 — The wire.** `parseFetch` gains `thinPack: boolean` (today the arg falls through every branch and is silently dropped — that IS W3); the capability advertisement gains `thin-pack`. `ofs-delta` stays parsed-and-ignored — REF_DELTA-only remains legal in any pack. Fetch flow: `commonHaves` (unchanged) → `readyToGiveUp` (over `git_commit`, generation-pruned) → `frontier` (carrying `omitBlobs` from the filter, per R2) → served set + `clientHas`. `buildPack`'s have-closure and set subtraction are DELETED; the `want.missing → WantNotFoundError` guard survives verbatim; `include-tag` augmentation moves onto `git_tag`.

**R8 — D8 → D8′ (amends the delta-pack design).** *A served delta's base must be provably resolvable by the client — in the served pack, or, when the client negotiated `thin-pack`, in `clientHas`.* The proof is by construction, not inference: an oid is in `clientHas` precisely because a boundary tree — reachable from a stated have — named it. Without `thin-pack`, behaviour stays byte-identical to today. Correctness bar: `git index-pack --fix-thin` + `fsck --strict` ingest every served thin pack. Honest scope: today's `--fix-thin` harnesses cover the ENCODER side only (`perf/delta-corpus.ts`, `src/pack/encode-delta-oracle.test.ts`); the served-pack wire gate is NEW work in S5 and is that slice's only net — build it first.

**R9 — Warm-fetch deltas are computed AT SERVE TIME**: `encodeDelta(boundaryTree, newTree)` with the same oracle-tested encoder repack uses — never read from the tier. Critic-resolved against "reuse the tier's rows": under D2's `ANCHOR_EVERY=32` a stored tree's `base_oid` is its segment anchor, up to 31 commits back, while `clientHas` holds version N−1 — the stored base is provable ~1 fetch in 32, and the other 31 ship the root tree whole, preserving the 3–11× gap. The serve-time base is N−1 itself: ~200 B instead of 95 KB (954 KB at 10×), sub-millisecond, depth ≤ 1 so D9 holds. HONEST COST, documented not hidden: the system now has TWO delta producers (repack → cold tier rows; serve → warm boundary deltas), so "why did this client get this delta" has two answers. The tier's role is unchanged: the cold-clone byte copy (D1–D5 untouched).

**R10 — Minimality stance.** Name-paired diffing can over-send an object the client holds at a DIFFERENT path (rename, revert-to-old-tree). Believed git-matching (git's sparse boundary-marking over-sends the same shapes) but ASSERTED, not verified — the new served-set-vs-canonical-git oracle test is the arbiter, and the priced upgrade if it disagrees is small: fully expand boundary root trees as an oid blacklist (~200 KB komal / ~2 MB at 10×, the same order as the diff). Decided as R16.

**R11 — Streaming (W4) deliberately not here.** Post-frontier, a warm pack is kilobytes; the only streaming candidate was the ~5.7 MB cold clone. Decided OUT OF SCOPE entirely as R17. The frontier still leaves streaming's precondition free (object count known before any content is read) should a future track want it.

Net effect on the hunt's numbers: warm transfer 95 KB → ~200 B per changed tree (the 3–11× collapses to ~git parity); warm serve cost fixed by chunk 2; cold clone untouched.

## Chunk 4 — `repo_file` maintenance (APPROVED 2026-08-17)

The read contract is untouched — same table, columns, and `⋈ git_object` join. The maintenance inverts from rebuild-everything to diff-driven.

**R12 — The basis is PERSISTED, never inferred.** The seam is treacherous, verified in source: `syncRefSnapshot(ref, newOid)` carries NO old oid and runs after the push commits, with failures absorbed. Inferring the basis from the push command makes a TORN projection representable (a diff applied onto rows from a different basis matches no commit, permanently) — the state-class D14 exists to forbid. So:

```sql
create table repo_file_head (      -- which commit repo_file currently reflects, per branch
  repo_id bigint not null references repos (id) on delete cascade,
  ref_name text not null, commit_oid bytea not null,
  primary key (repo_id, ref_name)
);
```

Runner-up was a column on `git_ref` (one column beats one table on bytes); the table won on OWNERSHIP boundaries: the projection is an explicitly droppable/rebuildable derived surface, its watermark lives with it and dies with `clearRepo`, and repo-view never writes the refs-store's table.

**R13 — Per push, ONE transaction:**
1. `select … from repo_file_head … for update`;
2. `head = newOid` → no-op (idempotent replay);
3. head ABSENT → full rebuild, today's code verbatim (`buildFileList` + delete-branch + `copyInsert`) + insert the head row — new branch, first sync, post-`clearRepo`, all one path;
4. `newOid` descendant of head (one R3 `ancestry` query) → `treeDiff(head.tree, new.tree)`; `delete` removed paths; `insert … on conflict (repo_id, ref_name, path) do update set mode, blob_oid` for added ∪ changed; update head;
5. ELSE SKIP — a newer push already projected past us. The monotonicity guard the current code lacks; turns the standing `pg-txn--projection-stale-overwrite` breakage test green: the projection only moves FORWARD along the branch.

**R14 — Two earned details.** Mode-only changes (same blob, `100644`→`100755`) count as changed: the diff pairs by name and compares `(mode, oid)`, not oid alone. And basis+rows moving in one transaction makes today's silent-drift mode (post-commit sync failure, console-only) self-healing — head didn't advance, so the next push recomputes from it.

Numbers: a one-file push to a 4,096-file tree drops from 8,192 row writes to 2–3; the measured 1,428× disk / ~3,101× WAL amplification collapses to ≈ git's. `mode`/`blob_oid` are unindexed so the upsert path is HOT-eligible; whether to reserve `fillfactor` for it is a chunk-5 open item (lean: leave at 100 — 3 rows/push needs no HOT reserve).

## Chunk 5 — The user's decisions (DECIDED 2026-08-17, user's words quoted)

- **R15 — Cold-clone cost: reachability bitmaps, NOW (produced by the GC pass — see chunk 5b; the user's option label said "at repack", and the drain runs GC→repack, so "at drain time" is the accurate reading).** (user: "(b) build reachability bitmaps at repack now. cold-clone is a key use-case") The one divergence from the panel lean (which was accept-with-trigger). The concrete design is chunk 5b below, including the roaring-library dependency the user approved in R21.
- **R16 — Warm-fetch minimality: ship name-pairing; the oracle arbitrates.** (user: "(a) ship name-pairing and let the new served-set-vs-git oracle test arbitrate; upgrade only if it disagrees") The priced upgrade (full boundary-tree expansion, ~200 KB komal / ~2 MB 10×) is built only if the served-set-vs-canonical-git oracle disagrees with name-pairing.
- **R17 — Streaming: OUT OF SCOPE.** (user: "(c) drop it from scope entirely") W4 is closed for this design — no streaming work, no TTFB measurement owed here. The frontier still leaves the precondition free (object count known before content reads) if a future track wants it.
- **R18 — `repo_file` fillfactor stays 100.** (user: "(a) leave leaves at 100") No per-partition ALTERs; 3 rows/push needs no HOT reserve. The 0002 "no fillfactor reserve" comment gets refreshed to say why it is STILL right under the new write shape.
- **R19 — The breaking exports ship as a MAJOR.** (user: "(a) major") `GcResult.deletedEdges` / `DrainEntry.deletedEdges` removal (compounding this week's `deletedEncodings` removal) is a semver-major release of `@usecontextlayer/pggit`.
- **R20 — Same-path blob deltas: not in the first pass.** (user: "(a) not in the first pass; measure after the tree win lands") Measure the residual warm-transfer gap on komal after R9 lands; build blob deltas only if the number asks for it.

## Chunk 5b — Reachability bitmaps (APPROVED 2026-08-17 — explicitly, post-audit: "chunk 5b is approved"; incorporates the user's library/idioms amendment)

Git's `.bitmap` keys bit *i* to the *i*-th object in pack order. The analog: each repo carries one **epoch** — a sorted, concatenated array of all live oids — and one compressed bitmap per ref tip over that ordering (bit *i* ⇔ `oids[i]` reachable from that tip).

```sql
create table git_reach_epoch (
  repo_id bigint not null references repos (id) on delete cascade,
  epoch   bigint not null,                  -- monotonic per repo
  tips    bytea  not null,                  -- the ref-tip oids this epoch covers
  oids    bytea  not null storage external, -- sorted 20-byte oids; bit i ↔ slice i
  primary key (repo_id),                    -- exactly one live epoch per repo…
  unique (repo_id, epoch)                   -- …addressable by (repo, epoch) for the bitmap FK
);
create table git_reach_bitmap (
  repo_id bigint not null,
  epoch   bigint not null,
  tip_oid bytea  not null,
  bits    bytea  not null storage external, -- serialized roaring bitmap (portable format)
  primary key (repo_id, tip_oid),
  constraint git_reach_bitmap_epoch_fk foreign key (repo_id, epoch)
    references git_reach_epoch (repo_id, epoch) on delete cascade,
  constraint git_reach_bitmap_tip_fk foreign key (repo_id, tip_oid)
    references git_object (repo_id, oid) on delete cascade
);
```

`epoch` in BOTH keys is load-bearing, not observability (session-audit fix): bitmap bits are positional against ONE epoch's `oids` array, and the composite FK makes cross-epoch skew unrepresentable — replacing an epoch row cascades every bitmap of the old epoch away atomically, so a bitmap can never be read against a different epoch's array. Neither table is partitioned (one small row per repo / per tip); `storage external` is declared in the DDL, and the migration's test reads `pg_attribute.attstorage = 'e'` back off these tables directly (they have no partitions — the leaf-check phrasing in earlier drafts was wrong).

**R21 — A proper bitmap library, per the user.** (user: "use a proper bitmap library. everything, not just bitmaps, needs to be implemented ideally. it costs you nothing. but it makes reading/editing code so much easier! and use postgres idioms, foreign keys, etc...") `bits` is a CRoaring-serialized roaring bitmap; ops (OR across tips, membership, iteration) go through the library, never hand-rolled typed-array code. Concrete package chosen at implementation time between `roaring` (native CRoaring binding) and `roaring-wasm` (no native build for consumers of the published npm package) — the WASM lean exists because pggit ships as a library and tsdown/native-addon interplay is a known trap; the serialization is CRoaring's PORTABLE format either way, which also keeps the door open to in-database ops via the `pg_roaringbitmap` extension on deployments that ever allow extensions. This is the approved new dependency.

**R22 — Producer: the GC pass, with the steady state spelled out** (session-audit fix — the first draft's "one walk" contradicted R23's no-walk happy path, and its snapshot claim was impossible against `gc.ts`'s sequencing). Three regimes:
- **First pass / post-rewind (full walk):** GC's live-set walk visits every live object from every tip; it carries per-tip membership masks during that walk (multi-source reachability, one pass) and derives the epoch from them.
- **Steady state (no full walk — consistent with R23):** when every current tip descends from the stored epoch's tips, live = epoch ∪ `frontier(current tips, boundary = epoch tips)`, and refs-only-advance means the old closure is a SUBSET of the new — so the new epoch is old `oids` ∪ delta oids (re-sorted), and each advanced tip's bitmap is its epoch-ancestor's bitmap REMAPPED to the new array OR'd with its delta's membership bits (roaring ops, R21). Unmoved tips remap only.
- **Write-cost guard:** identical tips since the stored epoch ⇒ identical closure ⇒ skip the write entirely.
Sequencing truth (per `gc.ts`): the walk's REPEATABLE READ transaction COMMITS before the sweep's short write transactions begin, so the epoch's `tips` are **carried in JS** from the walk phase and written after the sweep on the same reserved connection — the epoch is never written "under" the walk's snapshot, and must not claim to be. Repack untouched; the drain stays GC→repack (D5).

**R23 — Consumers and guards.**
- **Cold clone** (no haves): every want an epoch tip → OR the tips' bitmaps, done — ZERO tree reads. A want that is a DESCENDANT of an epoch tip (pushes since the last drain) → bitmap ∪ `frontier(want, boundary = epoch tips)` — R2's machinery reconciles staleness.
- **GC's next pass**: live set = epoch ∪ frontier-delta on the happy path — the standing 70 MB/7 GB walk collapses to the since-last-drain delta.
- **The rewind guard**: a current tip NOT descended from the epoch's tips (a platform `setRef` rewind; push policy already denies non-FF) invalidates the bitmap path → loud fallback to `fullClosure`; the next drain re-epochs. Stale bits can only ever OVER-include rewound history — the guard is the correctness line. The `tip_oid` FK makes half of it DDL: a rewound-and-reclaimed former tip's bitmap row cascades away with the object.

**Sizes.** komal: oid blob 282 KB, ~KB-scale bitmaps. 10×: blob ~30 MB (TOASTed EXTERNAL, the 0008 profile), bitmaps far under the 187 KB raw ceiling after roaring compression. Cold-clone closure reads at 10×: 7 GB → ~30 MB (~230×). Honest costs, named: a third derived table pair to keep hygienic (same cascade idiom, droppable/rebuildable), and GC becomes the producer of a serve-path structure (the walk is shared; the ontology note is this sentence).

## What gets deleted (the net-negative ledger)

`git_edge` + `git_edge_walk` + migration 0003's table, `EDGE_KIND`, `deriveEdges`/`DerivedEdge`, `treeBlobOids` (absorbed into the one tree parse), `gc.sweepEdges` + `GcResult.deletedEdges` + `DrainEntry.deletedEdges` + `vacuum git_edge` + `reindex git_edge_walk`, `reachableClosure`'s CTE + its blob-batching + one `batches()` copy, `buildPack`'s have-closure and set subtraction, `peelRef`'s kind-5 CTE, `augmentWithTags`'s kind-5 CTE, `commitDiffOrder`'s commit-body re-parse, `encodeTreePair`'s private subtree pairing, `buildFileList`'s role as the per-push hot path (it survives for the rebuild-from-scratch case only), `rebuildRefSnapshot`'s delete-branch+COPY as the per-push path. **Added:** `src/object/tree-diff.ts` (~70 lines, four consumers: frontier, `repo_file`, repack, thin-base selection), `src/store/frontier.ts` (~130 lines), the bitmap epoch producer/consumers, five small tables (`git_commit`, `git_tag`, `repo_file_head`, `git_reach_epoch`, `git_reach_bitmap`), and the roaring dependency. Net strongly negative in code; −80% in bytes.

## Amendments to the delta-pack design (`2026-08-15-delta-pack-design.md`)

- **D8 → D8′** (R8). — **D10 discharged** (this design IS the git_edge track). — **D7/D14 extended** to `git_commit`/`git_tag`/`git_reach_*` (cascade hygiene everywhere). — **D1/D2/D3/D4/D5/D9/D11–D13/D15/D16 untouched**; R9 extends D3 (a second, serve-time delta producer) without touching the tier's frozen policy. — **C1's extrapolation corrected** per §N1 (10× tree bytes ≈ 7 GB, not 800 MB). — **W3 delivered** by R7/R8; **W4 closed out of scope** by R17; **W5 delivered** by chunk 1; **W7 delivered** by chunk 4; **W8 delivered** by chunks 2–3.

## Slices (each independently shippable; money lands early)

| # | Content | Gate / test story | Risk |
|---|---|---|---|
| **S1** | `git_commit`/`git_tag` + backfill migration; retarget `ancestryReachesCommon`, `isAncestor`, `readyToGiveUp`, `peelRef`, `augmentWithTags`, `commitDiffOrder`. KEEP writing `git_edge`. Zero behaviour change. | Existing suites unchanged; pin repack output byte-identical across the source swap; generation tests BOTH ways — a first push of a linear history yields FINITE generations (the in-pack topo pass works; all-NULL is the bug) and a denied-push orphan whose parent arrives later stays NULL (absorbing). | low |
| **S2** | `fullClosure` recurses tree content; stop deriving kind-3; `drop table git_edge`; delete `sweepEdges`/`deletedEdges`/edge maintenance — and decide `maintain()`'s remaining table list explicitly (it loses `vacuum git_edge` + `reindex git_edge_walk` here, and hunt finding M10 already flagged that it never names `git_pack_encoding`). **The 80% storage win.** | `pg-bloat--git-edge-quadratic` flips to a green regression guard; all clone/fsck oracles + the breakage corpus; rewrite `edge-derivation.test.ts`, `object/edges.test.ts`, gc suites, `pgres--encoding-storage-profile`. | med |
| **S3** | `tree-diff.ts` + `repo_file_head` + incremental projection + descendant guard (chunk 4). | fast-check differential: N random pushes ⇒ incremental ≡ full rebuild row-for-row; `pg-txn--projection-stale-overwrite` turns green; `pg-bloat--push-amplification` collapses. | low |
| **S4** | `frontier` PQ + want-type router; warm fetch and push connectivity move onto it (chunk 2). | NEW ORACLE: served-set equality vs canonical git for every corpus fixture × (want, have) pair — merge, octopus, criss-cross, rename, revert, tag-want, blob-want, rewound have, present-but-orphaned parent; `perf--incremental-fetch` collapses. | high |
| **S5** | `thin-pack` parse + advertise; serve-time boundary deltas; D8′ (chunk 3). | `git index-pack --fix-thin` + `fsck --strict` on every served thin pack; negative test: no `thin-pack` negotiated ⇒ no external base ever emitted. | med |
| **S6** | Bitmaps (chunk 5b): roaring dep, epoch producer in GC's walk, cold-clone + GC consumers, rewind guard. | Bitmap-served clone byte-identical to walk-served clone on every corpus fixture; rewind fixture falls back loudly; epoch-skip fires on quiet drains; `perf` cold-clone closure reads drop ~230× at scale. | med |
| **S7** | Refactoring/compression pass over the landed slices — the user agreed to post-implementation refactoring passes up front ("note that we'll also do some refactoring passes after implementation/testing is complete"). | The full suite stays green; net line delta of the pass itself trends negative. | low |
| **REL** | Semver-MAJOR release of `@usecontextlayer/pggit` (R19) after S1–S7. The major explicitly covers BOTH breaking export removals: `deletedEdges` (this design) and `deletedEncodings` (already removed by the 2026-08-16 pass). | The release ladder in CLAUDE.md; dry-run first. | — |

## Arithmetic summary (komal / 10×, vs today)

| Operation | Today | New |
|---|---|---|
| Warm fetch, 1 commit — serve | 2 closures: 2×1.1 M rows + 2×70 MB (10×: 2×7 GB); 100% of serve cost | ~200 KB, ~6 RT (10×: ~1.9 MB — root-tree-bound, §N1) |
| Warm fetch — transfer | ~95 KB tree shipped whole (10×: ~954 KB) | ~200 B boundary delta (thin-pack) |
| Cold clone — closure | 1.1 M rows + 70 MB (10×: 7 GB) | bitmap path: ~282 KB (10×: ~30 MB, ~230×); walk fallback unchanged |
| Push — ingest writes | ~1,492 edge rows ≈ 427 KB | 1 commit row ≈ 130 B |
| Push — connectivity | full closure | ~200 KB frontier + 1 existence probe |
| `repo_file`, 1-file push into 4,096 files | 8,192 row writes (1,428× disk, ~3,101× WAL) | 2–3 row writes |
| GC live set / pass | CTE + 70 MB + edge sweep (10×: 7 GB) | epoch ∪ frontier-delta (walk only after a rewind) |
| Database size | 373 MB (10×: ~37 GB) | ~73 MB + epoch blobs (10×: ~7 GB, −81%) |
| Topology growth exponent | 1.99 | 1.0 |

## State of the tree this design lands on

The `delta-packs` branch sits at `ab5c06d` plus a ~43-file UNCOMMITTED working tree: the 2026-08-16 defect-fix pass (driver patch, TEMP live set, FK cascades D14, repair mode D15, UTF-8 boundaries D16, and the test conformance for all of it — see the sibling doc's D11–D16). That pass is mostly verified green but has an OPEN investigation and unfinished verification, tracked in the sibling doc's status: the `shapes--negative-sweep` suite has a cumulative wedge (shapes 1–16 pass in ~108 s, every shape from `growing-toggle` (#17) onward burns its full 600 s timeout; each failing shape passes solo, and the adjacent pair passes — the poison needs accumulated state; bisection was paused mid-way). **That file was green before the 2026-08-16 changes, so the wedge is likely — not certainly — a regression those changes introduced; the suspects with new pool-facing behaviour are the driver patch, the reserved-connection GC, and the repack stamp.** And several suites have not been re-run since the pass (generative GC pair, the gc-scheduler family — which must run ALONE, `race--err-pkt-overflow` solo, the C4-rescoped `race--push-gc-repack` full run, the enlarged `pgres--encoding-storage-profile`, `lifecycle--randomized-sequence-fuzz`, and a final full CI-tier run). **Slice S1/S2 of this design rewrites several of the same GC/edge suites — finish or fold that verification tail into S1/S2's test work rather than duplicating runs.**

## Implementation notes

### Decided — implementation

- **`git_commit` rows are written with multi-row INSERT value-lists, not binary COPY** — `parents bytea[]` has no encoder in `copy-insert.ts` (scalars only), and PGCOPY array format (element-oid/dims headers) is real work for tiny volume: one row per commit, a push carries few, the backfill batches ≤1,000. Rejected: extending the binary-COPY primitive with array encoding — unneeded complexity until a bulk consumer exists. (Session-audit fix: the first draft declared the column with no write path at all.)
- **One reachability module.** `fullClosure`/`frontier`/`ancestry` are three exports of ONE `src/store/` module that replaces `reachability.ts`; the want-type router (R4) and the bitmap fast path (R23) live INSIDE it, never at call sites. Rejected: letting each consumer compose walk+guards itself — that is how the "one engine" promise erodes into scattered branches.
- **The S1 backfill parses commit/tag bodies APP-SIDE**, reusing the existing parsers. Rejected explicitly (panel, on ontology): a SQL/plpgsql tree/commit parser so migration or closure could stay in-database — a second implementation of the fsck-critical grammar is two truths for one concept, drifting against the oracle.
- **Serve-time warm deltas (R9) reuse `encodeDelta`** — the oracle-tested encoder repack uses. No second delta encoder.
- **The epoch producer (R22) joins `gc()`'s existing pass** on the SAME reserved connection and REPEATABLE READ snapshot (D12's shape). Rejected: a separate drain phase or repack-side production — the walk is already in hand in GC, and a second walk is the cost bitmaps exist to delete.
- **Drain components resolve repo names fresh per pass** via the unmemoized `lookupRepoId` (the 2026-08-16 M2 lesson: memoizing resolvers outside the `createGitDeps` composition go stale across repo delete/re-create and silently no-op forever).
- **Postgres value-lists (`in ${pg(list)}`), never `= any(${bytea[]})`** — porsager serializes a `Buffer[]` bind as one value (sibling doc N8). Batch at ≤1,000 oids (`LOOKUP_BATCH`) and respect the 65,534 bind ceiling; COPY for bulk writes.

### Nuances

- **Generation's child-first case.** NULL-absorbing (chunk 1) includes the non-obvious direction: a commit ingested while its parent is ABSENT stays NULL forever even when the parent arrives later — no recompute is a feature (ingest-atomicity, no crash window), not an omission. The S1 gate test pins exactly this sequence.
- **`clientHas` is provability, not existence.** The obvious base-eligibility check — "does the oid exist in `git_object`?" — is the exact wrong turn: existence proves nothing about the CLIENT. An oid enters `clientHas` only by being observed on the boundary side of the diff (R2/R8). This is the same lesson D8 encoded for in-pack bases, extended.
- **`repo_file`'s ELSE branch SKIPS, never rebuilds.** The obvious handling of "newOid is not a descendant of head" is a defensive full rebuild from newOid — which reintroduces the backwards-move race R13's guard exists to kill (a stale worker would "rebuild" the projection back to an older tip). Skip is correct: the newer push already projected.
- **Bitmap positions are against the epoch's SORTED oid array**, not walk order (also flagged under Concerns). The S6 byte-identical-clone gate is the net; the trap deserves naming because both orders produce plausible-looking bitmaps.
- **`STORAGE EXTERNAL` verification:** the epoch/bitmap tables declare it inline in their DDL and are UNPARTITIONED, so the migration test reads `pg_attribute.attstorage = 'e'` straight off those tables (no leaves exist — an earlier draft's leaf-check phrasing was wrong). For the PARTITIONED tables (`git_commit`/`git_tag` carry no big columns, so nothing to check there), the 0008 lesson stands: parent-to-leaf propagation was once an unverified expectation (sibling doc C4) — any future big column on a partitioned table gets a leaf-level attstorage check.
- **R21's "implement ideally / proper libraries" ruling covers MORE than bitmaps** (the user's sentence was general): the frontier's priority queue uses a battle-tested heap library (candidates: `heap-js` / `tinyqueue` — an approval item alongside roaring, same ask), not a hand-rolled binary heap. `tree-diff.ts` is the deliberate EXCEPTION: git's tree grammar is the fsck-critical parser this repo already owns, and no library implements git tree-diff semantics — a second grammar implementation would be two truths for one concept (the same ontology argument that rejected the SQL parser).
- **The driver patch does NOT reach consumers of the published package** (session-audit H6): `pnpm.patchedDependencies` is lockfile-local, so `contextlayer/packages/platform` and `slate-platform` — both depending on `@usecontextlayer/pggit` today — resolve UNPATCHED `postgres` and remain exposed to the COPY-hang/process-kill class in production, where the failure looks like a hung drain, not a driver bug. Distribution strategy (vendor vs upstream-PR vs both) is DEFERRED by the user ("deal with later") and recorded as the sibling doc's W9; nothing in S1–S6 fixes it implicitly, and nothing in S1–S6 is gated on it.

### Traps (pain already paid, this session)

- **The `postgres` driver is patched** (`patches/postgres.patch`, pnpm `patchedDependencies`, pinned to 3.4.9): three fixes for COPY/connection-death settle bugs. ANY version bump of `postgres` silently drops the patch's guarantees unless re-ported — and the regression does not look like a driver bug: it looks like tests (or GC passes) hanging under load with no error. A `statement_timeout` killing a connection mid-COPY was exactly the fault-sweep wedge shape before the third fix.
- **Heavy vitest batches lie.** More than ~3 testcontainer-heavy files in one invocation produced false 600 s timeouts twice; run heavy suites in small batches, the gc-scheduler family ALONE, and never pipe a test run through `tail` (masks the exit code — write to a log file).
- **Gates:** `tsc -b --force` always (tsbuildinfo caches hide errors); biome runs `--error-on-warnings`; the pnpm shim is broken on this machine — `mise x pnpm@10.34.1 -- pnpm …`. Biome REFORMATS SQL template literals when a backtick appears inside a SQL comment (mangled 0008 once — sibling doc N5). `spawn git ENOENT` almost always means a missing `cwd` (N6).
- **Kanel regenerates models** for every schema change (config must stay `.cjs` — kanel loads it through CJS `require()`); the `git_edge` model deletion and five new models ride the same slices as their migrations.

### Consequences to fold into the change

- S2 (drop `git_edge`) is gated on S1's retargets being proven — `peelRef`, `augmentWithTags`, `ancestryReachesCommon`, `commitDiffOrder` must be off the edge table before it can die; that constraint is the slice boundary, not a task list.
- S4's served-set-vs-git oracle must EXIST before the frontier lands (it is R16's arbiter and the only net under the riskiest slice).
- The sibling doc's C1 mis-extrapolation (§N1 here) gets corrected in the sibling doc in the same change that first relies on the corrected number.
- `GcResult`/`DrainEntry` shape changes accumulate across S2; the semver-major release (R19) happens once, after S6 — never mid-ladder.
- The 0002 "no fillfactor reserve" comment is refreshed (R18) in S3, the slice that makes it look wrong.

### Open — implementation

- `roaring` (native) vs `roaring-wasm`: gates S6's first line — the native addon must survive tsdown packaging of a published library (native deps must be `dependencies`); lean WASM, decide by trying the build.
- Ref-count census on live `ctx_pggit` (how many tips per repo): gates S6 sizing only; everything else proceeds.
- Serve-time delta budget for months-behind fetches: uncertain, not blocking — measure after S5, cap only if the number asks.

## The subjective layer (what would otherwise die with the design session)

**Thoughts.** Build S4's served-set-vs-git oracle BEFORE the frontier, not after — it is the arbiter for R16 and the only trustworthy net under the highest-risk slice. Write `tree-diff.ts` test-first against `git diff-tree` output as its oracle. Implement slices sequentially; S1/S2 are mechanical, S4 is where the thinking happens.

**Concerns.** (1) R9's serve-time delta encoder runs per changed tree per fetch — sub-millisecond each, but a months-behind client's frontier can hold thousands of changed trees (~1 ms each ⇒ seconds of CPU on one request). Nothing in the design caps it. If it bites, the priced guard is a per-fetch delta budget (beyond N changed trees, emit whole forms — correctness unaffected, D8′ never violated). NOT decided; measure first. (2) The bitmap bit↔oid mapping is positional against the epoch's SORTED oid array — building bitmaps in walk order instead of sorted order is the silent-corruption bug class here; the byte-identical clone gate in S6 is the net, but the implementer should know the trap by name. (3) The epoch's `tips` snapshot must be the GC walk's REPEATABLE READ snapshot tips, not re-read at write time — a push landing mid-pass must not smuggle a tip the walk never covered.

**Fears.** The "one reachability engine" promise erodes during implementation into three engines plus guards plus fallbacks scattered across call sites — the module boundary (ONE `src/store/` reachability module exporting exactly `fullClosure`/`frontier`/`ancestry`, with the router and the bitmap fast path INSIDE it) is the defense; hold it.

**Questions (load-bearing).** (1) How many refs do real workspace repos carry (chat-home snapshot repos)? Gates S6's per-tip bitmap fan-out and epoch write cost — check live `ctx_pggit` before building S6. (2) `roaring` (native) vs `roaring-wasm`: the native addon must survive tsdown packaging of a published npm library (native deps must be `dependencies`, not bundled) — resolve at S6 start, lean WASM.

**Latent nuances.** The bitmap path serves ONLY no-have fetches — any stated have routes to the frontier, always; there is no bitmap subtraction in this design (that is deliberate — staleness reconciliation for subtraction is where git's bitmap complexity lives, and we skipped it). The epoch universe is the FULL live set including tag objects (GC's walk descends tag chains), so `include-tag` augmentation works against bitmap-served clones. R3's generation fast-fail direction: an ancestor's generation is STRICTLY smaller, so `gen(candidate) ≥ gen(descendant)` proves non-ancestry; NULL on either side means walk. The S1 backfill must compute generations in one topo pass per repo — per-row `1 + max(parents)` lookups against a partially-backfilled table would be quadratic round-trips.

**Curiosities (noticed, not pulled).** CRoaring's portable serialization is readable by the `pg_roaringbitmap` extension — if a deployment ever allows extensions, bitmap ops could move in-database with zero migration. The epoch blob doubles as a cheap "repo object census" surface. The panel's performance critic invented a design nobody proposed (persisted live set, epoch-invalidated) that became the degenerate case of chunk 5b — the propose→critique→synthesize shape earned its cost this run.

**Ideas.** After S4+S5 land, re-run the end-to-end komal-mirror probe (`perf/delta-probe.ts`) plus `perf--incremental-fetch` and put the warm-fetch number beside the hunt's 3–11× as the H7 closure evidence.

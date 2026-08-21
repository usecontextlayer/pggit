# Conversion mapping — lens `pg-bloat`

> **Point-in-time conversion record (2026-08-15).** Unless a row explicitly says it was amended, mechanism names below (`git_edge`, full `repo_file` rewrites, pre-spine GC sweeps) describe the code as converted, not the landed derived-state spine. They remain here as historical provenance; current harness headers and the 2026-08-17 design record are authoritative.

8 source scripts assigned, 8 converted (7 perf harnesses + 1 e2e test). 3 shared helpers ported, none of which is a test.

| source (`breakage/…`) | destination | kind | exact property it asserts / measures | expected current state |
|---|---|---|---|---|
| `pg-bloat--copy-staging-catalog-churn.ts` | `perf/probes/pg-bloat/copy-staging-catalog-churn.ts` | perf | WAL attributable to `copyInsert`'s `create temp table … on commit drop`, isolated against a control loop of identical shape (200 iterations each), × the staging-table count of a real push/repack workload. Fails past `SHARE_LIMIT = 5%` of the workload's own WAL. Also reports temp-file spill and pg_class/pg_attribute/pg_type/pg_depend file growth, both explicitly marked NOT attributable on a shared instance. | perf-diagnostic — the source's own reading is "a real but SMALL cost … a *document it* item, not a defect"; exit stays 0 unless the 5% share is crossed |
| `pg-bloat--encoding-tier-vs-git-pack.ts` | `perf/probes/pg-bloat/encoding-tier-vs-git-pack.ts` | perf | `git_pack_encoding` on-disk total ÷ the pack a real `git clone` over the wire actually received. Fails past `TIER_LIMIT = 2.0×`. Itemises payload/heap/TOAST/index and the per-row Postgres tax, and bills the current `git_object + git_commit + encoding` tiers against `git gc --aggressive`'s packfile (design D1, amended for landed S2). Keeps the `--repo=` real-repo path (mirror clone, source stays pristine) and the `git fsck --strict` check on the clone. | perf-diagnostic |
| `pg-bloat--force-push-churn.ts` | `perf/probes/pg-bloat/force-push-churn.ts` | perf | Per-table on-disk size after N force-push rounds under the drain's `gc(maintain:false)` + `repack()`, at an UNCHANGED live row count vs the base push. Fails when any such table exceeds `BLOAT_THRESHOLD = 2.0×` its base size. Also: per-leaf autovacuum eligibility arithmetic, a 180 s settle window, `VACUUM VERBOSE`'s "dead but not yet removable" line, and index bloat vs the `VACUUM FULL` rebuild. | perf-diagnostic |
| `pg-bloat--gc-sweep-pins-vacuum-horizon.ts` | `perf/probes/pg-bloat/gc-sweep-pins-vacuum-horizon.ts` | perf | Peak single-transaction duration held by ONE `gc()` pass, sampled every 500 ms from an independent connection. Fails past `PIN_LIMIT_MS = 60 s` (one `autovacuum_naptime`). Also: the `horizon_canary` control table (dead tuples unrelated to git), the terminating anti-join `EXPLAIN (ANALYZE, BUFFERS)`, and the cluster horizon lag before/during/after. | perf-diagnostic |
| `pg-bloat--git-edge-quadratic.ts` | `perf/breakage/pg-bloat--git-edge-quadratic.ts` | perf | Log-log growth exponent of `git_edge` bytes over the last doubling of history length (sweep 100→1600 commits). Fails past `EXPONENT_LIMIT = 1.35` (super-linear). Also: rows/commit, marginal cost per commit, rows by edge kind, index vs heap share, and git's packfile for the identical objects as the baseline curve. | perf-diagnostic |
| `pg-bloat--push-amplification.ts` | `perf/probes/pg-bloat/push-amplification.ts` | perf | `repo_file` tuples WRITTEN (`n_tup_ins + n_tup_del`) by one commit, ÷ the number of files that commit changed, across 4 tree shapes × F ∈ {1,16}. Fails past `AMP_LIMIT = 50×`. Also: per-table on-disk delta, own-backend WAL vs cluster WAL (the noise floor), and the same push's cost in a bare git repo. | perf-diagnostic |
| `pg-bloat--repo-file-projection.ts` | `perf/probes/pg-bloat/repo-file-projection.ts` | perf | `repo_file` on-disk size after 60 one-file pushes ÷ its size after the base push, at an unchanged live row count. Fails past `BLOAT_LIMIT = 2.0×`. Also: per-push ins/del/upd/HOT counters (HOT is structurally 0), WAL per one-file push, autovacuum passes, and the `VACUUM` / `VACUUM FULL` floors. | perf-diagnostic |
| `pg-bloat--toast-storage-propagation.ts` | `src/e2e/breakage/pg-bloat--toast-storage-propagation.test.ts` | **e2e** | Design-doc **C4**. (1) `pg_attribute.attstorage = 'e'` on `git_pack_encoding.data` for the parent AND every leaf partition; `git_object.content` leaves match their parent. (2) A/B control on two locally-created hash-partitioned tables: the default-storage one compresses 16 KiB of `0x41`, the `storage external` one does not. (3) The decisive probe — the same value through the SHIPPED `git_pack_encoding` is stored verbatim. (4) On real repack output: `sum(pg_column_size) ≥ sum(octet_length)` (no second compression pass), out-of-line values ≤ rows over ~2 kB, and a second deflate pass over 2000 rows is pure loss. | GREEN negative — the design doc records C4 as confirmed; the assertions encode that correct behaviour |

## Routing call for the e2e outlier

`pg-bloat--toast-storage-propagation.ts` is the ONE script in this lens routed to
e2e. Its exit condition is not a threshold: `failures` increments only on two
discrete facts — a leaf whose `attstorage` is not `'e'`, and a shipped-table probe
row that came back compressed. Both are pass/fail on a catalog/behavioural value,
and the script builds its own repo hermetically (`git fast-import`, 300 run
commits over 20 docs), so it fits `src/e2e/breakage/` exactly. Everything in it
that IS a measurement (section 4's cost accounting) is secondary to that verdict
and was kept inside the one destination, restated as the assertions listed above.

Two disclosed substitutions in that conversion:

- The script's local `buildStream` (300 run-dir commits over 20 docs) is built by
  the house fixture `createAppendOnlyRepo({ docs: 20, runs: 300 })` — same shape,
  same scale, and the C4 verdict does not depend on payload sizes.
- The two on-disk size tables it printed for `git_pack_encoding` / `git_object`
  (heap/toast/index/total) are dropped: they are prints, not checks, and they
  would have required inlining the partition-summing `sizeOf` helper into a test
  that never reads its result. The same numbers are measured — with a threshold —
  by `perf/breakage/pg-bloat--encoding-tier-vs-git-pack.ts`.

## Helpers (not tests)

| source | destination | kind | note |
|---|---|---|---|
| `breakage/_bloatlib.ts` | `perf/probes/pg-bloat/_util.ts` | utility/helper, not a test | Ported: `sizeOf`, `sizesAll`, `stats`, `aggregate`, `horizon`, `vacuumVerbose`, `vacuumAnalyze`, `vacuumFull`, `taggedPool`, `flushStats`, `backendWal`, `walBytes`, `tempStats`, `catalogSizes`, `rawIndexSizes`, `scratchRoot`, `filler`, `runDirName`, `duBytes`, `reachableObjects`, `TABLES`, `PARTITIONED`, formatting helpers. `catalogCounts` and `indexSizes` were NOT ported — no assigned script imports them. `PG_URL` became `DEFAULT_PG_URL` + a shared `flag()` so every harness takes `--pg=`. `objectsBetween` was hoisted here: five of the seven harnesses each carried a byte-identical private copy. |
| `breakage/_bloat_horizon_gate.ts` | `perf/probes/pg-bloat/_util.ts` → `horizonGate()` | utility/helper, not a test | Operator diagnostic. Read-only over `pg_stat_activity`; answers "is the cluster vacuum horizon free?" before believing any reclaim number. |
| `breakage/_bloat_who_holds_xmin.ts` | `perf/probes/pg-bloat/_util.ts` → `whoHoldsXmin()` | utility/helper, not a test | Operator diagnostic. Read-only; names the pid/db/statement pinning the cluster-wide xmin. |

## The vacuum-horizon caveat (preserved verbatim where the source carried it)

A snapshot's xmin is computed cluster-wide, so ONE long-running transaction — in
any database of the instance, including pggit's own GC sweep — pins
`data_oldest_nonremovable` for every table everywhere. Under a pinned horizon
VACUUM runs, reports "dead but not yet removable", and reclaims nothing, so every
bloat number here is a LOWER BOUND: it measures "vacuum could not reclaim", not
"the tuning never fired". That is why the two bloat harnesses
(`force-push-churn`, `repo-file-projection`) gate on a ratio between two states
holding IDENTICAL live content rather than on a VACUUM-FULL ratio — that
criterion survives a pinned horizon — and why the three horizon-aware harnesses
(`force-push-churn`, `repo-file-projection`, `gc-sweep-pins-vacuum-horizon`) print
the horizon lag and the `!! HORIZON WAS PINNED` banner. The other four
(`encoding-tier-vs-git-pack`, `copy-staging-catalog-churn`, `push-amplification`,
`git-edge-quadratic`) never touched `horizon()` in the source either, so they carry
no such banner. `gc-sweep-pins-vacuum-horizon` is the harness about the pinning itself.

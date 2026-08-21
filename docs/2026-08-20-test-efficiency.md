# Test-suite efficiency — mandate, measurements, and running record

An offshoot of the excellence pass (`docs/2026-08-20-excellence-pass.md`): the full vitest gate costs ~48–60 minutes of heavy load and the owner's laptop pays for it. The mandate, in the owner's rulings: **no full-suite runs without explicit permission**; scheduling tricks (process priority demotion, fewer workers, owner-scheduled gates) were considered and **rejected** — the sanctioned direction is making the test CONTENT less wasteful and a little smaller in budget, driven by flamegraphs and empirical hotspot evidence, never by guesses about what "looks slow."

## The measurement baseline, and what corrupted it

Reference for a healthy full gate (quiet box, morning of 2026-08-20): 164 files, 653 tests, green, **2,897 s wall / 5,971 s summed test time** (parallel project maxWorkers 3, then the solo phase).

Every afternoon measurement that day was corrupted: twelve orphaned CPU busy-loops — leftovers of another agent session's git-clone-under-load probe whose cleanup died with its parent — saturated ~10 cores for 5h14m (load average 78–99). Killed by exact PID with owner permission at ~20:35. Under that load the same suite ran 5,047 s and 3,591 s wall with spurious failures (a fuzz-suite timeout, a hook timeout, a race suite losing every timing window). Standing lesson: **check the load average before trusting any timing or any "flaky" verdict** — thermals and `top`'s first sample (whose %CPU column is always 0.0) both said the box was idle while it was at load 80.

## Where the time goes (per-file ranking)

Source: vitest's own results cache (`node_modules/.vite/vitest/*/results.json` — the entry keyed by project name `pggit` holds `[file, {duration}]` per test file from the last completed run; no rerun needed). Last full run, load-inflated ~1.5× but rank-stable:

- Total: 9,183 s summed test time across 164 files.
- **`src/e2e/breakage/race--clone-vs-repack.test.ts` alone: 2,593 s = 28%** — ~5× the runner-up.
- Top 7 files = 55%; top 25 = 80%. The remaining 139 files are not worth touching.
- Top of the list, in order: race--clone-vs-repack (2593s), race--two-pushes-repack (552s), shapes--negative-sweep (481s, solo), race--concurrent-repack (408s), race--err-pkt-overflow (379s), race--short-pack-closure-truncation (374s), pg-txn--clone-vs-rewind-gc (305s), shapes--repack-param-limit-many-small-objects (294s).
- The 30-minute fuzz timeout seen earlier that day was load+bug artifact, not a real cost: `lifecycle--randomized-sequence-fuzz` is not in the top 25 on a green run.

## The structural hypothesis (to be confirmed by profiling before any fix lands)

Read from the sources of the whole race family: each heavy file is `N iterations × (re-seed the SAME immutable multi-thousand-object fixture into a fresh repo via store.putPack, plus repacks/clones/fscks)` wrapped around a race window of a few seconds. Counts, from the files themselves: clone-vs-repack 30 iters × 3 modes with up to two seeds per round of a ~10k-object set (and its `half`/`fetch` modes' second seed re-sends every base object just to be conflict-skipped); err-pkt-overflow 20 × ~10k; concurrent-repack 40 × ~3.5k; short-pack 60 × ~2k; two-pushes 25 × ~3.5k. The raced operations themselves are cheap; the fixture assembly around them is the budget.

## Candidate content fixes (each needs the owner's explicit sign-off before landing)

- **(a) Template-repo seeding** — seed the object set ONCE per suite into a template repo, then per-iteration copy it DB-side (set-based `INSERT..SELECT` into a fresh `repo_id` within the same schema). Identical rows, identical never-repacked state, ~100 ms instead of seconds; preserves every iteration of race coverage. This is a NEW fixture pattern (DB-side assembly instead of public-surface seeding) — that is exactly why it is gated on sign-off.
- **(b) Delta-only second seeds** — in modes that seed base-then-full, push only `full − base` the second time, which is what a real push carries. Semantically identical end state; free-standing; no coverage trade.
- **(c) Iteration trims that preserve the sweep** — e.g. clone-vs-repack's 30 iterations cover its 12-delay sweep 2.5×; 12 iterations cover it exactly once. Trades away timing-jitter re-rolls; the owner decides whether that coverage is worth its minutes.

## Profiling method (in flight)

Temporary instrumentation, all of it scratch that must NEVER be committed: env-gated git-subprocess wall aggregation per subcommand in `src/testing/spawn-git.ts` (`PGGIT_GIT_STATS=<dir>`), env-gated query counting in `src/testing/pg.ts` (`PGGIT_PG_STATS=<dir>`), and an untracked `vitest.profile.config.ts` adding `--cpu-prof` to the fork pool so each worker writes a V8 `.cpuprofile`. Per profiled file this yields: wall (vitest), git wall per subcommand, PG round-trip counts, JS CPU with flamegraph-able profile; residual ≈ scheduling/sleeps. First target: the 28% file, running solo on the now-quiet box; then the same treatment across the rest of the top seven.

## State and next steps

1. In flight: instrumented solo run of `race--clone-vs-repack` (also doubles as its clean-box baseline).
2. Then: decomposition report → owner picks from fixes (a)/(b)/(c) per file → land sanctioned reductions with the usual review/statics/blast-radius discipline.
3. Untouched second-order ideas, deliberately parked: content-keyed cache for `createAppendOnlyRepo` fixtures (each `(docs, runs)` tuple is rebuilt via fast-import many times per gate); a ~30-line vitest reporter appending per-file durations to a committed JSONL so cost regressions become visible; investigating the gate's ~65 s module-import phase; Spotlight (`mds_stores`) indexing churn on test tmpdirs.

**Driver's leans, plainly:** (b) should land regardless — it is a correction toward what production pushes actually carry. (a) is the big win and preserves coverage; I would take it over (c) everywhere the two compete. (c) is the fallback where (a) is unwanted. The verdict-side work (fscks, oid-set comparisons) is the oracle itself — do not trim it to save time.

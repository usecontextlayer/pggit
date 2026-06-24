# pggit — self-scheduling GC (background drain): design

- **Date:** 2026-06-24
- **Status:** approved design, pre-implementation. Next step is **tests-first** (behavioural, observable-only — see §7), then implementation.
- **Scope:** the **invocation / scheduling** layer on top of the GC primitive — *when* GC runs and *how the server decides to run it*, off the hot path. Resolves the **open "surface shape" item (§9)** of the GC design. No change to the GC algorithm itself (`store/gc.ts`), to the wire protocol, or to any existing git-server behaviour.
- **Lineage:** builds directly on `docs/2026-06-24-force-commit-gc-design.md` (the GC primitive + its observable contract §4, items GC-1…GC-10 / FC-1…FC-3 / PBT-1…PBT-3) and **§7** of `internal/archived/2026-06-22-pggit-postgres-native-storage-redesign.md` (which specified GC as running *"offline, off-peak, per-repo"* but left the trigger open). Bare `§N` below refers to **this** doc unless it cites one of those two.
- **Motivation:** in the force-commit `~/.claude` model **every push orphans the prior snapshot**, so garbage accrues every agent turn. GC must run *often* but *never on the push/fetch hot path*. The server should self-determine when — not depend on an external cron.

---

## 1. Decisions (made, not open)

Settled in design dialogue (2026-06-24):

1. **Background drain** (git's `gc.auto` model): op-driven + debounced + off the hot path. *Not* per-push GC, *not* blind sweep-all, *not* host-cron-only.
2. **Durable, DB-driven, poll-loop** trigger — survives restarts; no in-memory dirty state to lose.
3. **Activity signal = `repos.last_pushed_at`** (a new column), *not* derived from `git_object.created_at`. The derived form needs an index on the insert-only spine (hot-path + storage tax) or a per-repo spine scan each loop, and **misses delete-only orphans** (a delete writes no object). The column is a cheap seq-scan of the tiny `repos` table and a single HOT write per push, and captures every push type.
4. **Scheduler is fully decoupled from the request path.** Because the signal is written in the store's push transaction, the scheduler is a pure poll loop over Postgres. **No `onPushApplied` hook, no app change** — `createGitApp` is untouched.
5. **Keep `gc.ts` lock-free** (the GC-9 test proves snapshot + grace is safe). The per-repo advisory lock (`repos.id`) and multi-instance claim (`FOR UPDATE SKIP LOCKED`) are **deferred** until pggit actually runs more than one instance — at which point the write path *and* GC adopt the same key together.

---

## 2. The data model (first)

Two nullable `timestamptz` columns on `repos` (migration `0004`):

| Column | Written by | Meaning |
|---|---|---|
| `last_pushed_at` | the **store**, in the push txn, on any storage mutation | the repo's storage changed at this time |
| `last_gc_at` | the **scheduler**, after a GC pass | GC last *started* a pass for this repo at this time |

**Eligibility (the whole policy, as a predicate):**

```
needs_gc(repo) ⟺ last_pushed_at IS NOT NULL
              AND (last_gc_at IS NULL OR last_pushed_at > last_gc_at)
```

`repos` becomes a per-push-updated table, so the migration also **tunes it for churn** like `git_ref` (`fillfactor = 70` for HOT updates + aggressive autovacuum). The two columns are **not indexed**: the loop predicate is a column-vs-column compare (not sargable), so the loop seq-scans `repos` — trivially cheap at this scale, and leaving the columns unindexed keeps every `last_pushed_at` write HOT. (A partial dirty-index is a future lever only at millions-of-repos scale.)

After the migration, regenerate `src/database/models/public/Repos.ts` via kanel (it is `@generated`).

---

## 3. Where `last_pushed_at` is written

In the **store**, transactionally co-located with the mutation, so any garbage-creating push leaves `last_pushed_at` > the prior `last_gc_at`:

- **`object-store.insertObjects`** — after ingesting object rows (catches force-commits, and a connectivity-rejected push that ingested-then-orphaned its objects).
- **`refs-store.applyRefUpdates`** — after a successful ref change (catches **delete**, which ingests no object).

A push that does both (the common force-commit) stamps twice — two tiny single-row UPDATEs, negligible next to the COPY + ref-CAS already on that path. A pure no-op push (zero commands, empty pack) writes nothing and correctly leaves `last_pushed_at` unchanged.

**Why this is safe against a concurrent GC** (the no-lost-garbage argument): the bump's `clock_timestamp()` is read at/after the mutation commits, and the scheduler sets `last_gc_at = t0` where `t0` is captured *before* that repo's GC snapshot opens. So for any push:
- if its mutation is invisible to the GC snapshot (committed after the snapshot), its bump committed later still, so `last_pushed_at > t0` → the repo re-qualifies next loop → reclaimed then (and grace protects it meanwhile);
- if its mutation is visible to the snapshot, the orphan it created is in the unreachable set and swept this pass.

There is no window where garbage is both unseen by GC and fails to re-trigger. This is the durable analog of the GC primitive's REPEATABLE-READ + grace defence (§5 of the GC design).

---

## 4. Components & seam

- **`createGc` becomes a public export** (`src/index.ts`) — the primitive a host can also drive directly on its own schedule.
- **`createGcScheduler(pg, opts)`** (new, e.g. `src/gc-scheduler.ts`) owns all policy:
  - `drainOnce(): Promise<DrainSummary>` — one poll+sweep pass: select eligible repos (each with a DB `clock_timestamp()` `t0`), then for each (bounded concurrency, per-repo serialized) run `gc(name, { graceSeconds })` and `UPDATE repos SET last_gc_at = t0`. Returns one entry **per eligible repo** `{ repo, deletedObjects, deletedEdges }` (including zero-reclaim repos, so the eligible *set* is observable).
  - `start()` / `stop()` — thin glue: `start` runs `drainOnce` on a `setInterval(intervalMs)` (guarded against overlapping passes); `stop` clears it. **All correctness lives in `drainOnce`**, which tests drive directly — the timer is never in a test's critical path.
- **`startServer` wires it** (standalone): build the scheduler over the same `pg`, `start()` it when enabled, `stop()` it in `close()`. **A mounted host is unchanged** — it either starts its own scheduler over its `pg` or drives `createGc` itself.

```
push ──(store txn)──▶ repos.last_pushed_at        createGitApp: UNCHANGED
                              │
            (no in-process coupling — durable signal)
                              ▼
   createGcScheduler.drainOnce()  ──per eligible repo──▶  createGc().gc(name,{grace})
                              │                                   │
                              └── UPDATE repos.last_gc_at = t0 ◀──┘
```

**Minor `gc.ts` refinement (motivated here):** skip the `VACUUM (ANALYZE)` + `reindex` maintenance when a pass reclaims **nothing**, so a frequent no-op scan (an eligible repo whose push happened to create no garbage, e.g. a fast-forward) costs only the live-set walk + anti-join, not a VACUUM. Observable-neutral (VACUUM changes no logical state; GC-6 idempotence still holds). Kept a distinct edit so it can be reviewed independently of the scheduler.

---

## 5. Configuration

`src/env.ts` (Zod-validated, boundary layer), defaults chosen for the force-commit workload:

| Env | Default | Meaning |
|---|---|---|
| `PGGIT_GC_ENABLED` | `true` (standalone) | run the background drain in `startServer`. Host-mount mode opts in by starting its own scheduler. |
| `PGGIT_GC_INTERVAL_MS` | `30000` | drain cadence (the debounce window — a burst of turns inside it coalesces to one sweep). |
| `PGGIT_GC_GRACE_SECONDS` | `60` | passed to `gc()`; the storage-overhang dial (minutes, per the GC design — *not* git's days). |
| `PGGIT_GC_CONCURRENCY` | `4` | max repos GC'd at once per pass, so one large-orphan repo can't head-of-line-block the rest. |

Disabling only stops the loop; `last_pushed_at` is still stamped (cheap, harmless), so enabling GC later just works.

---

## 6. Observable contract (normative — this is the test spec)

Three observable surfaces, all first-class — **no internals** (timer mechanics, concurrency choreography, the candidate SQL, batch/txn shape) are ever asserted:

- **Postgres surface** — rows + the two new columns: `repos.last_pushed_at` / `last_gc_at`, and the GC effect on `git_object` / `git_edge`. *What's in Postgres is observable; tests may also control `created_at` (`ageObjects`) and `grace` to probe determinism without wall-clock waits.*
- **Git-protocol surface** — what stock `git` sees: a `clone` after a scheduled drain is `fsck`-clean with the latest tree. Oracle = the real `git` binary (`testing/spawn-git.ts`).
- **Scheduler output surface** — `drainOnce()`'s returned `DrainSummary` (which repos it judged eligible and what each reclaimed). A return value, like `gc()`'s, is observable.

Every item must hold and be covered by a test.

**Activity signal**

- **SCH-1 — Any storage-mutating push stamps activity.** After a create / fast-forward update / non-ff force / delete that changes a repo's objects or refs, `repos.last_pushed_at` is non-null (and, for a repo pushed before, strictly greater than its prior value). A zero-command no-op push leaves it unchanged.
- **SCH-2 — Delete is captured.** A ref-delete that ingests no object still advances `last_pushed_at` (the case `git_object.created_at` would miss).

**The drain loop**

- **SCH-3 — Drains exactly the eligible set.** `drainOnce()` runs GC on every repo satisfying `needs_gc` and on no other; the returned summary lists exactly those repos. A repo not pushed since its last GC is absent.
- **SCH-4 — A pass advances `last_gc_at` and is self-terminating.** After `drainOnce()` processes a repo, its `last_gc_at` is set; a second `drainOnce()` with no intervening push to that repo returns an empty summary for it (GCs nothing).
- **SCH-5 — Idle repos untouched.** A repo never pushed (`last_pushed_at` NULL), or not pushed since its last GC, is never in a drain summary and its `git_object` / `git_edge` rows are unchanged.
- **SCH-6 — End-to-end reclamation through the loop.** After force-commits to a repo, one `drainOnce()` with `grace = 0` leaves `git_object` reduced to the current reachable closure and a `clone` `fsck`-clean with the latest tree. Over *K* force-commit-then-drain cycles, row count stays ≈ the reachable-set size (does not grow with *K*). (GC-2 / GC-4 reached *through* the scheduler.)
- **SCH-7 — No-lost-garbage across a mid-drain push.** A push landing after a pass's GC snapshot re-stamps `last_pushed_at > last_gc_at`, so the next `drainOnce()` re-GCs the repo; afterwards its orphans are gone and a clone is complete + `fsck`-clean. (Durable analog of GC-9.)

**Isolation & robustness**

- **SCH-8 — Tenant isolation through the loop.** A drain that GCs repo A never alters repo B's rows or clone; with many eligible repos, **all** end up correctly GC'd (survivors == each repo's reachable closure) regardless of concurrency. (GC-8 through the scheduler; outcome-asserted, not concurrency-asserted.)
- **SCH-9 — Disabled = inert.** With `PGGIT_GC_ENABLED=false` no drain runs: pushes still stamp `last_pushed_at`, but no object is ever reclaimed and the server behaves exactly as today.
- **SCH-10 — Standalone server self-GCs; mount is unchanged.** A black-box `startServer` (GC enabled, small interval) reclaims a repo's orphans on its cadence end-to-end; the mounted `createGitApp` path with no scheduler reclaims nothing and is byte-for-byte the prior behaviour.

**Preservation**

- **SCH-11 — Regression gate.** The full existing suite, the GC-primitive suite (GC-1…PBT-3), and `git fsck` all stay green; the migration + `last_pushed_at` bump change no existing protocol behaviour.

**Property-based**

- **PBT-S1 — Multi-repo differential.** For random sequences of (push / force / delete) across several repos, after one `drainOnce()` with `grace = 0`: every repo's surviving `git_object` == its real-git reachable closure (the GC-7 oracle), **and** the drain summary's repo set == the repos with activity since their last GC. Generalises SCH-3 / SCH-6 / SCH-8.

---

## 7. Test strategy (next phase)

**Principle: behavioural, observable-only** — assert §6 (git oracle, Postgres rows incl. the two columns, the `DrainSummary`), never §3/§4 internals. TDD: failing observable test first, then implement.

- **Drive `drainOnce()` directly** for determinism — never the `setInterval`. SCH-10 is the one black-box case that exercises `start()` against a running `startServer` (small interval, poll for the observable effect).
- **Reuse the GC harness:** `testing/gc-helpers.ts` (`setupGcFixture`, `pushFile`, `cloneAndFsck`, `objectOids`/`countObjects`, `gitReachableOids`, `ageObjects` for grace), `testing/spawn-git.ts`, `generative/commands.ts`.
- **Determinism for grace:** control `created_at` + `grace` (incl. `0` / `∞`), not wall-clock.
- **Example-based:** SCH-1…SCH-11 as `e2e/gc-scheduler.test.ts` cases (+ a small `startServer` black-box for SCH-10).
- **Property-based (`fast-check`):** PBT-S1 in `generative/gc-scheduler.spec.test.ts`, multi-repo, oracle-checked.
- **Regression gate:** SCH-11 — the whole suite stays green; this work is additive.

Build the tests with subagents/workflows, verifying every §6 item **red-for-the-right-reason** before implementation begins.

---

## 8. Explicitly out of scope (named, not silently dropped)

- **Per-repo advisory lock + multi-instance claim** (`FOR UPDATE SKIP LOCKED` / `pg_advisory_xact_lock(repos.id)`) — deferred until pggit runs >1 instance; v1 is single-instance with an in-process per-repo guard. The data model already extends to it (claim on the eligible `repos` row).
- **`manage.ts` / CLI subcommand** — the GC design's §6/§9 floated a CLI; **superseded.** The self-scheduling server is the "server knows when" mechanism, and `createGc` is exported for a host that wants manual/cron control. (The speculative `gc-cli.ts` was already removed as YAGNI.)
- **Durable state beyond the two columns** (a queue table, per-push counters, `gc_dirty` boolean) — unnecessary; `last_pushed_at > last_gc_at` is the whole signal.
- **`xmin`/epoch grace** — still the §15 hardening lever of the redesign; v1 ships the short time-grace.
- **Tenant deletion** — same batched-DELETE machinery, still out of scope (noted in the GC design §6).

---

## 9. Open items (resolve during tests/impl, not blocking the design)

- **Default `PGGIT_GC_INTERVAL_MS` / `GRACE_SECONDS`** — `30000` / `60` are starting points; tune once measured. The parameters are the contract, the defaults are tunable.
- **Exact `last_pushed_at` bump site(s)** — §3 names `insertObjects` + `applyRefUpdates`; the precise placement is pinned by SCH-1/SCH-2 tests (a delete and a connectivity-rejected ingest must each move it).
- **`gc.ts` skip-VACUUM-on-empty refinement (§4)** — include or defer; reviewed independently of the scheduler.

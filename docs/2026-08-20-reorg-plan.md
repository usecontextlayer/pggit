# THE PLAN — pggit file-rename & folder re-organization

**Repo:** the `spine-excellence` branch worktree · **Scope:** renames, moves, one deletion. No behavioural refactors.
**Provenance:** produced 2026-08-20 by survey subagents fanned out per directory, then every load-bearing claim re-verified by the driving session against the tree itself (import-specifier censuses, export greps, doc-citation counts) — claims that did not survive the spot-check are marked REJECTED below with the disproving evidence. **Verified against the tree as of the cycle-B close (commits `9517e5a`/`ecece3d`)** — see the dated addendum at the bottom before executing: the perf/ chunk has been rewritten since, and the counts here are point-in-time.
**Context:** this plan is one step of the excellence pass recorded in `docs/2026-08-20-excellence-pass.md`; it executes after cycle C closes and before (or as the opening of) cycle D.

---

## 1. Target layout

```
src/
  index.ts            server.ts   main.ts          ← the app front door (reorg-design §root set)
  schema.ts                                        ← published entry: package.json exports "./schema"
  env.ts              instrument.ts                ← config singleton + cross-cutting instrumentation
  lang.ts                                          ← NEW (was assert-never.ts): assertNever + batches

  object/            ← the git object grammar (the packfile is a transport encoding of it)
    oid.ts               ← MOVED from src/oid.ts
    object.ts  commit-graph.ts  tree-diff.ts  format-error.ts
    ingest-validation.ts ← RENAMED from derive.ts
  pack/              ← unchanged
    delta.ts  object-header.ts  read-pack.ts  write-pack.ts
  protocol/          ← unchanged
    pkt-line.ts  sideband.ts  capabilities.ts  errors.ts
    v2.ts  upload-pack.ts  receive-pack.ts
  store/             ← the git domain over Postgres
    object-store.ts  refs-store.ts  reachability.ts  reach-epoch.ts
    repo-resolver.ts  repo-admin.ts
    push-watermark.ts        ← RENAMED from repo-activity.ts
    derived-row-invariant.ts ← RENAMED from derived-row.ts
    gc.ts  repack.ts
    gc-scheduler.ts          ← MOVED from src/gc-scheduler.ts
  database/          ← the Postgres plumbing (unchanged)
    index.ts  postgres.ts  migrate.ts  copy-insert.ts  bytea.ts
    object-type-codes.ts  migrations/  models/
  repo-file/         ← RENAMED from repo-view/; one concept, one word
    projection.ts            ← RENAMED from repo-file-projection.ts (SQL half)
    sync-ref.ts              ← RENAMED from rebuild.ts (walking half)
    behaviour.test.ts  projection-differential.test.ts
    path-prefix-index.test.ts ← RENAMED from repo-file-index.test.ts
                             ← build-file-list.ts DELETED (folded into sync-ref.ts)
  testing/           ← shared test helpers & oracles
    …  expect-format-error.ts ← RENAMED from format-error.ts
       repo-commands.ts       ← MOVED from generative/commands.ts
  generative/        ← now a pure differential suite
  e2e/
    <55 flat stack tests>
    regressions/     ← RENAMED from breakage/ (55 files, <lens>--<name> kept)

perf/
  run.ts  README.md
  harness/           ← NEW: the scenario harness's 8 private modules
    harness.ts  scenarios.ts  fast-import.ts  report.ts
    memory.ts  memory.test.ts  process-metrics.ts  profile.ts  pg-latency.ts
  probes/            ← RENAMED from breakage/ (44 harnesses + 5 `_`-prefixed libs)
    delta-probe.ts  delta-corpus.ts   ← MOVED in from perf/ root
docs/
  2026-08-15-breakage-conversion/    ← NEW: the 11 frozen _MAPPING-*.md records
```

Root ends holding exactly four categories and nothing else: package entrypoints (`index`, `schema`, `main`, `server`), the env singleton, cross-cutting instrumentation, and one language-primitives module.

---

## 2. Ordered move list

Each numbered step is one commit; `tsc -b` is green at every step boundary. Steps 1–4 touch zero TypeScript imports and go first.

### Step 1 — `perf/breakage/_MAPPING-*.md` (11 files) → `docs/2026-08-15-breakage-conversion/`
```
git mv perf/breakage/_MAPPING-{lifecycle,perf,pg-bloat,pg-corrupt,pg-txn,pgres,race,realrepo,shapes,txn,wire}.md \
       docs/2026-08-15-breakage-conversion/
```
**Aliases:** none. **Blast radius:** 0 imports; the 11 files are markdown, imported by nothing.
**Why:** verified — five of the eleven lenses (`lifecycle`, `pg-corrupt`, `pg-txn`, `race`, `shapes`) have **zero** harnesses in `perf/breakage/`; all 38 of their artifacts are in `src/e2e/breakage/`. Frozen point-in-time records are a `docs/` artifact by this repo's own convention.

### Step 2 — `perf/` root harness/library split
```
git mv perf/{harness,scenarios,fast-import,report,memory,memory.test,process-metrics,profile,pg-latency}.ts perf/harness/
git mv perf/{delta-probe,delta-corpus}.ts perf/probes/
git mv perf/breakage perf/probes    # merge; keep `_`-prefixed libs as-is
```
**Aliases:** relative specifiers inside `perf/` only (`./report` → `./report` within `harness/`; `perf/run.ts`'s three imports become `./harness/…`). No `@/` path changes. `package.json`'s `"perf": "npx tsx perf/run.ts"` is unaffected — `run.ts` stays at root.
**Blast radius:** ~12 relative import lines, all inside `perf/`. `memory.test.ts` travels with `memory.ts` (co-location is the house rule and this is the one place it was broken); it stays inside the vitest include (`**/*.test.ts`).
**Why:** verified import graph — `run.ts` → `{report, harness, scenarios}`, `harness.ts` → the other six. Eight modules are one harness's private library; nothing outside imports them. `perf/breakage/` already marks libraries with `_` while perf root marks nothing.

### Step 3 — `perf/probes/` naming + README
Fold a "what lives where" section into `perf/README.md` in the same commit (harness vs probes, the `_`-prefix rule, `<lens>--<name>`, where the mapping docs went).
**Blast radius:** docs only. **Why:** the README currently documents only the scenario harness and never mentions the 44 probe harnesses; steps 1–2 make it wrong in a second way.

### Step 4 — `src/e2e/breakage/` → `src/e2e/regressions/` (55 files)
```
git mv src/e2e/breakage src/e2e/regressions
```
**Aliases:** none — no file imports across into that folder; every member is a leaf test.
**Blast radius:** 0 imports. 18 doc citations (`docs/2026-08-17-…` ×3, `docs/2026-08-19-…` ×15) get their paths updated in the same commit.
**Why:** verified — zero `it.skip`/`describe.skip`/`it.todo` anywhere in `src/` or `perf/`; the design record logs the final comprehensive gate green. "Breakage" was true at conversion time and is now a cache that was never invalidated. Keep the `<lens>--<name>` prefixes: they are the one working taxonomy in the test tree.

### Step 5 — `src/oid.ts` → `src/object/oid.ts`
```
git mv src/oid.ts src/object/oid.ts
```
**Aliases:** `@/oid` → `@/object/oid`. **Blast radius:** 14 import lines / 14 files (`object/object.ts`, `object/derive.ts`, `pack/read-pack.ts`, `protocol/{v2,upload-pack,receive-pack}.ts`, `store/{object-store,refs-store}.ts`, `repo-view/rebuild.ts`, `testing/git-fixtures.ts`, 4 regression tests). Verified by specifier census.
**Why:** `Oid` is git-object vocabulary and `object/` already depends on it in the other direction; the 2026-06-23 reorg fixed the root set as the app front door and `oid.ts` landed there afterward.

### Step 6 — `src/gc-scheduler.ts` → `src/store/gc-scheduler.ts`
```
git mv src/gc-scheduler.ts src/store/gc-scheduler.ts
```
**Aliases:** `@/gc-scheduler` → `@/store/gc-scheduler`. **Blast radius:** 7 import lines / 5 files (`server.ts`, `index.ts` ×2, `generative/gc-scheduler.spec.test.ts`, 2 e2e tests).
**Why:** the only root-level file that is a subsystem rather than an entrypoint. It is a structural peer of `store/gc.ts` (which it drives) and `store/repack.ts`.
**Deliberately NOT `src/maintenance/{gc,repack,scheduler}.ts`** — see REJECTED #7.

### Step 7 — `src/object/derive.ts` → `src/object/ingest-validation.ts`
```
git mv src/object/derive.ts src/object/ingest-validation.ts
git mv src/object/derive.test.ts src/object/ingest-validation.test.ts
```
**Aliases:** `@/object/derive` → `@/object/ingest-validation`. **Blast radius:** 5 import lines.
**Why:** verified — a bare verb with no object, and a rename residue: the 2026-08-17 record shows `object/edges.ts` was renamed `derive.ts` when the edges concept died, keeping the verb from `deriveEdges` after the noun was dropped. The module's own first line names the concept: *"Ingest-boundary validation and row derivation."* Shorter alternative if preferred: `ingest.ts`.

### Step 8 — `src/store/repo-activity.ts` → `src/store/push-watermark.ts`
```
git mv src/store/repo-activity.ts src/store/push-watermark.ts
```
**Aliases:** `@/store/repo-activity` → `@/store/push-watermark`. **Blast radius:** 2 import lines (`store/refs-store.ts`, `store/object-store.ts`).
**Why:** verified — the file is one 8-line function stamping `repos.last_pushed_at`, the watermark GC eligibility reads. "Activity" is a hedge noun of the `Manager`/`Util` family; it names no concept.

### Step 9 — `src/store/derived-row.ts` → `src/store/derived-row-invariant.ts`
```
git mv src/store/derived-row.ts src/store/derived-row-invariant.ts
```
**Aliases:** `@/store/derived-row` → `@/store/derived-row-invariant`. **Blast radius:** 3 import lines (`refs-store.ts`, `reachability.ts`, `object-store.ts`).
**Why:** verified — the file contains exactly one 6-line thrower. Its name claims the derived-row *subject* (a schema-wide concept: `git_commit`/`git_tag` rows, their loaders); its content is *"the derived-row invariant was broken."* A reader grepping for derived-row logic lands on an error message.
**Alternative considered and not taken:** `store/errors.ts`, matching the reorg design's "place each error type with its layer" (`object/format-error.ts`, `protocol/errors.ts`). Rejected on YAGNI — there is exactly one store-level loud failure, and `errors.ts` would misdescribe a thrower as an error type. If a second one appears, promote then.

### Step 10 — `src/testing/format-error.ts` → `src/testing/expect-format-error.ts`
```
git mv src/testing/format-error.ts src/testing/expect-format-error.ts
```
**Aliases:** `@/testing/format-error` → `@/testing/expect-format-error`. **Blast radius:** 3 import lines (`pack/delta.test.ts`, `object/derive.test.ts` → now `ingest-validation.test.ts`, `object/object.test.ts`).
**Why:** verified — two files in the tree share the basename `format-error.ts` while holding different concepts: `object/format-error.ts` **defines** `GitFormatError`; `testing/format-error.ts` **asserts** on it. One name, two concepts.

### Step 11 — `src/assert-never.ts` → `src/lang.ts`, absorbing the duplicated `batches()`
```
git mv src/assert-never.ts src/lang.ts
# then: move batches<T> into lang.ts; delete both copies
```
**Aliases:** `@/assert-never` → `@/lang`. **Blast radius:** 16 import lines / 16 files, plus 2 new `batches` imports and 1 byte-identical duplicate definition deleted.
**Why:** verified — `batches<T>(items, size)` is defined **byte-identically twice**: `src/store/object-store.ts:36` and `src/store/reachability.ts:22`. The duplication exists because the tree has no home for language-level generics; the absence *caused* the copy-paste. `lang.ts` gets an admission rule in its module doc: **zero domain imports, generic over T, no knowledge of git or Postgres.**
> ⚠️ **Needs explicit user sign-off** — AGENTS.md forbids introducing a new module category without approval, and a shared-helpers module is exactly the kind that drifts into a grab-bag. **Fallback if declined:** leave `assert-never.ts` as-is and give `batches` a single owner in `store/reachability.ts`, importing it into `object-store.ts` — at the cost of coupling ingest batching to the reachability layer.

### Step 12 — `src/generative/commands.ts` → `src/testing/repo-commands.ts`
```
git mv src/generative/commands.ts src/testing/repo-commands.ts
git mv src/generative/commands.test.ts src/testing/repo-commands.test.ts
```
**Aliases:** `@/generative/commands` → `@/testing/repo-commands`. **Blast radius:** 9 import lines / 9 files (all `generative/*.spec.test.ts`).
**Why:** verified — a 402-line shared fixture builder (`repoCommands` arbitrary + `buildRepoFromCommands` replayer) is the only non-test file in a folder that is otherwise 100% tests. It is the same kind of artifact as `testing/append-only-repo.ts` and `testing/git-fixtures.ts`, shelved by *which suites use it* rather than *what it is*. The 2026-06-23 reorg fixed `src/testing/` as the home for shared test helpers. `generative/` becomes a pure differential suite.

### Step 13 — `src/repo-view/` → `src/repo-file/` (folder + 4 file renames + 1 deletion)
```
git mv src/repo-view src/repo-file
git mv src/repo-file/repo-file-projection.ts   src/repo-file/projection.ts
git mv src/repo-file/rebuild.ts                src/repo-file/sync-ref.ts
git mv src/repo-file/repo-file-index.test.ts   src/repo-file/path-prefix-index.test.ts
# fold buildFileList + ObjectReader/FileList into sync-ref.ts; delete build-file-list.ts
git rm src/repo-file/build-file-list.ts
```
**Aliases:**
- `@/repo-view/repo-file-projection` → `@/repo-file/projection` — **19 import lines**
- `@/repo-view/rebuild` → `@/repo-file/sync-ref` — **7 import lines** (`index.ts`, 2 src tests, 4 `perf/probes/pg-bloat--*.ts`)
- `@/repo-view/build-file-list` → gone — **2 import lines** (`rebuild.ts` itself, `projection-differential.test.ts` which imports `buildFileList` directly)
- also drop the pass-through `export type { FileEntry } from "@/object/tree-diff"` so that type has one import path.

**Blast radius:** ~28 import lines total. **Why (three defects, one move):**
1. **`repo-view` names a concept the repo deleted.** The 2026-06-26 read-surface design removed the read API (`listFiles`/`readFile`); what remains is a write-only projection maintainer plus a table consumers SELECT directly. There is no view.
2. **One concept, four names — verified in the tree:** folder `repo-view`, dep key `snapshots`, type `RepoFileProjection`, docstring "queryable-view layer" (plus an error string `"repo-view: object … missing"`). `repo_file` is the anchor: it is the table, it is what `schema.ts` publishes as the read contract, and it is what migrations 0002/0006/0011 are named after. `repo-file/projection.ts` carries no stutter; `projection/repo-file-projection.ts` would.
3. **`rebuild.ts` names the fallback branch.** Verified from the module's own docblock: since S3 the job is to advance a branch's projection *forward* from a persisted basis; full rebuild fires only when no basis exists, and a third path (skip) exists so it never rebuilds backwards. `sync-ref.ts` + `projection.ts` reads as the walking half beside the SQL half.
4. **`build-file-list.ts` is a 24-line delegate.** `buildFileList` reads a commit's tree oid and hands the whole walk to `listFiles` in `object/tree-diff.ts`; the rest is two type aliases and one re-export. Its one production caller is `sync-ref.ts`.

### Step 14 — the `snapshots` → `projection` vocabulary collapse ⚠️ BREAKING
```
GitAppDeps.snapshots  → GitAppDeps.projection
SnapshotDeps          → ProjectionDeps
syncRefSnapshot       → syncRefProjection
dropRefSnapshot       → dropRefProjection
rebuildAllSnapshots   → rebuildAllProjections
src/e2e/push-snapshot-large.test.ts → push-projection-large.test.ts
```
**Blast radius:** 44 lines across ~34 files (verified count), including `perf/probes/pg-bloat--*.ts`.
**Why:** finishes the one-concept-one-name repair started in step 13. `RepoFileProjection`, `ApplyOutcome`, `ProjectionPlanner`, and `applyRefAdvance` already speak *projection*; `snapshots` is the drift.
> ⚠️ **`GitAppDeps.snapshots` is public API** (exported from `index.ts`). Most hosts get it via `createGitDeps`, but a host composing deps by hand breaks. This repo uses semantic-release with Conventional Commits, so land it as `refactor!:` / `BREAKING CHANGE:` in its own commit. **Do it in the same release as step 13 or not at all** — a half-collapsed vocabulary is worse than the current consistent-if-wrong one.

### Step 15 — drop the `.spec` infix from 28 test files ⚠️ LAST, optional
```
for f in $(find src -name '*.spec.test.ts'); do git mv "$f" "${f/.spec.test.ts/.test.ts}"; done
```
**Aliases:** none — nothing imports a test file. **Blast radius:** 28 renames, 0 code edits. Collision check performed: no target name already exists (`v2.parse.spec` → `v2.parse.test.ts` beside the existing `v2.test.ts`; `encode-delta.spec` → `encode-delta.test.ts` beside `encode-delta-oracle.test.ts`; `codec.spec` → `codec.test.ts`). Also update the `vitest.config.ts` comment block that defines the infix, and 16 doc citations across four `docs/` files.
**Why:** verified inconsistent in three directions. The config defines `.spec.test.ts` as *"the oracle wire goldens (§8.1) and the generative kernel differentials (§8.4)"*, but `e2e/refs-peeling.spec.test.ts` is a §5.3 behaviour test that is neither, while `pack/encode-delta-oracle.test.ts` is a real-git oracle that lacks the infix; and 100% of `generative/`'s files carry it, so inside that folder it distinguishes nothing. There is one runner, one config, one gate — the infix selects nothing. It is authoring history wearing a taxonomy.
**Fallback if the doc churn is unwelcome:** keep `.spec` on only the four true byte-goldens under `protocol/` (`framing`, `receive-pack-wire`, `upload-pack-wire`, `object-format`) and strip the other 24 — then the config comment must be rewritten to the narrower definition.

---

## 3. REJECTED — proposals not worth their churn

**1. Split `src/store/reachability.ts` (1151 lines) into a 6-module folder.** *Rejected on the design record, not on cost.* `docs/2026-08-17-derived-state-spine-design.md` states it twice, once as a decision and once as the named defense against its own stated fear:

> *"`fullClosure`/`frontier`/`ancestry` are three exports of ONE `src/store/` module … the want-type router (R4) and the bitmap fast path (R23) live INSIDE it, never at call sites. Rejected: letting each consumer compose walk+guards itself — that is how the 'one engine' promise erodes into scattered branches."* (§250)
> *"the module boundary (ONE `src/store/` reachability module …) is the defense; hold it."* (§318)

A barrel would preserve the export surface literally — but the split's advertised win was that `repo-file/projection.ts` would narrow its import from the engine to `@/store/reachability/ancestry`. That *is* the call-site composition the design rejects. The file is large; it is not incoherent. Every export answers a reachability question and `routeServeSet` only picks which one.

> **One narrow extraction is worth putting to the user separately:** `judgeProbedType` + `boundarySatisfies` + `EdgeExpectation` (~40 lines, `reachability.ts:113–155`) are a **pure predicate with no database access** — read against the round-3 CRITICAL they encode (a missing derived row must crash, never be judged sweepable-missing). Their only test today is `src/e2e/typed-graph-policy.test.ts`, which stands up a real server, real git, and real Postgres to reach them. Extracting them as `src/store/typed-edge.ts` — a *downward* dependency reachability imports, not a call-site seam — makes the policy unit-testable on CI with no Postgres and does not touch the walk engine's export surface. Not folded into the plan because it is a testability refactor, not a rename.

**2. Split `src/store/object-store.ts` (788 lines) → extract `store/serve-pack.ts`.** *Rejected for this pass.* The surveyor's "zero import edits" claim is true of the *call sites* and misleading about the *work*: the file is one `createObjectStore` factory whose methods are an object literal (lines 96–592) over shared closure state (`db`, `pg`, `repos`) plus three closure-scoped helpers (`insertObjects`, `readContentChunked`, `augmentWithTags`). Extracting a group means threading `(db, pg, id, route)` through a new argument set — a refactor with real behavioural surface, not a `git mv`. 788 lines is large, but the module is one concept and its docblock states it cleanly. Raise it as its own refactor proposal.
*Adopted from that finding anyway:* delete the unused `StoredObject` export or give it a consumer (0 import lines).

**3. `src/protocol/v2.ts` → `upload-pack-wire.ts`.** *Rejected on evidence.* The claim was that "every one of its twelve exports is upload-pack-side." Verified false in the sense that matters: `encodeAdvertisement()` is the **info/refs GET body** — imported by `index.ts:15` for the GET route, *not* by `upload-pack.ts` — and `parseV2Request`/`V2Command` are the v2 command envelope covering `ls-refs` as well as `fetch`. The file is the protocol-v2 wire grammar, and naming it by version states a real distinction: `receive-pack.ts` is v0. Renaming it would also put `upload-pack-wire.ts` beside `upload-pack.ts` and `upload-pack-wire.test.ts`, which reads as a co-located test for a file that is not its subject. **Keep `v2.ts`.**

**4. `src/database/bytea.ts` → fold into `postgres.ts`.** *Rejected.* `MAX_INLINE_BYTEA_BYTES` is a fact about how far porsager can be trusted to return a `bytea` inline, with a real docblock explaining the `\x`+hex doubling and V8's string cap. Folding it into a 21-line driver constructor mixes the driver with a read-strategy constant. The surveyor's own note applies against its own proposal: *"a 7-line file for one constant is the smell, not the name"* — and here it is not even a smell: one concept, one truthful name, two importers.

**5. Move `src/object/format-error.ts`.** *Rejected; take the free option instead.* `GitFormatError` is raised as heavily from `pack/` as from `object/`, but the resolution costs 0 lines: state in `object/`'s folder doc that **`object/` means "the git object grammar, of which the packfile is a transport encoding."** That is already how the tree behaves (`pack/object-header.ts` owns `PACK_OBJ_TYPE`, `object/object.ts` owns `GitObjectType`).

**6. Move `src/database/object-type-codes.ts` to `store/`.** *Rejected; keep in `database/`, document the leak.* Verified: it imports **upward** (`@/object/object`, `@/pack/object-header`) and is consumed by `database/migrations/0009_commit_tag.ts`. Moving it to `store/` would make a migration import upward into `store/`, which is strictly worse. It genuinely *is* a column encoding (`git_object.type` stores the pack code). Add one line to its module doc declaring the upward import intentional.

**7. `src/maintenance/{gc,repack,scheduler}.ts`.** *Rejected in favour of step 6.* The argument is sound — `gc.ts` and `repack.ts` are offline passes, not stores, and nothing on the request path calls them. But it is a **new folder-level pattern**, which AGENTS.md requires explicit user sign-off for, and it splits a subsystem that `index.ts` publishes as one surface (`createGc` + `createGcScheduler`) while `gc.ts` depends heavily on `store/reachability.ts` and produces `store/reach-epoch.ts`. `store/gc-scheduler.ts` fixes the actual defect — a subsystem at the root — for 7 import lines. **Worth putting to the user as an option; not worth taking unilaterally.**

**8. Re-lens the three perf-named regression tests** (`perf--repack-small-object-wall`, `pgres--encoding-storage-profile`, `pg-bloat--toast-storage-propagation`). *Rejected.* The diagnosis is right — those prefixes record provenance, not category — but the fix invents a `storage--` lens with a population of two, in one tree only, and the mapping docs index by name. After step 4 the folder itself says `regressions/`, which defuses the misread at zero cost. Each file's header already defends its routing.

**9. Adopt the `--` separator across the 55 flat `src/e2e/` files.** *Rejected.* Five clusters cover 41 of 55 (`push-` 15, `gc-` 9, `fetch-` 8, `transport-` 5, `pack-encoding-` 4), and flat-and-greppable was a deliberate call in the 2026-06-23 reorg. 41 renames plus doc churn to change a hyphen to two hyphens is cosmetics, not coherence. Likewise **`src/e2e/gc-scheduler/`** — rejected; the family's must-run-alone constraint is an operational fact, and the place for it is a written line, not a folder.

**10. `src/repo-view/behaviour.test.ts` → `repo-file-projection.test.ts`.** *Rejected as a separate rename — subsumed.* It stands up `createGitApp` + real git + real Postgres; naming it after a module would misdescribe it as that module's unit test. After step 13 the folder names the subject and `repo-file/behaviour.test.ts` reads correctly. Same for **`pack/codec.spec.test.ts`**: after step 15 it is `pack/codec.test.ts`, a scenario-named co-located test, which is the accepted convention.

**11. Root files `index.ts`, `server.ts`, `main.ts`, `env.ts`, `instrument.ts`, `schema.ts`.** *Keep, all six.* `schema.ts` looks like a stray and is not: `package.json` publishes it as the `"./schema"` export, and its docblock states the real concept ("pggit's public READ contract"). The filename is a public export path and must not move for internal tidiness.

**12. The `store/repo-*.ts` trio and the `store/` ↔ `database/` boundary.** *Keep.* `repo-resolver` / `repo-admin` / `push-watermark` are three concepts, not one `repos.ts`. The boundary holds throughout: `database/` is Postgres plumbing, `store/` is the git domain over it, with the single named exception in #6.

---

## 4. Two things to raise before any of this lands

**`src/store/repack.ts` has no production caller.** Verified across the whole tree: its 83 import lines are 54 tests plus 29 `perf/` harnesses — **zero** production callers in `src/`, and it is **not exported from `index.ts`** (which exports `createGc`, `createGcScheduler`, `createRepoAdmin`, `createRepoResolver`, `migrateToLatest`, and nothing else). Both `gc.ts` and `repack.ts` document that the drain serializes repack after GC. So one of two things is true — repack should be exported for hosts to drive, or the scheduler should drain it — and **the answer decides whether it is a public surface or an internal pass, which decides where it belongs.** A reorg pass will otherwise silently normalize its placement while the question stays open. Do not move or rename it in this pass; put the question to the user.

**Doc churn is a real, unavoidable cost of steps 4, 13, 14, and 15.** Counted: `breakage` is cited 18 times across three `docs/` files, `repo-view` 18 times across four, `.spec.test` 16 times across four plus the `vitest.config.ts` comment. `docs/2026-08-19-adversarial-review-findings.md` is a **frozen review ledger** — updating its paths edits a point-in-time record. Recommendation: update paths in the two live design records (`2026-08-17`, `2026-08-19` where it is a live ledger of open dispositions) and leave the genuinely archival ones (`2026-06-23-reorg-design.md`, `2026-06-26-*`) alone, adding one dated line at the top of each noting the later rename. That respects "a tombstone is never edited" while keeping the live docs true.
---

## DRIVER RULINGS (user, 2026-08-20)

- **Step 11 (`lang.ts`)**: APPROVED — rename assert-never.ts → lang.ts, absorb the duplicated `batches<T>`, admission rule in the module doc (zero domain imports, generic over T, no git/Postgres knowledge).
- **Steps 13+14 (`repo-view` → `repo-file` + `snapshots` → `projection` collapse)**: APPROVED, including the breaking `GitAppDeps.snapshots` → `projection` rename and the sync/drop/rebuildAll* renames — land as `refactor!:` in one commit, same pass as step 13.
- **repack.ts**: EXPORT `createRepack` from index.ts (option a). It stays at store/repack.ts; scheduling remains the engine-side integration's job per the ledger. Add the export + its doc line in this pass.
- Step 15 (.spec strip): driver executes the FULL strip with the config-comment rewrite (already within granted latitude).

## DRIVER RULINGS (2026-08-21, delegated — owner: "i trust you on all of them")

- **Step 2's five unhomed perf-root files (the cycle-C additions the addendum flags)**: placed by a fresh import census (2026-08-21) — `args.ts` (33 probes + `delta-probe`/`delta-corpus` + `run.ts`) and `collector-evidence.ts` (7 probes + `delta-probe` + `report.ts`) are genuinely shared across both halves and STAY at `perf/` root; `table.ts` (26 probe-side importers, nothing else) → `perf/probes/_table.ts` and `vacuum-evidence.ts` (3 probes, nothing else) → `perf/probes/_vacuum-evidence.ts`, taking the `_`-prefix library convention the probes folder already uses; `platformatic-flame.d.ts` (ambient types consumed only by `profile.ts`) → `perf/harness/`.
- **§4's doc-churn policy: CONFIRMED as recommended** — update paths in the live design records; leave the archival ones untouched apart from one dated top line noting the later rename.
- **`memory.ts` (+ co-located `memory.test.ts`) STAYS at `perf/` root, amending step 2's harness list** — execution census: 5 probe-side files import `../memory` (cycle C additions), so the plan's "nothing outside imports them" privacy claim no longer holds for it; by the same shared-across-halves rule as `args.ts`/`collector-evidence.ts` it is root-shared. `pg-latency.ts` stays harness-side (importers: `harness.ts`, `report.ts`, `run.ts` — the harness's own entry).
- **Lens folders replace the `<lens>--<name>` prefix in BOTH probe and regression trees (owner, 2026-08-21: "the fact that we have -- in the name is a big smell. so definitely do (b) and do some shape or all of (c)").** Evidence that triggered it: each lens's `_<lens>-util.ts` is imported by exactly that lens's harnesses — a directory structure encoded in filenames. Amended shapes:
  - **Step 2**: `perf/probes/<lens>/<name>.ts` (lens populations perf 11 / pg-bloat 7 / realrepo 6 / pgres 5 / txn 3 / wire 1 — the `wire/` folder of one is the price of a uniform rule); each `_<lens>-util.ts` → `probes/<lens>/_util.ts` (`_realrepo-util` stays realrepo's at `realrepo/_util.ts`; its two cross-lens borrowers `perf/blob-delta-gap` and `wire/pack-shape-vs-git` import it like everyone else, via the alias); cross-lens libs at `probes/` root: `_table.ts`, `_vacuum-evidence.ts`; the two unlensed harnesses `delta-probe.ts`/`delta-corpus.ts` at `probes/` root.
  - **Step 4**: `src/e2e/regressions/<lens>/<name>.test.ts`, prefixes dropped, singleton lenses foldered uniformly. CONSEQUENCE superseding the addendum's "checked and safe" line: the vitest solo-file globs match basenames, and dropping prefixes changes basenames — the solo list moves in the same commit. The flat non-breakage `src/e2e/` files keep their single-hyphen names (REJECTED #9 stands; the ruling is about `--` lens encoding, not about foldering the behaviour tree).
- **Alias imports everywhere (owner, 2026-08-21: "EVERYTHING MUST BE USING `@` imports")**: a `@perf/*` → `./perf/*` paths entry joins `@/*` in `tsconfig.json` (vitest already resolves via `tsconfigPaths: true`; tsx reads tsconfig natively; perf is not part of the tsdown build), and every perf-internal relative import — `./` and `../` alike — becomes `@perf/...` in step 2's commit. This makes probe/harness imports invariant to file depth, so later moves stop touching import lines at all.

---

## ADDENDUM — staleness + execution notes (driver, 2026-08-20 evening, added with the pass ledger)

**The WHAT and WHY of every step above remain valid; the COUNTS and the perf-root inventory do not.** This plan was verified before cycle C (the perf-chunk excellence passes, commits `58d5e5c`, `09f78e1`, `2e61899`, plus the staged ownership pass) rewrote `perf/`. Known drift, so nobody trusts a stale number:

- **Step 2's perf-root inventory is incomplete.** Cycle C created `perf/args.ts`, `perf/table.ts`, `perf/collector-evidence.ts`, `perf/vacuum-evidence.ts`, and `perf/platformatic-flame.d.ts` — none of which the harness/probes split above assigns a home. Decide their placement when executing (likely: all five are shared by both harness and probes, so they stay at perf/ root, or a `perf/lib/` question goes to the owner — do not guess silently).
- **Blast-radius counts are floors, not facts.** Cycle C added many `@/oid` type imports in perf files (step 5's "14 lines" is now higher) and more `@/repo-view/*` importers under `perf/breakage/` (steps 13–14). Re-run the specifier census per step at execution time; `CODEGRAPH_TELEMETRY=0 npx -y @colbymchenry/codegraph sync <worktree>` FIRST — the index does not watch the tree.
- **The `_MAPPING-*.md` files (step 1) gained point-in-time disclaimers** during cycle C; content changed, paths did not. Step 1 is unaffected beyond needing a fresh `git mv` list check.
- **Mechanics rulings that bind execution** (owner + standing memory): `git mv` plus per-file import edits, never sed-style bulk rewrites; one commit per numbered step; `tsc -b --force` green at every step boundary; step 14 lands as `refactor!:` (the `!` is load-bearing — semantic-release derives the major bump from it) in the same release as step 13.
- **Checked and safe:** the `.spec` strip (step 15) does not interact with the vitest projects config — the include is `**/*.test.ts` and the solo-file list names no `.spec` file. The `breakage/` → `regressions/` rename (step 4) does not break the solo globs either (they match basenames, not the folder).

**Driver's subjective notes for whoever executes this:**
- *Concern:* the doc-churn policy (§4) edits live design records while leaving archival ones tombstoned; a later merge back to `delta-packs` could conflict inside those docs and silently resurrect pre-rename paths. Resolve doc conflicts by re-running the citation greps, never by picking a side wholesale.
- *Fear:* step 13's fold of `build-file-list.ts` into `sync-ref.ts` is the only step that is not a pure move — it is the one place this "no behavioural refactors" plan touches behavior-adjacent code. If anything in that fold feels non-mechanical during execution, stop and split it out rather than absorbing it into a rename commit.
- *Open question (gates step 11 only in name):* the owner approved `lang.ts`; if a THIRD language-level generic wants in later, the admission rule in its module doc is the contract — a reviewer should reject additions that know about git or Postgres.

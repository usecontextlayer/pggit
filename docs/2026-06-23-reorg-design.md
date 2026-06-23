# pggit source reorganization — design

- **Date:** 2026-06-23
- **Status:** approved design, pre-implementation
- **Scope:** relocate + rename + targeted source refactors (structure and naming only — no
  protocol/behavior changes)

## Why

The dependency graph is clean, acyclic, and strictly layered. The problem is purely
*topological*: half the tree is already foldered well (`pack/`, `protocol/`, `repo-view/`,
`database/`, `testing/`, `generative/`), while ~30 files sit flat at the `src/` root mixing
three unrelated concerns — core domain modules, the app composition root, and 18
chronologically-named milestone test files (`m0`–`m3`). A separate `smoke/` holds 25
cryptically-named `*.bug.test.ts` regression files with collision-prone prefixes, duplicate
coverage, and heavily duplicated inline helpers.

This reshape makes the existing architecture visible in the tree without changing any
behavior. The test suite (`pnpm run tsc` + `pnpm run test`) is the oracle that verifies each
step.

## Decisions

1. **Source tree:** extend the existing concept-folder convention. Add `object/` and
   `store/`; fold `pkt-line` into `protocol/`; move `postgres.ts` into `database/`. `index.ts`
   stays at root, so the build entry is unchanged.
2. **Imports:** explicit subpaths, **no barrels** — matches the existing `pack/`/`protocol/`
   convention (`@/pack/read-pack`, `@/protocol/v2`). The one cosmetic cost is `@/object/object`.
3. **Tests:** unit tests stay co-located with their module. Cross-cutting tests (milestone +
   generative + smoke) move to a flat `src/e2e/` with behavior-descriptive names. The
   `.bug.test.ts` suffix is retired; `.spec.test.ts` is kept for oracle wire-goldens and
   generative differentials.
4. **Source refactors** (4): split `object-store.ts`; extract `protocol/capabilities.ts`;
   extract `protocol/sideband.ts`; rename `repo-store.ts` → `repo-resolver.ts`.

### Resolved open items

- **`neg01`** (currently `it.skip`, contradicts `m1-multiround`) documents a real negotiation
  bug. Carried forward **as-is** — renamed, still skipped, behavior untouched. Flagged for a
  separate session.
- **Error placement:** place each error type with its layer, not co-located.
  `GitFormatError` → `object/format-error.ts`; `GitProtocolError`/`WantNotFoundError` stay in
  `protocol/errors.ts`.
- **Type-code bijection** (4 copies of `TYPE_TO_CODE`/`CODE_TO_TYPE`): left alone — deduping
  it would couple the codec back to the store. Out of scope.

## Target source tree

```
src/
  index.ts  server.ts  main.ts  env.ts  instrument.ts   # app front door — unchanged
  object/
    object.ts          format-error.ts   edges.ts
  pack/                # delta, object-header, read-pack, write-pack — unchanged
  protocol/
    pkt-line.ts  errors.ts  capabilities.ts  sideband.ts
    v2.ts  upload-pack.ts  receive-pack.ts
  store/
    object-store.ts  reachability.ts  negotiation.ts
    refs-store.ts  repo-resolver.ts
  database/
    postgres.ts  index.ts  migrate.ts  copy-insert.ts  migrations/  models/
  repo-view/           # unchanged
  testing/             # + lifted shared helpers
  generative/          # generator + differentials (merge-graphs moves out)
  e2e/                 # NEW flat cross-cutting tests
```

## Source-file mapping (non-test)

| Current | New | Note |
|---|---|---|
| `src/object.ts` | `src/object/object.ts` | move |
| `src/object-edges.ts` | `src/object/edges.ts` | move + rename |
| `src/git-format-error.ts` | `src/object/format-error.ts` | move + rename (error belongs to object/content layer) |
| `src/pkt-line.ts` | `src/protocol/pkt-line.ts` | move (the wire-framing primitive) |
| `src/postgres.ts` | `src/database/postgres.ts` | move; update `manage.ts` import |
| `src/object-store.ts` | `src/store/object-store.ts` | move + **split** (see refactors) |
| `src/refs-store.ts` | `src/store/refs-store.ts` | move |
| `src/repo-store.ts` | `src/store/repo-resolver.ts` | move + rename (it is a resolver, not a store) |
| `src/index.ts` | `src/index.ts` | unchanged (build entry) |
| `src/server.ts` `src/main.ts` `src/env.ts` `src/instrument.ts` | same | unchanged |
| `src/pack/*` | same | unchanged |
| `src/protocol/errors.ts` `v2.ts` `upload-pack.ts` `receive-pack.ts` | same | refactored in place (see below) |
| — | `src/protocol/capabilities.ts` | NEW — `AGENT` + `assertSupportedObjectFormat`, lifted from `v2.ts` |
| — | `src/protocol/sideband.ts` | NEW — `encodeSideband()`, deduped from `v2.ts` + `receive-pack.ts` |
| — | `src/store/reachability.ts` | NEW — `reachableClosure` + `ancestryReachesCommon`, extracted |
| — | `src/store/negotiation.ts` | NEW — `commonHaves` + `readyToGiveUp`, extracted |
| `src/database/*` (index, migrate, copy-insert, migrations, models) | same | unchanged; `models/` is kanel output (kanel `outputPath` stays `./src/database/models`) |
| `src/repo-view/*` | same | unchanged |

## Source refactors

1. **Split `object-store.ts` (524 lines).** Storage (ingest via COPY + serve/`buildPack`)
   stays in `store/object-store.ts`. Extract the `git_edge` graph walks (`reachableClosure`,
   `ancestryReachesCommon`) into `store/reachability.ts` and the fetch-negotiation analysis
   (`commonHaves`, `readyToGiveUp`) into `store/negotiation.ts`. The exact seam is confirmed
   during implementation with tests green; `ancestryReachesCommon` is extracted **verbatim**
   (the `neg01` bug is not addressed here). `reachability.ts` and `negotiation.ts` remain
   covered through the existing `e2e/fetch-*` tests that drive these paths; new dedicated unit
   tests for them are optional follow-up, not required by this reorg.
2. **`protocol/capabilities.ts`.** `AGENT` and `assertSupportedObjectFormat` are
   version-agnostic; moving them out of the v2-named file ends the misleading edge where v0
   `receive-pack` imports from `v2.ts`. Both handlers import from `capabilities.ts`.
3. **`protocol/sideband.ts`.** `v2.ts` (`encodePackfileResponse`) and `receive-pack.ts`
   (`encodeReportStatus`) carry the same chunk-over-band loop → one `encodeSideband(band, data)`.
4. **`repo-store.ts` → `repo-resolver.ts`.** Rename only; export is already
   `createRepoResolver`.

## Test reorganization

### Co-located unit tests (move with their source)

| Current | New | Note |
|---|---|---|
| `src/object.test.ts` | `src/object/object.test.ts` | move with source |
| `src/object-edges.test.ts` | `src/object/edges.test.ts` | move with source |
| `src/object-store.test.ts` | `src/store/object-store.test.ts` | move with source |
| `src/refs-store.test.ts` | `src/store/refs-store.test.ts` | move with source |
| `src/pkt-line.test.ts` | `src/protocol/pkt-line.test.ts` | move with source |
| `src/m2-large-push.test.ts` | `src/store/large-push.test.ts` | pure store test, no server |
| `src/m2-thin-pack.test.ts` | `src/store/thin-pack.test.ts` | pure store test, no server |
| `src/m2-edges.test.ts` | `src/store/edge-derivation.test.ts` | seeds store + queries `git_edge`, no server |
| `src/index.test.ts` | `src/index.test.ts` | unchanged |
| `src/pack/*.test.ts`, `src/protocol/*.spec.test.ts`, `src/protocol/v2.test.ts`, `src/testing/*.test.ts`, `src/repo-view/behaviour.test.ts`, `perf/memory.test.ts` | unchanged | — |

### Cross-cutting tests → flat `src/e2e/` (with dedupe merges)

Each merged file preserves the **union** of the originals' assertions and keeps a one-line
docblock citing the original bug id(s) for traceability.

| New `src/e2e/` file | Sourced from |
|---|---|
| `clone.test.ts` | `m0-clone` |
| `empty-repo.test.ts` | `m0-empty` |
| `fetch-negotiation.test.ts` | `m1-negotiation` |
| `fetch-multiround.spec.test.ts` | `m1-multiround.spec` |
| `fetch-partial.test.ts` | `m1-partial` |
| `fetch-include-tag.spec.test.ts` | `m2-include-tag.spec` |
| `fetch-missing-want.test.ts` | `mal-missing-want` + `mal01` (merged) |
| `fetch-want-ref.test.ts` | `mal04` |
| `fetch-empty-pack-closure.test.ts` | `neg02` |
| `fetch-ready-sibling.skip.test.ts` | `neg01` (carried, still `it.skip`) |
| `refs-peeling.spec.test.ts` | `m1-peeled.spec` |
| `push-create.test.ts` | `m2-push` |
| `push-atomic.test.ts` | `m2-atomic` |
| `push-atomic-deadlock.test.ts` | `a11` |
| `push-concurrent.test.ts` | `m2-concurrent-push` |
| `push-connectivity.test.ts` | `m2-connectivity` |
| `push-ref-modes.test.ts` | `m2-ref-modes` |
| `push-incremental.test.ts` | `m2-incremental-push` |
| `push-fsck-validation.test.ts` | `m2-fsck-validation` |
| `push-head-symref.test.ts` | `a01-head` + `a03` + `a08` (merged) |
| `push-delete-nonexistent.test.ts` | `a01-delete` + `a02` (merged) |
| `push-long-ref-name.test.ts` | `nam01` + `nam02` (merged) |
| `push-long-repo-name.test.ts` | `nam03` |
| `push-noncommit-tip.test.ts` | `a13` |
| `push-snapshot-large.test.ts` | `a06` |
| `push-merge-graphs.test.ts` | `generative/merge-graphs.spec` (moved; uses no generator) |
| `large-blob.test.ts` | `a07` (ingest) + `blb01` (serve) (merged) |
| `repack.test.ts` | `m3-repack` |
| `non-utf8-paths.test.ts` | `m-badutf-path` |
| `transport-gzip.test.ts` | `http-gzip-request` + `pro02` (merged) |
| `transport-protocol-version.test.ts` | `a12-proto-v0` |
| `transport-malformed-framing.test.ts` | `a12-malformed` + `mal03` (merged) |
| `transport-shallow-unsupported.test.ts` | `a10-shallow` |
| `transport-filter-tree0.test.ts` | `a10-filter` |

### Generative (`src/generative/`, kept)

`commands.ts`, `commands.test.ts`, `clone.spec`, `incremental-fetch.spec`,
`incremental-push.spec`, `partial.spec`, `push.spec`, `rejection.spec` — unchanged in place.
`merge-graphs.spec` moves to `e2e/` (above).

### Shared test helpers → `src/testing/`

Lift the duplicated inline helpers into named modules consumed by the e2e and co-located tests:

- **`testing/wire.ts`** — receive/fetch body framing (`pkt`, `receiveBody`, `postReceivePack`,
  `fetchBody`), duplicated across a11/a13/nam01 and 6 fetch files.
- **`testing/backends.ts`** — in-memory `RepoBackend` / `ReceiveBackend` factories, duplicated
  across m1-multiround/m1-peeled/m2-include-tag/rejection.
- **`testing/pack-inspect.ts`** — `packFiles`/`packObjectOids`/`packObjectCount`/`objectsByType`.
- **`testing/fixtures.ts`** (or extend `git-fixtures.ts`) — `bigFile`, `incompressibleName`.

## Execution plan (chunked, green-gated)

Each chunk ends with `pnpm run tsc` + `pnpm run test` green before the next begins. Import-path
updates are done per-move (deliberate edits, not blind sed), relying on tsc + Biome
`organizeImports` to catch misses.

1. **Pure relocations** (lowest risk), one module per chunk: `object/`, `protocol/pkt-line`,
   `database/postgres`, `store/` (object-store, refs-store). Update every importer of the moved
   module; tsc green.
2. **Renames:** `repo-store` → `repo-resolver`; `object-edges` → `object/edges`;
   `git-format-error` → `object/format-error`.
3. **Source refactors:** `capabilities.ts`, `sideband.ts`, then the `object-store` split.
4. **Test relocation + dedupe:** co-locate the three store tests; create `e2e/`; move + rename
   + merge the cross-cutting tests; lift shared helpers into `testing/`.

## Build / config touch-points

- `manage.ts` — update `import { initKysely } from "./src/postgres"` → `./src/database/postgres`.
- `vitest.config.ts` `globalSetup: ./src/testing/pg-global-setup.ts` — unchanged (not moved).
- `tsdown.config.ts` entry `src/index.ts` and `package.json` exports — unchanged (`index.ts`
  stays at root).
- `kanel.config.cjs` `outputPath: ./src/database/models` — unchanged (`models/` not moved).
- `tsconfig.json` `@/* → ./src/*` — unchanged.

## Out of scope / carried forward

- `neg01`'s negotiation bug — separate session.
- The 4-copy type-code bijection — intentional, left alone.
- `perf/` — already clean; untouched.
- Lower-priority cleanups noted but **not** done here: trimming the encoder overlap between
  `v2.test.ts` and `upload-pack-wire.spec.test.ts`; the `behaviour.test.ts` British spelling.

## As-built notes (deviations confirmed during implementation)

- **Object-store split is 2-way, not 3-way.** Extracted `store/reachability.ts`
  (`reachableClosure` + `ancestryReachesCommon`); kept `commonHaves`/`readyToGiveUp` in
  `object-store.ts` (they delegate to reachability). A separate `negotiation.ts` would have
  fragmented the store's uniform resolve-guard-delegate pattern for ~30 lines of glue.
- **Test reorg.** Test files 77 → 69; the 7 dedupe-merges preserved the `it()` count (242 tests
  total — unchanged 239 passed / 1 skipped / 2 todo). Milestone + smoke tests now live in
  `src/e2e/` with descriptive names.
- **Helper consolidation (decided by a propose → critique → synthesize panel).** Lifted into
  `testing/`: one composable `wire-fetch.ts#fetchRequest` (replaces 6 divergent
  `fetchBody`/`wantRefFetchBody` variants), `format-error.ts#expectGitFormatError` (replaces
  `codeOf`), plus `packFiles`/`packObjectOids`/`objectsByType`/`bigFile` (into `git-fixtures.ts`)
  and `packObjectCount` (into `pkt-oracle.ts`); local `pkt` framers collapsed to `encodePktLine`.
  **Left inline — divergence is real, not duplication:** the three `incompressibleName` variants
  (distinct determinism contracts), `receiveBody`/`postReceivePack`/`atomicBody` (app-coupled or
  scenario-bound), `reachableOids` (a different git query), and the malformed-frame literal
  buffers. The `allObjectOids`-on-`objectsByType` collapse was skipped (it would change the
  empty-repo result `[""]`→`[]`).

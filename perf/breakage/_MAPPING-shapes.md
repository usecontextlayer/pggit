# Conversion mapping — lens `shapes`

> **Point-in-time conversion record (2026-08-15).** Verdicts, fixture counts, and mechanism names below describe the code as converted, not the landed derived-state spine or later review fixes. This file is deliberately not updated; read it as frozen provenance for the conversion.

Source scripts assigned: **2**. Converted: **2**. Utilities/helpers: 0 (neither source script imports a `_*` helper — both depend only on `node:*` and `@/*` modules).

| source | destination | kind | exact property asserted / measured | expected current state |
| --- | --- | --- | --- | --- |
| `breakage/shapes--negative-sweep.ts` | `src/e2e/breakage/shapes--negative-sweep-{static,growing,mutating,scale}.test.ts` | e2e | For each of 22 adversarial repo shapes driven through the full pipeline (`git push` → `repack()` → bare `git clone` → `--filter=blob:none` partial clone → incremental `git fetch` → `gc(graceSeconds:0)` → `repack()` → clone): every clone/fetch passes `git fsck --strict --no-dangling`, and the resulting object set (`cat-file --batch-all-objects`, oid+type+size) and ref set (`show-ref`) are byte-identical to a plain `file://` bare remote driven through the identical dance — pre-repack, post-repack, post-incremental-fetch, post-mutate, and post-GC. | **GREEN negative** — these are the shapes the delta-pack pipeline survived; the source script exits 0 |
| `breakage/shapes--repack-param-limit-many-small-objects.ts` | `src/e2e/breakage/shapes--repack-param-limit-many-small-objects.test.ts` | e2e | Two shapes (A: 66,000 tiny blobs in one commit; B: 66,000 ~200-byte commits over one file) each: the `file://` control clones fsck-clean and object-identical; pggit's push + pre-repack clone are fsck-clean and object-identical; **`createRepack().repack()` completes and encodes the pending inventory** (`wholes + deltas > 0`); the post-repack clone is fsck-clean and object-identical. | **RED bug** — `repack()` throws `MAX_PARAMETERS_EXCEEDED` out of the phase-2 coverage sweep (one bind parameter per oid, batch bounded by BYTES and never by COUNT), so both `it`s fail before reaching the post-repack clone |

## Notes on the conversion

### `shapes--negative-sweep`

- **All 23 shape definitions are carried over verbatim**; the sweep list runs 22 of them. `many-tiny-objects` is defined but excluded — exactly the source script's no-argument default, because it is the one confirmed defect and owns the sibling destination test. The catalogue is kept whole so the shape is not silently lost.
- Shapes preserved (in source order): `many-tiny-objects` (defined, excluded), `deep-nesting`, `gitlinks`, `mode-churn`, `weird-names`, `toggle`, `merges`, `tags`, `blob-edges`, `wide-tree`, `orphan-shared-trees`, `mid-history-roots`, `growing-plain`, `growing-gitlinks`, `growing-nonutf8-collide`, `growing-modeswap`, `deep-growing`, `growing-toggle`, `orphan-anchor-tree-reuse`, `monster`, `linear-10k`, `mergetag`, `growing-repetitive-names`.
- **Fixture scale is pinned, not shrunk.** The source's env-overridable knobs became module constants at their defaults: `DEPTH = 2000`, `WIDE = 20_000`, `LINEAR = 10_000`, `TINY_N = 66_000`. The shapes are only adversarial at these sizes.
- **The REF_DELTA count is recorded, not asserted.** The app is built `{ instrument: true }` and each post-repack clone is bracketed by `resetCollected()` / `collectedRuns()`, logging `deltasServed` + `packBytes` per shape — the proof the delta path was actually on. The source script printed this as a diagnostic and did not gate on it (shapes like `tags` and `blob-edges` legitimately serve zero deltas), so neither does the test; inventing a floor would change what the script tests.
- **The `tree:0` carve-out is preserved**: only `--filter=blob:none` is judged against the control, because `tree:0` is a known pre-existing gap (pggit ignores it and ships a superset — `src/e2e/transport-filter-tree0.test.ts`); both filtered clones must still succeed.
- One shape (`orphan-anchor-tree-reuse`) needs a scratch dir inside its `mutate`, so `Shape["mutate"]` gained a 4th parameter — the per-shape temp-dir allocator — instead of reaching for a module-global. Each shape's temp dirs are removed in its own `finally`.
- `mergetag`'s redundant re-`git init` (which the source wrapped in a swallowing `.catch`) was dropped: the sweep already `git init -q -b main`s the source dir, so the call was a no-op and the swallow guarded nothing.

### `shapes--repack-param-limit-many-small-objects`

- **The 66,000-object fixture scale is load-bearing and kept**, built by a single `git fast-import` stream (never per-commit spawns). An explicit `expect(objects).toBeGreaterThan(65_534)` guards the fixture itself: the defect lives exactly at porsager's 65,534 bind-parameter ceiling minus the one parameter spent on `repo_id`, so a shrunken fixture would turn the whole file into a meaningless green.
- The source's `rawBytes()` readout (object count, raw bytes, mean bytes/object) is preserved as a logged line — it is the evidence that the mean sits under the ~244 B/object safety threshold the byte-bounded sweep implicitly assumes.

### Shared to both

- Postgres comes from `createIsolatedSchema(inject("pgBaseUrl"))` in `beforeAll`, dropped in `afterAll`; the hardcoded `postgres://…:6489` URL and the `PGGIT_URL` / `TINY_N` env reads are gone. Each shape gets its own repo name, which is the store's isolation unit.
- One `serveOnPort(createGitApp(createGitDeps(db.sql), …), 0)` per file, closed in `afterAll`.
- Every real-git oracle is intact: the `file://` bare mirror control, `git fsck --strict --no-dangling`, and `cat-file --batch-all-objects` object-set identity.
- Hook and test timeouts are `600_000` (the sweep runs 10k-commit and 20k-entry fixtures; the param-limit file builds two 66k-object repos).

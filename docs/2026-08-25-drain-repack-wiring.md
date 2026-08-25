# W1(a) — repack joins the GC drain

**Date:** 2026-08-25 · **Status:** IMPLEMENTED, same day (harness-first: the SCH-R suite ran red-for-the-right-reason against the stubbed surface — 5 red / 12 green — before the behavior existed). Verification at implementation: gc-scheduler family + generative differential 17/17; SCH-R6 fault file 4/4 solo; statics green; full battery 170 files / 661 tests — 660 green plus ONE red arbitrated per its own documented procedure (`gc-repack-fault-sweep`'s anti-vacuousness guard under machine load, re-run 9/9 solo — the same arbitration recorded 2026-08-24). Applychecks: all five groups run 2026-08-25 against the main checkout (owner-waived worktree), one reviewed commit per group — `9692676` functionality, `8209fc0` layering (whose review also surfaced the stranding gap R-EL′ closes, fixed as `7986e02`), `940679e` ownership, `bcbfac6` testing, `a0eaca7` language — sealed by a final full battery over the finished tree: 170/170 files, 662/662 tests green. This is work item W1(a) of `docs/2026-08-15-delta-pack-design.md` §What remains, sequenced by owner ruling BEFORE the v3.0.0 cut and the ContextLayer integration. It extends the scheduler of `docs/2026-06-24-gc-scheduler-design.md`; that doc's SCH-1…SCH-11 contract remains normative for the GC arm, while this doc supersedes its flat `DrainEntry` and GC-only summary-set wording and strengthens PBT-S1. The design conversation is Claude Code session `bcec9442-eacf-43f2-ba8f-ac60b4a16c1d` (transcripts are deleted after ~30 days — this doc must stand without it).

## The problem, in one paragraph

Before W1(a), the drain (`src/store/gc-scheduler.ts`) ran GC only; repack (`src/store/repack.ts`, the producer of the derived pack-encoding tier) was host-invoked only, so nothing in pggit's own server brought a repo's encoding tier to coverage. Delta-pack D5 decided the shape long ago: per repo the drain runs GC then repack over survivors, with `repos.last_repack_at` (migration 0008) as repack's own watermark — stamped by `repack()` itself on success since D15, because the repair trigger depends on the stamp marking a *completed* pass. W1(a) is purely the scheduler layer plus config plumbing: no migration, no storage-primitive change, no wire change.

## Decisions (with provenance — the owner's words where the owner decided)

- **R-SW — The switch is `PGGIT_GC_REPACK_ENABLED`, default `true`.** (owner: "how about PGGIT_GC_REPACK_ENABLED?") Nested inside the `PGGIT_GC_*` namespace so the name geometry says "a phase of the GC drain," not a peer subsystem; the do-nothing combination (`PGGIT_GC_ENABLED=false` + repack on) is ordinary parent-switch subordination, not a fake state. Flows into `GcSchedulerOptions` as `repackEnabled: boolean`, which the ContextLayer platform wiring (Task B) consumes directly — giving W2's first live drain a real staging lever (GC-only backlog sweep first, then the encoding backfill as a second controlled pass). Code names keep the `gc-scheduler` family: git's own `gc` runs `repack`, so "GC drain" is the umbrella concept in git's own vocabulary (D0′).
- **R-EL — Union selection, per-phase gating.** (owner: "A. Union selection, per-phase gating. This has the crucial property of keeping the work simple and stupid and eventually correct") One candidate query selects repos eligible for either phase and returns both eligibility flags; `drainRepo` runs each phase its own flag licenses, GC first. Both flags mean exactly one thing — "this phase owes work" — and retry after any failure is just "still a candidate next tick."
- **R-EL′ — AMENDED 2026-08-25 (owner: "Couple the arms in the query"): `repack_due` is `repackEnabled AND (its own watermark OR gc_due)`.** The pure-watermark predicate had a stranding gap, found by the layering applychecks pass: an in-grace pass repacks and stamps; a LATER pass sweeps the aged garbage gc-only (repack no longer watermark-due), and the 0008 cascades can hole a survivor's encoding (a live delta whose anchor died — reachable in force-push flows where rewritten history reuses tree objects, the shape pack-encoding/gc's dangling-base fixture pins); gc then settles and NEITHER watermark re-selects the repo, so the hole persists until some future push — "eventually correct" made contingent on a push that may never come. Coupling the arms closes the gap at the pass where holes form: any pass that runs GC also runs repack (a covered repo's extra repack is one empty pending query + a stamp). Serving was never incorrect either way (raw fallback); this is a coverage guarantee, not a correctness fix. The alternatives weighed: accept-and-document (rejected — surrenders eventually-correct), and a deletions-triggered repack in `drainRepo` (rejected — more precise but moves gating logic out of the query, splitting the single enforcement point). Pinned by SCH-R8.
- **R-DE — `DrainEntry` is nested, both phases nullable.** (owner: "A. Nested, both phases nullable") `{ repo, gc: (GcResult & { settled }) | null, repack: RepackResult | null }`. `null` means one thing: no result from this phase this pass; an emitted entry does not distinguish a phase that was ineligible or disabled from one that failed, while failures are logged. `settled` moves inside the gc part because it is a gc concept (grace). Breaking relative to the published v2.x flat shape — carried by the v3.0.0 major.
- **R-TEST — Full-suite runs are unrestricted; the commit gate is total.** Owner rulings 2026-08-25, verbatim: "now you can run full-suite vitests without my permissions. the tests are much faster now. i'm permanently revoking this standing rule"; "W1(a) must be implemented in a separate commit, ALL TESTS must pass for the commit, and all APPLYCHECKS MUST BE RUN FOR THE COMMIT."; harness-first confirmed ("sounds good, harness-first it is!").
- **Provenance of the rest of this doc:** the mechanism section below (including unchanged pool sizing and the concurrency-as-memory-dial stance) was approved explicitly by the owner. The observable contract (SCH-R*) and the verification plan were designed by the agent under the owner's delegated trust ("i trust your judgement, and reserve the right to change any of the decisions later. i haven't read through this") — unreviewed at design time, revision reserved.

## The mechanism

**Config.** `env.ts` gains `PGGIT_GC_REPACK_ENABLED` with the same enum/transform pattern as `PGGIT_GC_ENABLED`, default `true`. `GcSchedulerOptionsSchema` gains `repackEnabled: z.boolean()` — env parsing stays at the boundary, the scheduler takes a resolved boolean. `startServer`'s `gc?: { enabled?: boolean } & Partial<GcSchedulerOptions>` picks the new field up unchanged, defaulting from env.

**Candidate selection.** One query, both eligibility flags computed where they are selected so the WHERE and the flags cannot disagree (the predicate repetition between SELECT and WHERE is deliberate dumb SQL):

```sql
select r.id::text as id, r.name,
  (r.last_gc_at is null or r.last_pushed_at > r.last_gc_at) as gc_due,
  (${repackEnabled} and (r.last_repack_at is null or r.last_pushed_at > r.last_repack_at
    or r.last_gc_at is null or r.last_pushed_at > r.last_gc_at)) as repack_due
from repos r
where r.last_pushed_at is not null
  and ((r.last_gc_at is null or r.last_pushed_at > r.last_gc_at)
    or (${repackEnabled} and (r.last_repack_at is null or r.last_pushed_at > r.last_repack_at)))
```

`Candidate` is the raw query row, tightened so the selected invariant is representable in its type: `{ id, name } & ({ gc_due: true, repack_due: boolean } | { gc_due: false, repack_due: true })`.

**`drainRepo`, two-phase.** If `gc_due`: run gc exactly as today — t0 capture, `gc()`, the settled UPDATE, all unchanged. If gc threw: skip repack (D5 — never encode what the next sweep deletes) and drop the repo from this pass's summary, as today. If `repack_due` and gc did not fail this pass: run `repack.repack(name)`; on throw, log loudly and record no repack result. **Emission rule, subsuming every case: an entry is emitted iff at least one phase produced a result.** So gc-threw → dropped, retried next tick; repack-only-and-threw → dropped, retried next tick; gc-ok-repack-threw → emitted with the real gc numbers and `repack: null`. A failed phase's watermark stays behind and the union keeps the repo a candidate: eventually correct with zero new retry machinery. Neither phase needs new crash-safety — gc's t0-before-snapshot argument and repack's stamp-at-pass-start discipline (an object ingested mid-pass stays newer than the stamp) are each already self-contained; the drain only decides who runs.

**Deliberately unchanged:** `start()`/`stop()`/`inFlight`/`mapPool`, the timer, the per-repo failure-isolation shape, and `startServer`'s dedicated-pool sizing (`concurrency + 1`) — repack runs its queries serially per repo and its COPY flushes ride `pg.begin`'s single reserved connection, so a repo in its repack phase holds at most one connection at a time and the existing headroom covers it.

**The memory dial (approved stance).** `PGGIT_GC_CONCURRENCY` (default 4) now also bounds concurrent repacks, and each in-flight repack holds an unbounded `contentCache` of roughly that repo's tree bytes (delta doc concern C1 — ~70 MB at komal scale, quadratic in commits on the motivating shape). The concurrency dial IS the operator's memory lever; cache bounding stays deferred per C1's own ruling until a real number bites. Hosts draining large-repo fleets size `concurrency` accordingly.

**No new reporting surface.** `drainOnce()`'s summary remains the only reporting surface; the platform-side log line is the ContextLayer wiring's decision (gc-unwired note, question 2). The delta doc's "promote the instrument counters" idea stays parked with Task B.

## The observable contract (normative — the test spec for the harness-first phase)

Same doctrine as the 2026-06-24 doc §6: three observable surfaces (Postgres rows, the git-protocol oracle, the returned `DrainSummary`), no internals ever asserted. New items take the `SCH-R*` prefix — the old doc's numbering stays closed; the prefix tells a reader which contract a test pins.

- **SCH-R1 — The drain produces coverage.** After pushes to a repo, one `drainOnce()` (repack enabled): every `git_object` row under the size cap has exactly one `git_pack_encoding` row; `repos.last_repack_at` is non-null; a clone is fsck-clean with the latest tree; and the entry's `repack.wholes + repack.deltas` equals the encoding rows created.
- **SCH-R2 — Self-terminating and incremental.** With no intervening push, a second `drainOnce()` omits the repo entirely. After a further push, the next drain encodes only the new objects, and every pre-existing encoding row is byte-identical afterward — D4's frozen policy observed through the drain.
- **SCH-R3 — GC-then-repack ordering, observably.** With orphans present and grace 0, one drain leaves encoding-row count equal to post-GC object count and no encoding row for any swept oid: the pass encoded survivors, never garbage.
- **SCH-R4 — Repack-only candidacy, and late enablement.** Drain once with `repackEnabled: false` (gc settles, zero encoding rows, `last_repack_at` stays null), then drain with it `true` and no intervening push: the repo re-qualifies on the repack arm alone, the entry is `{ gc: null, repack: {…} }`, coverage appears. Pins the union's repack arm, the nested shape for a repack-only pass, and "enabling later just works."
- **SCH-R5 — Switch off = today's drain.** With `repackEnabled: false` throughout: no encoding row is ever created by the drain, `last_repack_at` stays null, every entry's `repack` is null, and SCH-1…11 behavior is unchanged.
- **SCH-R6 — Repack failure isolation.** A repo whose repack phase dies mid-pass yields an entry carrying the real gc result with `repack: null`, leaves `last_repack_at` behind, and the next `drainOnce()` completes its coverage. Honesty notes: there is no hermetic deterministic way to make `repack()` throw without a test seam production code must not grow, so this item uses a real fault construction in the established aimed-cancel pattern of the `pg-txn/gc-repack-fault-sweep` family (exact placement decided against that harness at implementation time; it may inherit that family's solo placement). The retry-via-watermark half is already pinned structurally by SCH-R4's mechanism; R6's unique content is the entry shape and recovery after a mid-pass death.
- **PBT-S1 extension (not a new property).** The existing multi-repo differential gains two conjuncts: after a drain with repack enabled, every surviving sub-cap object has exactly one encoding row, and every repo's clone stays fsck-clean.
- **SCH-R7 — Preservation.** The entire existing suite green — which is also the commit gate per R-TEST.
- **SCH-R8 — The arms are coupled (R-EL′).** An in-grace pass repacks and stamps; after the push recedes and the garbage ages, the next pass — gc-due only by the watermarks — sweeps AND repacks in the same pass: its entry carries both results and `encodingViolations` is empty afterward. Under a pure-watermark predicate that entry's `repack` is null and the tier's self-healing is stranded; this item is what makes R-EL′ observable.

**Division of labor, deliberate:** the drain contract stops at *coverage rows exist + clone is clean*. Whether encodings are correctly served (deltas on the wire, byte savings, REF_DELTA-only) stays owned by `pack-encoding/serve` and the wire suites; re-asserting serve behavior through the drain would duplicate that contract against a noisier fixture.

## Verification and the commit (harness-first)

1. **Types + stubs first** so the tests compile: env var, `repackEnabled` in the options schema, the new `Candidate`/`DrainEntry` shapes, `drainRepo`'s skeleton — repack not yet invoked.
2. **Tests before behavior.** SCH-R cases join the *existing* `src/e2e/gc-scheduler/` files by each file's concern (candidacy/idempotence → `loop.test.ts`, coverage/ordering → `reclamation.test.ts`, switch semantics where `server.test.ts`'s SCH-10 black-box gets a one-line encodings assert; final placement follows each file's existing shape). PBT-S1's conjuncts land in the generative differential in place. SCH-R6 lives in `src/e2e/regressions/pg-txn/drain-repack-fault.test.ts`, beside the existing fault-sweep family. Confirm red-for-the-right-reason before implementing.
3. **Implement** — the candidate query, the two-phase `drainRepo`, `startServer` plumbing, module docs. Expected size: tens of lines.
4. **Gate, in order:** statics by exit code (`rm -f dist-types/tsconfig.tsbuildinfo` then `tsc -b tsconfig.json --force`; `biome check --error-on-warnings .`; `tsdown`) → **full battery** (`node_modules/.bin/vitest run`, unrestricted per R-TEST; timing-sensitive reds on a loaded box are arbitrated solo per the repo's documented solo-file discipline) → **all applychecks groups** over the change (read the applychecks SKILL.md before the first run of the session) → re-verify after any codex edits.
5. **One commit**, via `gitc`, message `feat(gc-scheduler)!:` with a `BREAKING CHANGE:` footer for the `DrainEntry` reshape (breaking relative to the published v2.x export; the range is already major, the marker keeps history honest). The gitc generator omits `!` on breaking commits — check `git log -1` and amend via `git commit --amend -F <file>` keeping the generated body.

**Documentation updated across implementation and applychecks:** `README.md`; `src/store/repack.ts`'s module doc scheduling contract (repack follows GC and stamps its own watermark); `src/store/gc-scheduler.ts`'s module doc (two-phase pass); `src/env.ts` comments; a short dated pointer addendum in `docs/2026-06-24-gc-scheduler-design.md` (§5/§6 extended by this doc); and the delta doc's W1(a) entry annotated as landed.

## Out of scope, named

- The ContextLayer wiring itself (W1(c)/Task B): where the platform starts the scheduler, cadence, observability, the CTX-side env surface — gc-unwired note questions 1–4.
- W2's first live drain and the live `ctx_pggit` migration plan (owner ruling: folded into the integration step explicitly).
- Repack `contentCache` bounding (C1 — deferred until a real number bites), any repack tunables beyond the one switch (`ANCHOR_EVERY` stays a constant), multi-instance claims (unchanged deferral from the scheduler doc §8).

## Implementation notes

### Decided — implementation

- **The switch has exactly one enforcement point: the candidate query's `${repackEnabled}` bind.** `createRepack(pg)` is constructed unconditionally beside `createGc(pg)`, and `drainRepo` carries no `if (repackEnabled)` — when the switch is off, `repack_due` is false for every candidate by construction. Rejected: conditional construction or a second JS-side gate, which would be two places for "off" to disagree.
- **Repack rides the scheduler's own `pg` handle** — in `startServer` that is the dedicated `gcPg` pool, so repack's reads and COPY flushes never touch the request pool. This falls out of building `createRepack` over the scheduler's `pg`; wiring it over the request `pg` instead would silently undo the connection-isolation decision the scheduler doc records (§9).
- **`repack.repack(c.name)` by name, not by the candidate's `id`.** Repack re-resolves via `lookupRepoId` deliberately (its module doc: a long-lived instance must survive repo delete/re-create cycles). The obvious "optimization" — passing the id the candidate query already has — breaks that contract.
- **`startServer`'s signature is unchanged**; the only edit there is one defaulting line in the resolve call (`repackEnabled: opts.gc?.repackEnabled ?? env.PGGIT_GC_REPACK_ENABLED`).
- **The entry embeds gc's result by spread** (`{ ...gcResult, settled }`), not by destructuring named fields, so a future `GcResult` field reaches `DrainEntry` without a second edit site.

### Nuances

- **`settled` gates only the `last_gc_at` stamp; it never gates repack.** An in-grace pass (settled false) still repacks. Encoding young objects that a later sweep reclaims is the designed path — the FK cascades hole the tier and D15's repair mode re-covers — not a leak. A reader pattern-matching "unsettled = incomplete, skip downstream work" would build the exact wrong thing.
- **Do not symmetrize the watermarks.** The drain writes `last_gc_at` (t0-captured-before-snapshot semantics); the drain must NOT write `last_repack_at` — `repack()` stamps itself so the stamp means "a completed pass" for every invoker, which is what D15's repair trigger reads. Making the drain stamp both "for consistency" is the plausible wrong turn this line exists to stop.
- **`repack: { wholes: 0, deltas: 0 }` and `repack: null` are different claims.** Zeros = the phase completed and found nothing pending (real case: a ref-delete push advances `last_pushed_at` with no new objects; repack runs, stamps via its early return, reports zeros). Null = the phase produced no result because it did not run or it failed. Tests must assert the distinction, never treat them as interchangeable.
- **SCH-R1/R3 count-equality inherits delta doc N7:** coverage means every object UNDER the size cap — a fixture containing a ≥cap object breaks the equality, and the fix is the size predicate in the assertion, never touching the cap.
- **Grace-0 belongs only in `drainOnce`-driven cases.** The SCH-10 black-box (real timer, real server) must keep nonzero grace — commit `2e61899` exists because grace 0 + 50 ms cadence let the drain reclaim a just-pushed closure mid-fetch.

### Traps

- **`copyInsert` never issues `COPY git_pack_encoding`** — it stages through a temp table, so the wire statements name `copy_stg_git_pack_encoding` (create-temp, COPY, insert — all three per flush). An aimed fault or `pg_stat_activity` probe watching for the target table's name in a COPY will wait forever; watch the staging name (paid 2026-08-25: SCH-R6's first run missed on exactly this).
- **Biome reformats SQL template literals when a backtick appears inside a SQL comment** (it mangled migration 0008 into invalid SQL once — delta doc N5). The candidate-query edit is exactly this territory: no backticks in SQL comments.
- **Machine-local tooling (rots with the machine, not the repo):** the bare `pnpm` shim is broken (mise has no global default) — drive tsc/biome/vitest via `node_modules/.bin/*`, biome via the installed bin only. codex (applychecks) runs sandboxed: it cannot `rm -f` or run vitest, so after any codex edits re-run statics yourself including the `dist-types/tsconfig.tsbuildinfo` delete, then the battery.
- **`gitc` discipline:** never chained with other commands; every commit waits on a 1Password click (`1Password: failed to fill whole buffer` → `failed to write commit object` means a human has not clicked, not breakage); the message generator omits `!` on breaking commits and has no prompt-leak sanitizer — check `git log -1`, amend via `git commit --amend -F <file>` keeping the generated body.

### Consequences to fold into the change

- `src/index.ts` already exports `DrainEntry`/`DrainSummary` and `RepackResult` (verified 2026-08-25) — the reshape flows through existing exports; nothing new to export.
- Test-file anchors, verified 2026-08-25: `src/e2e/gc-scheduler/{activity,isolation,loop,reclamation,server}.test.ts`, `src/generative/gc-scheduler.test.ts`, `src/e2e/regressions/pg-txn/gc-repack-fault-sweep.test.ts`.
- The documentation updates are listed in the verification section above; nothing beyond them surfaced.

### Resolved during implementation

- SCH-R6's exact fault point and placement — decided against the fault-sweep harness when writing it. That family is solo-arbitrated: its anti-vacuousness guard reds under heavy machine load when an aimed cancel lands late; green solo is the arbitration, per the file's own placement note. *(Resolved at implementation, 2026-08-25: its own sibling file `src/e2e/regressions/pg-txn/drain-repack-fault.test.ts`, solo-listed, driving `drainOnce` on a max-1 client with an aimed `pg_cancel_backend` at the first observed statement naming copyInsert's staging table; the entry itself is the vacuousness barrier — a missed aim yields `repack: {…}` and fails loudly.)*
- `DrainAttempt`'s internal union shape is free; the emission rule ("entry iff at least one phase produced a result") is the contract.

### Concerns

- PBT-S1's new conjuncts add a per-iteration coverage query and keep the fsck across repos — watch the generative file's runtime against the test-efficiency mission's budgets (`docs/2026-08-20-test-efficiency.md`); if it grows materially, sample the conjuncts rather than asserting every iteration, decided with measured numbers.
- SCH-10's cadence numbers under full-suite contention: standing guidance (delta doc C2) is to widen the cadence, not chase the flake.

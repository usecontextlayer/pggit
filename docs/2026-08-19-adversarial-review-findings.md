# Adversarial review findings — full-repo, two chunks (2026-08-19)

> **Rename note (2026-08-21 reorg):** paths in the frozen appendices and dispositions below predate the reorganization: `src/e2e/breakage/<lens>--<name>.test.ts` → `src/e2e/regressions/<lens>/<name>.test.ts`, `src/repo-view/` → `src/repo-file/` (`repo-file-projection.ts` → `projection.ts`, `rebuild.ts` → `sync-ref.ts`), `syncRefSnapshot`/`dropRefSnapshot`/`rebuildAllSnapshots` → `syncRefProjection`/`dropRefProjection`/`rebuildAllProjections`, `src/gc-scheduler.ts` → `src/store/gc-scheduler.ts`, `src/oid.ts` → `src/object/oid.ts`, `src/object/derive.ts` → `src/object/ingest-validation.ts`, `src/generative/commands.ts` → `src/testing/repo-commands.ts`, and the `.spec.test.ts` infix was dropped from every test filename. Additionally (2026-08-24) the flat `src/e2e/` prefix clusters became folders with the prefix dropped — `push/`, `fetch/`, `gc/`, `gc-scheduler/`, `transport/`, `pack-encoding/` (e.g. `fetch-multiround.test.ts` → `fetch/multiround.test.ts`). Mentions below keep the names that were current at review time.

**What this is.** The S7 adversarial review the derived-state spine's goal called for: the ENTIRE repo, reviewed in two chunks — production code and the test suite — by codex (gpt, read-only sandbox), findings verified and dispositioned by the implementing session (Claude, session `5a316ad0-fd4b-4c8a-8608-a526817a989d`). The raw reports are inlined as appendices; this ledger is the disposition record. Everything marked FIXED landed 2026-08-19 with the S7 pass and is covered by the re-run gates; everything marked RECORDED is real-but-deferred work the fix would not have been honest to rush; DISPUTED carries the reasoning.

## Dispositions — code chunk

| finding | disposition |
|---|---|
| Epoch reads can mix old array with new bitmaps | **FIXED** — `loadEpoch` pins the bitmap read to the epoch the first statement saw; a mid-replacement read comes back short and the serve guard falls back to the walk. |
| GC deletes a re-sent object between connectivity and CAS | **RECORDED** — the deferred per-repo advisory lock (redesign §5.4, already documented in `gc.ts`); grace is the standing defense. Real; needs the write-path lock design, not a patch. |
| Scheduler permanently settles young garbage | **FIXED (user-approved, 2026-08-19)** — a pass settles (`last_gc_at` stamped, atomically guarded in SQL) only when it ran past the grace horizon of the repo's last push; inside the window the repo stays eligible for cheap re-passes (unchanged tips skip the walk). `DrainEntry.settled` makes it observable; a regression test backdates deterministically, and the loop suite was retargeted to the new rule. |
| Direct GC self-deadlocks at `max: 1` (maintain borrows the pool) | **FIXED** — `maintain()` runs on the pass's reserved connection. |
| Delta decoding accepts truncated instructions / synthesizes zeros | **FIXED (user-approved, 2026-08-19)** — every COPY/INSERT range is validated before the copy (`delta-copy-out-of-range` / `delta-insert-truncated`), and read-pack compares each delta entry's inflated program length to its pack-header size; hand-built repro vectors added, encode-delta oracle green. |
| Push has no expansion budget; pack materialized repeatedly | **RECORDED** — the W4 streaming work item, confirmed independently. |
| Reverse REF_DELTA chains resolve quadratically | **RECORDED** — legal-but-pathological input; work-queue fix sketched in the report. |
| Invalid refnames persist and poison framing | **FIXED (user-approved, 2026-08-19)** — `refNameProblem` applies git's check-ref-format at the wire boundary (per-ref `ng funny refname`, matching git's wording), and directory/file conflicts are checked in git's sequential lock order against existing + earlier-in-batch names; wire-level tests in `refname-policy.test.ts` (`.spec` infix stripped in the 2026-08-21 reorg). |
| New branches may point at non-commit objects | **FIXED (user-approved, 2026-08-19)** — probed against canonical receive-pack first (rejects blob/tree under refs/heads/ per-ref as "invalid new value provided"; accepts them under refs/tags/): pggit now matches exactly, via a light `objectType` probe in the policy chain. Real-git driven tests in `typed-graph-policy.test.ts`. |
| Zero-padded tree modes make walks under-walk | **FIXED** — `validateObject` rejects noncanonical tree modes at ingest (`malformed-tree-mode`), the same deliberate-strictness seam as D16. |
| Repo-name caches retain deleted IDs (multi-process too) | **RECORDED** — single-process invalidation exists; cross-process/interleaving needs versioned invalidation design. |
| Fetch responses copy the whole pack several times | **RECORDED** — W4 streaming, confirmed. |
| originClosure masks are O(objects × tips) in JS | **RECORDED** — the cost is documented in the spine doc; the reviewer's thousands-of-tips shape is beyond the workspace-repo envelope. A loud epoch budget is the priced guard if it ever bites. |
| Projection spreads crash past ~125k files | **FIXED** — the three `push(...spread)` sites in `tree-diff.ts` became loops. Memory/pipelining beyond that: RECORDED. |
| Text-keyed projection vs git's path domain | **DISPUTED (by design) / RECORDED (edge)** — UTF-8-only paths are the user-approved D16 BREAKING CHANGE, deliberate. The ~3 KiB-path B-tree tuple limit edge is real and RECORDED. |
| Connectivity verifies existence, not required type | **FIXED (user-approved, 2026-08-19)** — the walks carry per-edge EXPECTATIONS (parent→commit, commit.tree + 40000 entry→tree, blob-mode entry→blob) and judge a mistyped edge like an absent object: connectivity rejects the push, a serve refuses the want, and no epoch claims the oid — never an under-walk. Declared-vs-actual TAG target type stays unenforced (git default-permissive; fsck-strict territory). |
| Malformed tree names/duplicates collapse in projection | **RECORDED** — same ingest-validation family. |
| Three optimistic retries can leave projection behind | **RECORDED** — documented trade; durable reconcile-to-tip needs design. |
| GC publishes a partial epoch over a missing-object walk | **FIXED** — a walk with `missing` never writes an epoch and drops the stored one (`cleared` on a repo with refs = the visible anomaly). |
| v2 ignores terminal framing; haves unvalidated | **PARTIALLY FIXED** — haves now validated with the same `isOid` boundary rule as wants (malformed have = loud protocol error, matching git). Full request-state machine: RECORDED. |
| Zero-command/malformed pushes create repos | **RECORDED** — conformance/hygiene; needs create-on-first-WRITE sequencing. |
| Unbounded per-command Promise.all | **RECORDED**. |
| Post-commit stamp loss | **RECORDED** — the documented S5 trade; a transactional dirty-generation outbox is the real fix. |
| setRef persists short/empty oids | **FIXED** — `toOid` validates 40-hex before coercing. |
| Commit timestamps round through JS numbers past 2^53 | **RECORDED** — forged-timestamp envelope; S1 ingest could cap instead. |
| 0009 backfill memory unbounded per repo | **RECORDED** — per-repo whole-graph maps; fine at the migration's actual scale, keyset-streaming noted. |
| report-status emitted without negotiation | **RECORDED** (low). |
| Instrumentation retains every request | **RECORDED** (low; `instrument: true` is a diagnostic opt-in). |
| Repack/rebuildAllSnapshots have no production consumer | **RECORDED** — repack's production wiring is the engine-side drain (the excluded W1/W2 integration); noted so the integration doesn't forget it. |
| (plausible) admin deletion vs in-flight push | **RECORDED** — documented caller contract; same advisory-lock family. |
| (plausible) delayed delete callback erases recreated projection | **RECORDED**. |
| (plausible) one blocked GC query wedges scheduler/shutdown | **RECORDED** — statement/lock timeouts wanted. |
| (plausible) server startup error listener | **RECORDED** (low). |

## Dispositions — tests chunk

| finding | disposition |
|---|---|
| Signal-killed git children resolve as success | **FIXED** — `spawnGit` rejects null exit codes with the signal. |
| pkt-oracle accepts truncated suffixes | **FIXED** — `decodeComplete` rejects undecoded trailing bytes in all four helpers. |
| fetch-multiround enshrines the buggy no-pack-after-ready behavior; canonical sibling skipped | **FIXED (user-approved, 2026-08-19), with a corrected diagnosis** — the wire shape was ALREADY canonical (`encodeReadyWithPack` sends the pack in the same response as `ready`; landed with S4/S5). The real residue was `readyToGiveUp`'s DIRECTION: it asked "does the want descend from a common?" (`ancestry`), so a SIBLING have sharing a base never readied and every such fetch paid an extra round. Fixed by `sharesAncestry` (merge-base-exists — git's `ok_to_give_up` relation, a distinct concept keeping `ancestry` as the FF check); the parked `fetch-ready-sibling.skip.test.ts` is unskipped as the live-oracle regression, and fetch-multiround's "non-cutting have" fixture now uses a truly UNRELATED root (a sibling have canonically readies — its old fixture pinned the bug). |
| realrepo differential accepts exact-OID rejections silently | **FIXED** — a pggit rejection is a failure unless canonical git rejects the same fetch. |
| Fault-injection suites don't prove the fault fired | **RECORDED** — real class across four suites; needs per-case fault-observed barriers (a suite-shape rework). |
| encoding-tier perf gate crashes on `edge.total` | **FIXED** — S2 retarget leftover; now `commit.total`. |
| Capability golden stale (missing `thin-pack`) | **FIXED** — golden matches the S5 advert (was latent-red: no S5/S6 chain ran the protocol batch). |
| Thin-pack negotiation deletable while tests stay green | **FIXED** — a WIRE-level test drives `handleUploadPack` with raw v2 requests with/without `thin-pack`; readPack's base resolver detects external bases. |
| Warm-delta fixture satisfiable by stored deltas | **FIXED** — the fixture no longer repacks (empty encoding tier asserted), so an external base proves the WARM path specifically. |
| Epoch/bitmap correctness is pggit-vs-pggit | **PARTIALLY FIXED** — the producer oracle now also compares each commit tip's bitmap against canonical `git rev-list --objects`; the serve side keeps drain-invariance (whose walk side is git-anchored by the S4 oracle). Route/fallback telemetry: RECORDED. |
| Partial-clone tests never require omission | **PARTIALLY FIXED** — the bitmap-serve `blob:none` case now requires strictly fewer objects and the exact omitted blobs absent. The two older filter tests: RECORDED. |
| Idempotence tests validate only the second pass | **DISPUTED (suite-level)** — PBT-1/2 and STRESS-1 assert first-pass reclamation against git-derived survivor sets in the same properties; the no-op check is deliberately narrow. |
| Race tests don't prove overlap or participant success | **RECORDED** — real class; needs barrier-based rework per suite. |
| Short-pack race targets removed architecture | **RECORDED** — candidate for rebuild against the current walk seams (post-S2 the documented seam no longer exists). |
| Client-rewritten packfiles treated as wire evidence | **PARTIALLY FIXED** — fetch-negotiation already measures wire-new = pack minus already-had; the new wire-level thin test reads the raw response. Full HTTP capture in realrepo perf gates: RECORDED. |
| Delta assertions pass on zero-delta fixtures | **FIXED (the e2e)** — delta-before-base now REQUIRES a deltified pack. Perf-harness siblings: RECORDED. |
| Perf gates encode missing data as best score | **RECORDED** — diagnostic harnesses; prerequisite-correctness-first noted. |
| Named fixtures don't establish named preconditions | **RECORDED**. |
| Generative merge suppresses every git failure | **FIXED** — a merge failure is skipped only with unmerged index entries (`ls-files -u`) as proof of conflict. |
| Graph dimensions not as advertised | **PARTIALLY FIXED** — the criss-cross fixture now creates two merge bases and self-verifies via `merge-base --all`. gc-stress "wide refs" as ancestors: RECORDED. |
| Projection property can assert nothing | **FIXED** — the seed projection is always asserted; commit failures skip only with a PROVEN clean status. |
| Object-store idempotence self-compares | **FIXED** — expected oids come from `git hash-object`. |
| Wire error tests assert narrow symptoms | **RECORDED**. |
| Epoch producer is an order-dependent state machine | **ACCEPTED (by design)** — one staged repo lifecycle, deliberately; the header documents it. |
| (plausible) scheduler shrink inherits DB state | **RECORDED**. |
| (plausible) incremental-push property guarantees neither CAS nor thin | **RECORDED**. |
| (plausible) grace-split wall-clock flake | **RECORDED**. |
| (plausible) gzip test never observes gzip | **RECORDED**. |
| (plausible) RSS sampler misses sync allocation | **RECORDED**. |
| Coverage gap: concurrent epoch publication barriers | **PARTIALLY FIXED** — the load-side race is closed by the epoch-pinned read; deterministic two-producer tests: RECORDED. |
| Coverage gap: boundaryHits/boundaryExact never asserted | **FIXED** — `src/e2e/frontier-provenance.test.ts` table-drives the four provenance shapes. |
| Coverage gap: chained-tag epoch tips + include-tag | **FIXED** — bitmap-serve grows a `vmeta → v1 → c1` chain, a fork at the peeled commit fetched `--no-tags` (chain absent) and with auto-follow (chain present). |
| Coverage gap: ancestor rewind (tip inside the old array) | **FIXED** — a producer stage moves main back to an in-epoch ancestor and requires `rebuilt` + reclamation. |
| Coverage gap: duplicate/mixed bitmap wants | **RECORDED** — epochServe dedups by construction; raw-wire combos noted. |
| Coverage gap: router haveful/mixed-type matrix | **RECORDED** — the S4 oracle covers the primary pairs; the full matrix is follow-up. |

## Round 3 — adversarial review OF the round-2 fixes (2026-08-19)

The round-2 diff (the four post-review commits) was itself reviewed by a third codex chunk (raw report: Appendix C). It caught real defects in the fixes — the strongest argument for reviewing reviews. Dispositions:

| finding | disposition |
|---|---|
| CRITICAL: typed-edge "commit" expectation converts a missing-derived-row parent into a sweepable object (corruption → data loss) | **FIXED** — `judgeProbedType` distinguishes corruption from violation: a COMMIT/TAG type in the object probe crashes LOUD (chunk-1 invariant) unless ONLY tree/blob edges named the oid (then the EDGE is malformed, the object possibly healthy). GC can never sweep on it — the pass dies first. Repro: the corrupt-parent case in `typed-graph-policy.test.ts` asserts both `isConnected` and `gc()` throw and nothing is swept. |
| Typed-edge validation is path-dependent (stop-set short-circuit; first-enqueue-wins; GC could sweep a validly-referenced object) | **FIXED** — (a) stop-set oids collect their edge expectations and get one batched deferred type probe after the walk; (b) expectations are SETS satisfied by ANY member, accumulated even for visited oids; (c) `originClosure` gained a violation MODE: "reject" (connectivity — fail like absent) vs "retain" (GC — the object stays in the live masks and expands by ACTUAL type, so a malformed edge can never make a validly-referenced object sweepable), with `violations` reported separately and the epoch withheld on any. Cross-level expectation ordering can still over-REJECT a malformed graph on the serve path — stricter, never unsound; noted in code. |
| Both optimized serve routes bypass the type policy (frontier blob probe; stale epochs on pre-strictness graphs) | **RECORDED** — the frontier's boundary logic already fails safe on tree-typed reads; a mistyped leaf served to a client fails the CLIENT's index-pack/fsck cleanly. A stale epoch over a corrupt graph persists until any walk runs (which withholds it); corrupt repos are outside the drain-invariance contract. |
| receive-pack accepts one-level names under refs/ (`refs/heads` itself) | **FIXED** — `refNameProblem` requires a second level below `refs/`, matching canonical `check_refname_format` without ALLOW_ONELEVEL. |
| D/F rule neither atomic nor complete (concurrent pushes; symrefs invisible) | **PARTIALLY FIXED** — `listRefNames` is now a dedicated refs-store query INCLUDING symrefs. The concurrent-push race folds into the standing deferred per-repo advisory lock (redesign §5.4) — same family as GC-vs-push, recorded there. |
| A rejected command still reserves its namespace against valid ones | **FIXED** — D/F is judged LAST, in git's sequential lock order, over commands that passed every other check; a rejected command no longer occupies its name. |
| `sharesAncestry` is not git's ok_to_give_up (over-readies deep forks; non-commit wants block readiness) | **FIXED** — `sharesAncestry` is DELETED. `readyToGiveUp` now implements upload-pack's exact semantics: each ACKed have marks itself AND ITS DIRECT PARENTS `THEY_HAVE`, every COMMIT want's ancestry must reach that set (directional `ancestry`, no second closure), and non-commit wants are skipped as git skips them. This also erased the dual-recursive-CTE cost and the planner-flip exposure the review flagged (one directional CTE remains, the shape already priced). The sibling-ready behavior is preserved (the parent step covers it) and its test header corrected. |
| Strict delta decoder accepts sub-minimum programs | **FIXED (relocated after the gate caught the first cut)** — the 4-byte minimum belongs at the WIRE boundaries, not inside `applyDelta`: our own encoder legally produces 2-byte programs for empty targets (the encode→apply round-trip properties proved it). Enforced in read-pack (foreign packs) — and the gate exposed the deeper half: BOTH serve paths could ship a client-fatal sub-minimum delta, so the warm-delta emit AND repack's stored tier now fall back to whole forms under 4 bytes. The codec property constrains itself to legal packs. |
| `sharesAncestry` repeats the deep common walk per want | **FIXED by deletion** (see ok_to_give_up above — the common side is now one parents lookup, batched). |
| Grace settling re-runs the full GC pipeline 2–3× per push at defaults | **RECORDED** — the re-passes skip the WALK (unchanged tips) but still COPY the live set and sweep; 2–3 bounded repeats per push-then-quiet cycle is the price of never orphaning young garbage. If it bites at scale, the priced improvement is a persisted `next_gc_at` instead of re-eligibility. |
| (plausible) negotiation CTE plan/spill exposure | **MOOT** — the dual-closure CTE is gone; the remaining directional CTE over `git_commit` is the shape the spine doc priced (PK probes, no anti-join). |
| (plausible) typed-expectation maps add O(reachable) memory to walks | **RECORDED** — deterministic overhead, unmeasured at production concurrency; the negative sweep runs green with it. |

## Appendix A — raw code-chunk report

## Confirmed

### high — Epoch reads can combine old OID positions with new bitmap bytes

Evidence — [src/store/reach-epoch.ts:52](/Users/alizain/ContextLayer/pggit/src/store/reach-epoch.ts:52) reads `select epoch::text as epoch, tips, oids`, then [src/store/reach-epoch.ts:59](/Users/alizain/ContextLayer/pggit/src/store/reach-epoch.ts:59) separately reads bitmaps using only `where repo_id = ${id}::bigint`.

Scenario — A fetch reads epoch E’s OID array, GC commits E+1, then the second statement reads E+1’s bitmaps. Surviving tips satisfy the missing-bitmap guard, but bitmap positions are interpreted against E’s array, producing substituted/omitted objects or invalid OIDs.

Fix — Load the epoch row and bitmaps in one statement joined on both `repo_id` and `epoch`, or use a pinned repeatable-read transaction.

### high — GC can delete a re-sent object after connectivity but before ref CAS

Evidence — [src/store/gc.ts:124](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:124) states the write path and GC share no advisory lock; [src/database/copy-insert.ts:150](/Users/alizain/ContextLayer/pggit/src/database/copy-insert.ts:150) uses `on conflict do nothing`; [src/index.ts:136](/Users/alizain/ContextLayer/pggit/src/index.ts:136) separates ingest/connectivity from ref application; [src/store/refs-store.ts:155](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:155) inserts refs without an object FK.

Scenario — Old orphan X has aged past grace. A legitimate push re-sends X, but conflict suppression preserves its old `created_at`. Connectivity succeeds while X exists; a concurrent GC snapshot excludes the not-yet-created ref and deletes X; CAS then ACKs a ref whose closure is missing X.

Fix — Hold the same per-repo advisory lock across receive ingest, connectivity, and CAS, and across GC live-set construction and sweep; alternatively implement durable in-flight pins.

### high — The scheduler permanently settles young garbage before it becomes eligible

Evidence — [src/gc-scheduler.ts:63](/Users/alizain/ContextLayer/pggit/src/gc-scheduler.ts:63) selects only `last_pushed_at > last_gc_at`; [src/gc-scheduler.ts:85](/Users/alizain/ContextLayer/pggit/src/gc-scheduler.ts:85) advances `last_gc_at` after every successful pass; [src/store/gc.ts:451](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:451) deletes only objects older than grace.

Scenario — With the default 30-second polling and 60-second grace, a denied push leaves fresh unreachable objects. The next pass deletes nothing but marks the repo caught up. After the objects age past grace, no new push requalifies the repo, so they remain forever.

Fix — Delay eligibility until `last_pushed_at + grace`, or persist a `next_gc_at`/youngest-retained watermark and keep the repo eligible for a post-grace pass.

### high — Direct GC self-deadlocks with a one-connection pool

Evidence — [src/store/gc.ts:146](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:146) reserves a connection until [src/store/gc.ts:210](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:210); when objects were deleted, [src/store/gc.ts:188](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:188) calls `await maintain()`, whose [src/store/gc.ts:472](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:472) implementation borrows through the outer pool with `pg.unsafe(...)`.

Scenario — `createGc(pg).gc()` with default `maintain: true` and `max: 1` holds the sole connection and waits forever for a second connection to run VACUUM.

Fix — Run maintenance on the reserved session after its transactions close, or release that session before borrowing through the pool.

### high — Delta decoding accepts truncated instructions and synthesizes zero bytes

Evidence — [src/pack/delta.ts:182](/Users/alizain/ContextLayer/pggit/src/pack/delta.ts:182) pre-zeroes `Buffer.alloc(targetSize)`; [src/pack/delta.ts:200](/Users/alizain/ContextLayer/pggit/src/pack/delta.ts:200) and [src/pack/delta.ts:204](/Users/alizain/ContextLayer/pggit/src/pack/delta.ts:204) rely on clamping `Buffer.copy` calls while advancing by the declared size. Separately, [src/pack/read-pack.ts:114](/Users/alizain/ContextLayer/pggit/src/pack/read-pack.ts:114) decodes the outer size, but delta branches at [src/pack/read-pack.ts:117](/Users/alizain/ContextLayer/pggit/src/pack/read-pack.ts:117) never compare it to the inflated delta length.

Scenario — Base `aa` with delta `01 02 90 02` returns `aa00`; an INSERT declaring three bytes but carrying one returns that byte followed by two zeros. The final target-size check passes, so pggit accepts a pack canonical `index-pack` rejects.

Fix — Explicitly validate every instruction-source and destination range before copying, and compare each delta entry’s inflated program length with its pack-header size.

### high — Push handling has no expansion budget and materializes the pack repeatedly

Evidence — [src/index.ts:61](/Users/alizain/ContextLayer/pggit/src/index.ts:61) uses `Buffer.from(await c.req.arrayBuffer())` followed by synchronous `gunzipSync(raw)`; [src/pack/read-pack.ts:39](/Users/alizain/ContextLayer/pggit/src/pack/read-pack.ts:39) accumulates all inflate chunks before `Buffer.concat`; [src/pack/read-pack.ts:109](/Users/alizain/ContextLayer/pggit/src/pack/read-pack.ts:109) retains all raw and resolved entries; [src/store/object-store.ts:524](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:524) builds another row graph; [src/database/copy-insert.ts:74](/Users/alizain/ContextLayer/pggit/src/database/copy-insert.ts:74) builds per-field buffers and returns `Buffer.concat(parts)`.

Scenario — A small HTTP gzip bomb or zlib pack entry expands to hundreds of MiB before any size mismatch is checked. A valid highly compressible large push simultaneously retains the request, inflated objects, delta results, COPY rows, field buffers, and a final COPY buffer, exhausting the process heap.

Fix — Stream request decompression and pack parsing with compressed, expanded, per-object, and aggregate limits; stage resolved objects incrementally; stream binary COPY frames with backpressure.

### high — Reverse REF_DELTA chains resolve in quadratic time

Evidence — [src/pack/read-pack.ts:190](/Users/alizain/ContextLayer/pggit/src/pack/read-pack.ts:190) runs `while (pending.length > 0)` around [src/pack/read-pack.ts:193](/Users/alizain/ContextLayer/pggit/src/pack/read-pack.ts:193) `for (const off of pending)`.

Scenario — A legal order `D1,D2,…,Dn,base`, where each delta references the next delta’s output OID, resolves one entry per pass. It performs `n + (n-1) + … + 1` attempts and initially makes one sequential external-base lookup per forward reference.

Fix — Maintain reverse dependencies keyed by base OID/offset and release dependants through a work queue; batch external lookups only after internal resolution stalls.

### high — Invalid refnames can be persisted and poison later protocol framing

Evidence — [src/protocol/receive-pack.ts:104](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:104) validates only the three space-separated fields and OIDs; [src/protocol/receive-pack.ts:192](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:192) checks only byte length; [src/store/refs-store.ts:151](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:151) performs `const name = cmd.ref as GitRefName`.

Scenario — A command creates `refs/heads/x\ny`, a `.lock` suffix, `..`, control characters, or a directory/file conflict such as both `refs/heads/a` and `refs/heads/a/b`. The name is stored and later interpolated into advertisements/status lines, causing Git clients to reject or misparse the repository.

Fix — Apply canonical `check-ref-format` rules, including namespace D/F conflicts, before pack ingest and CAS.

### high — New branches may point directly at non-commit objects

Evidence — [src/protocol/receive-pack.ts:169](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:169) says creates are unrestricted; [src/protocol/receive-pack.ts:234](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:234) skips ancestry for creates, and the rejection reasons at [src/protocol/receive-pack.ts:245](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:245) contain no type check.

Scenario — A client pushes a blob and creates `refs/heads/main` at its OID. Blob connectivity succeeds, CAS ACKs the branch, and snapshot failure is merely logged. Canonical receive-pack rejects a non-commit under `refs/heads/*`.

Fix — Resolve each new tip’s type before CAS and require commits for `refs/heads/*`; retain broader object types only for namespaces where Git permits them.

### high — Accepted zero-padded tree modes make connectivity and fetch under-walk

Evidence — [src/object/object.ts:49](/Users/alizain/ContextLayer/pggit/src/object/object.ts:49) accepts the raw mode verbatim; [src/object/object.ts:60](/Users/alizain/ContextLayer/pggit/src/object/object.ts:60) recognizes only `mode === "40000"`; frontier walking branches on that predicate at [src/store/reachability.ts:589](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:589) and [src/store/reachability.ts:641](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:641).

Scenario — An update contains a raw `040000` subtree, carries the subtree object, but omits a descendant. The frontier treats the subtree as a blob, validates only its own OID, and advances the ref. A `blob:none` cold fetch skips even that subtree object. Canonical Git interprets it as a directory and flags the noncanonical mode.

Fix — Reject noncanonical raw tree modes during ingest; do not broaden walkers to legitimize malformed objects.

### high — Repo-name caches can permanently retain deleted repository IDs

Evidence — [src/store/repo-resolver.ts:91](/Users/alizain/ContextLayer/pggit/src/store/repo-resolver.ts:91) awaits `lookupRepoId` and then executes `cache.set(name, id)`; [src/store/repo-admin.ts:35](/Users/alizain/ContextLayer/pggit/src/store/repo-admin.ts:35) commits deletion before `repos.invalidate(name)`; cached values are returned unconditionally at [src/store/repo-resolver.ts:54](/Users/alizain/ContextLayer/pggit/src/store/repo-resolver.ts:54).

Scenario — A cold lookup reads old ID X, deletion commits and invalidates the still-empty cache, then the lookup continuation caches X. Reads silently return no rows and recreate writes FK-fail forever. In a multi-process deployment, deletion invalidates only one process, leaving every other warmed resolver stale.

Fix — Remove lifetime memoization, preserve stable repository identities, or use database-backed/versioned cross-process invalidation and verify the generation after awaited lookups.

### high — Fetch responses hold and copy the complete pack several times

Evidence — [src/store/object-store.ts:106](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:106) accumulates pack parts before [src/store/object-store.ts:299](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:299) `Buffer.concat`; [src/protocol/sideband.ts:16](/Users/alizain/ContextLayer/pggit/src/protocol/sideband.ts:16) copies every sideband chunk and concatenates them; [src/protocol/v2.ts:190](/Users/alizain/ContextLayer/pggit/src/protocol/v2.ts:190) concatenates again; [src/index.ts:48](/Users/alizain/ContextLayer/pggit/src/index.ts:48) performs an `ArrayBuffer.slice`.

Scenario — A valid 1 GiB clone holds object contents and compressed parts, creates a complete pack, copies it into sideband frames, copies those into the v2 response, and copies again for HTTP. Peak memory reaches several times pack size.

Fix — Stream object encoding, pack hashing, sideband framing, and the HTTP response end-to-end; batch object reads by cumulative bytes rather than only object count.

### high — GC’s “server-side” live set is first materialized as an O(objects × tips) JS structure

Evidence — [src/store/reachability.ts:248](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:248) stores a `Map<string, bigint>` mask for every reachable OID; [src/store/gc.ts:306](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:306) materializes sorted OIDs; [src/store/gc.ts:373](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:373) scans every mask for every tip and builds full position arrays; only afterward does [src/store/gc.ts:418](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:418) batch-copy the already-materialized `live` array.

Scenario — A repository with millions of objects and thousands of distinct branch tips allocates one growing multi-thousand-bit BigInt per shared object and performs a tips-by-objects scan. A single scheduled pass can exhaust memory or CPU before reaching the TEMP table.

Fix — Keep traversal state in the TEMP table, build/serialize one tip bitmap at a time, and decouple correctness-critical GC liveness from optional epoch production. Until then, impose a loud epoch budget and fall back to bounded GC.

### high — Projection construction can crash or OOM after the ref was already accepted

Evidence — [src/object/tree-diff.ts:53](/Users/alizain/ContextLayer/pggit/src/object/tree-diff.ts:53), [src/object/tree-diff.ts:93](/Users/alizain/ContextLayer/pggit/src/object/tree-diff.ts:93), and [src/object/tree-diff.ts:100](/Users/alizain/ContextLayer/pggit/src/object/tree-diff.ts:100) spread repository-sized arrays into `push`; [src/repo-view/repo-file-projection.ts:178](/Users/alizain/ContextLayer/pggit/src/repo-view/repo-file-projection.ts:178) maps every file into another row graph; [src/database/copy-insert.ts:74](/Users/alizain/ContextLayer/pggit/src/database/copy-insert.ts:74) buffers the entire COPY payload.

Scenario — A valid subtree with roughly 125,000 files can exceed V8’s argument-count limit and throw `RangeError`; larger initial projections retain file entries, rows, field buffers, and the final COPY buffer simultaneously. The ref is already durable, so the projection remains stale after the logged failure.

Fix — Replace spreads with loops/iterators and make tree traversal, projection planning, and COPY an async batched pipeline with backpressure.

### high — The text-keyed projection cannot represent Git’s valid path domain

Evidence — [src/object/derive.ts:77](/Users/alizain/ContextLayer/pggit/src/object/derive.ts:77) deliberately rejects non-UTF-8 tree names; [src/database/migrations/0002_repo_file.ts:27](/Users/alizain/ContextLayer/pggit/src/database/migrations/0002_repo_file.ts:27) stores full paths in a B-tree primary key; [src/database/migrations/0006_repo_file_path_pattern.ts:21](/Users/alizain/ContextLayer/pggit/src/database/migrations/0006_repo_file_path_pattern.ts:21) creates another full-path B-tree index; projection failures are absorbed at [src/protocol/receive-pack.ts:294](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:294).

Scenario — A canonical Git repository containing a raw non-UTF-8 filename is rejected at ingest. Conversely, a valid UTF-8 nested path of roughly 3 KiB is accepted and its ref committed, but exceeds PostgreSQL’s default B-tree tuple limit during post-CAS projection, leaving the SQL view empty or stale indefinitely.

Fix — Keep Git paths as raw bytes in the canonical layer, encode only at presentation boundaries, and key the projection with fixed-width branch/path digests plus collision-safe equality rather than full path text.

### med — Connectivity verifies referenced OID existence, not the required object type

Evidence — [src/store/reachability.ts:217](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:217) marks an object present based on its actual type and descends only when that type is TREE; it never checks the type required by the incoming edge. [src/object/tree-diff.ts:36](/Users/alizain/ContextLayer/pggit/src/object/tree-diff.ts:36) similarly discards the reader’s returned type.

Scenario — On a first push, a commit’s `tree` header can point to a blob, a parent can point to a blob, or a `40000` entry can target a blob. All named OIDs exist, so connectivity succeeds and the branch advances, but clone/checkout cannot interpret the graph.

Fix — Validate typed edges before CAS: commit tree→tree, parent→commit, tree modes→their permitted target types, and annotated-tag declared type→actual type.

### med — Malformed tree names and duplicates silently collapse in the projection

Evidence — [src/object/object.ts:40](/Users/alizain/ContextLayer/pggit/src/object/object.ts:40) checks separators and trailing OID length before blindly executing `entries.push(...)`; [src/object/derive.ts:85](/Users/alizain/ContextLayer/pggit/src/object/derive.ts:85) adds only UTF-8 validation; [src/database/copy-insert.ts:150](/Users/alizain/ContextLayer/pggit/src/database/copy-insert.ts:150) uses `on conflict do nothing`.

Scenario — A root blob named `a/b` and subtree `a` containing blob `b` both flatten to `a/b`; duplicate entries behave similarly. One row is silently dropped. Unsorted, empty, slash-containing, and duplicate components that canonical tree validation rejects are all accepted.

Fix — Validate allowed names, canonical modes, Git’s raw-byte tree ordering, and strict uniqueness during ingest; make projection collisions loud as a backstop.

### med — Three optimistic retries can permanently leave the projection behind the ref

Evidence — [src/repo-view/repo-file-projection.ts:87](/Users/alizain/ContextLayer/pggit/src/repo-view/repo-file-projection.ts:87) limits retries to three; [src/repo-view/repo-file-projection.ts:103](/Users/alizain/ContextLayer/pggit/src/repo-view/repo-file-projection.ts:103) returns `"stale"` when the basis moved; [src/repo-view/repo-file-projection.ts:140](/Users/alizain/ContextLayer/pggit/src/repo-view/repo-file-projection.ts:140) then throws.

Scenario — During advances A→B→C→D→E, E’s slow planner can have its basis moved by B, C, and D on its three attempts. E then throws; ref E remains durable, projection D remains durable, and no later activity repairs it.

Fix — Persist/coalesce projection work for the current ref tip and reconcile until stable; an arbitrary request-local retry count cannot be the correctness boundary.

### med — GC can publish a partial epoch that converts detectable corruption into a successful short serve

Evidence — [src/store/gc.ts:306](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:306) builds the epoch from `walk.masks`; [src/store/gc.ts:319](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:319) excludes a tip only when the tip itself is missing; [src/store/reachability.ts:748](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:748) later returns the bitmap result with `missing: new Set()`.

Scenario — A tip exists but a descendant was deleted by the GC/push race or other corruption. A normal walk reports the missing descendant, but GC writes a partial bitmap for the still-present tip. Subsequent no-have fetches use the epoch and claim no objects are missing, returning a short pack instead of failing loudly.

Fix — Never write or serve an epoch when `walk.missing` is non-empty; invalidate the epoch and fail the GC pass loudly.

### med — The v2 parser ignores terminal framing and validates wants differently from haves

Evidence — [src/protocol/v2.ts:36](/Users/alizain/ContextLayer/pggit/src/protocol/v2.ts:36) checks only leftover bytes; [src/protocol/v2.ts:50](/Users/alizain/ContextLayer/pggit/src/protocol/v2.ts:50) silently ignores flush/response-end packets; [src/protocol/v2.ts:101](/Users/alizain/ContextLayer/pggit/src/protocol/v2.ts:101) validates wants, while [src/protocol/v2.ts:112](/Users/alizain/ContextLayer/pggit/src/protocol/v2.ts:112) blindly appends haves. [src/oid.ts:14](/Users/alizain/ContextLayer/pggit/src/oid.ts:14) accepts lowercase only.

Scenario — A request with no terminal `0000`, duplicate delimiters, or data after an earlier flush is executed. `have zzz` becomes a short/empty `bytea` and silently triggers over-serving, while a valid uppercase 40-hex want is rejected.

Fix — Implement an explicit request-state machine and use one case-insensitive, normalize-to-lowercase OID parser for both wants and haves.

### med — Zero-command and malformed pushes mutate persistent repository state

Evidence — [src/protocol/receive-pack.ts:74](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:74) treats an empty body as a no-op; [src/protocol/receive-pack.ts:195](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:195) makes `commands=[]` applicable; [src/store/refs-store.ts:220](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:220) creates the repo and HEAD before inspecting command count; [src/store/object-store.ts:378](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:378) creates the repo before validating the pack.

Scenario — An empty POST creates permanent `repos` and `HEAD` rows. `0000` followed by a valid PACK persists arbitrary unreachable objects with no ref command. A malformed pack leaves a repository row behind before unpack fails.

Fix — Return before any store call for an empty command set, reject pack bytes without commands, and parse against a nullable existing-repo lookup before committing repository creation.

### med — Receive-pack fans command lists into unbounded concurrent database work

Evidence — [src/protocol/receive-pack.ts:221](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:221) performs an unbounded connectivity `Promise.all`; [src/protocol/receive-pack.ts:234](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:234) performs another for ancestry; [src/index.ts:146](/Users/alizain/ContextLayer/pggit/src/index.ts:146) reloads every ref for each connectivity check.

Scenario — A large valid command list immediately allocates all promises and queues one complete ref scan plus graph walk per command against the bounded pool.

Fix — Capture pre-push tips once, batch graph checks through a bounded worker pool, and cap command count at the wire boundary.

### med — Post-commit activity signalling can be lost after durable mutations

Evidence — [src/store/object-store.ts:539](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:539) commits object rows before the separate [src/store/object-store.ts:585](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:585) watermark update; ref mutations similarly swallow stamp errors at [src/store/refs-store.ts:250](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:250) and [src/store/refs-store.ts:283](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:283).

Scenario — Object insertion commits, then the watermark update times out. Receive-pack reports an unpack failure and applies no ref, but the orphan objects remain. If the repository was previously caught up, no durable signal makes the scheduler revisit it. Direct ref-store deletes/non-fast-forwards have the analogous silent stamp-loss path.

Fix — Mutate a monotonic dirty generation/outbox transactionally with objects and refs, and have GC atomically acknowledge generations rather than relying on a fallible post-commit timestamp.

### med — Public ref APIs can persist empty or short OIDs

Evidence — [src/store/refs-store.ts:12](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:12) exposes OIDs as plain strings; [src/store/refs-store.ts:18](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:18) uses `Buffer.from(hex, "hex")`; [src/store/refs-store.ts:318](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:318) performs no validation; [src/database/migrations/0001_init.ts:79](/Users/alizain/ContextLayer/pggit/src/database/migrations/0001_init.ts:79) has no 20-byte constraint on `git_ref.oid` or `peeled_oid`.

Scenario — `setRef(repo, name, "gg")` converts to an empty buffer and persists it. A later advertisement contains an invalid OID and poisons the repository’s wire state.

Fix — Require validated/branded OIDs at every mutating store boundary and add database checks enforcing 20-byte `oid`/`peeled_oid` values.

### med — Valid 64-bit commit timestamps are rounded through JavaScript numbers

Evidence — [src/object/object.ts:97](/Users/alizain/ContextLayer/pggit/src/object/object.ts:97) returns `Number.parseInt(epoch, 10)`; [src/store/reachability.ts:55](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:55) converts database bigint text with `Number(r.time)`; [src/store/reachability.ts:442](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:442) compares timestamps by subtraction.

Scenario — Git accepts timestamp `9007199254740993`, but it is stored and compared as `9007199254740992`. Derived commit data is wrong, and distinct timestamps can collapse in frontier ordering.

Fix — Carry timestamps as `bigint` or canonical decimal strings through parsing, database binding, reading, and comparison.

### med — Migration 0009’s write batching does not bound backfill memory

Evidence — [src/database/migrations/0009_commit_tag.ts:119](/Users/alizain/ContextLayer/pggit/src/database/migrations/0009_commit_tag.ts:119) selects every commit body for a repository; [src/database/migrations/0009_commit_tag.ts:123](/Users/alizain/ContextLayer/pggit/src/database/migrations/0009_commit_tag.ts:123) creates a second derived array; [src/database/migrations/0009_commit_tag.ts:127](/Users/alizain/ContextLayer/pggit/src/database/migrations/0009_commit_tag.ts:127) constructs whole-graph maps before write batching begins.

Scenario — Upgrading a repository with millions of commits retains all bodies, derived records, parent arrays, and graph maps simultaneously and can OOM before its first batched insert.

Fix — Keyset/cursor-stream bodies into staging and compute generations from compact persisted state or bounded topological passes.

### low — Receive-pack emits report-status without negotiation

Evidence — [src/protocol/receive-pack.ts:184](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:184) reads `side-band-64k` and `atomic` but not `report-status`; every exit, including [src/protocol/receive-pack.ts:303](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:303), calls `encodeReportStatus(...)`.

Scenario — A client declines `report-status`, sends a valid update, and receives an unsolicited status stream that canonical receive-pack would omit.

Fix — Gate status encoding on the negotiated capability and return an empty response body when it is absent.

### low — Enabled instrumentation retains every request forever

Evidence — [src/instrument.ts:33](/Users/alizain/ContextLayer/pggit/src/instrument.ts:33) defines module-global `const collected: Collector[] = []`; [src/instrument.ts:66](/Users/alizain/ContextLayer/pggit/src/instrument.ts:66) executes `collected.push(collector)` for every request; [src/index.ts:174](/Users/alizain/ContextLayer/pggit/src/index.ts:174) exposes `{ instrument: true }` publicly.

Scenario — A long-running server with instrumentation enabled retains every request, phase map, counter map, and recorded SQL string. Package consumers cannot access the source-only reset/read helpers through the package entrypoint.

Fix — Require an explicit sink, use a bounded ring buffer, or remove the option from the production API.

### low — Repack and snapshot-rebuild structures have no production consumer

Evidence — [src/store/repack.ts:15](/Users/alizain/ContextLayer/pggit/src/store/repack.ts:15) claims repack is `invoked per repo by the background drain`, but [src/gc-scheduler.ts:53](/Users/alizain/ContextLayer/pggit/src/gc-scheduler.ts:53) constructs only `createGc(pg)`. [src/repo-view/rebuild.ts:60](/Users/alizain/ContextLayer/pggit/src/repo-view/rebuild.ts:60) exports `rebuildAllSnapshots`, but exhaustive non-test reference search finds no caller or package re-export.

Scenario — The implemented pack-encoding producer is never run by production code, while the documented projection recovery operation is unreachable to package consumers. The associated branches, tables, and contracts are test-only/speculative surface.

Fix — Wire and export these operations deliberately, or delete the unused implementation and dependent structure.

## Plausible

### high — Concurrent administrative deletion can ACK a recreated ref whose objects were deleted

Evidence — [src/store/repo-admin.ts:31](/Users/alizain/ContextLayer/pggit/src/store/repo-admin.ts:31) says `quiescing writers is the caller's contract, not enforced here`; [src/store/refs-store.ts:155](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:155) creates refs without an object FK.

Scenario — Connectivity succeeds against repository X; `deleteRepo` cascades X’s objects and invalidates its ID; ref application then creates repository Y and inserts the ref into Y, pointing at the objects deleted with X.

Fix — Enforce the lifecycle contract with the same per-repository lock across the whole receive request and deletion. Marked plausible because concurrent writers are explicitly documented as out of contract.

### med — A delayed delete callback can erase a concurrently recreated branch projection

Evidence — [src/repo-view/rebuild.ts:35](/Users/alizain/ContextLayer/pggit/src/repo-view/rebuild.ts:35) directly calls `dropRefSnapshot`; [src/repo-view/repo-file-projection.ts:157](/Users/alizain/ContextLayer/pggit/src/repo-view/repo-file-projection.ts:157) unconditionally deletes rows and the head without the branch advisory lock or a current-ref check.

Scenario — A branch deletion commits, the same name is recreated and projected, then the delayed deletion callback removes the new projection. No later push repairs it.

Fix — Take the branch lock and verify the ref remains absent under that lock before deletion. Marked plausible because wire deletions are currently denied, limiting exposure to internal lifecycle callers.

### med — One indefinitely blocked GC query wedges the entire scheduler and shutdown

Evidence — [src/gc-scheduler.ts:85](/Users/alizain/ContextLayer/pggit/src/gc-scheduler.ts:85) awaits one repository’s GC without cancellation; [src/gc-scheduler.ts:117](/Users/alizain/ContextLayer/pggit/src/gc-scheduler.ts:117) skips every tick while `inFlight` exists; [src/gc-scheduler.ts:137](/Users/alizain/ContextLayer/pggit/src/gc-scheduler.ts:137) waits for it during shutdown.

Scenario — One indefinite lock wait or stalled connection prevents GC of every other repository and makes `stop()` hang forever.

Fix — Apply per-repository statement/lock timeouts and cancellation so the scheduler’s existing failure isolation can run.

### low — The startup error listener can silently consume the first runtime server error

Evidence — [src/server.ts:20](/Users/alizain/ContextLayer/pggit/src/server.ts:20) attaches both `server.once("listening", ...)` and `server.once("error", reject)` but never removes the losing listener.

Scenario — After startup resolves, the first later server-level error calls `reject` on an already-settled Promise, satisfying the EventEmitter error listener without producing a rejection or log.

Fix — Remove the error listener when listening succeeds, remove the listening listener on startup failure, and install an explicit runtime error policy.


## Appendix B — raw tests-chunk report

## Confirmed

### CRITICAL — Signal-killed Git oracles are reported as successful

**Evidence:** [src/testing/spawn-git.ts:109-118](/Users/alizain/ContextLayer/pggit/src/testing/spawn-git.ts:109) uses `const code = rawCode ?? 0`.

**Why it lies:** Node reports `rawCode === null` when a child dies by signal. A killed `git fsck`, `index-pack`, clone, or push therefore resolves as exit 0, potentially with incomplete output.

**Minimal strengthening:** Preserve the close signal, reject null exit codes, and add a helper test whose child self-terminates.

### CRITICAL — Packet-oracle helpers accept truncated response suffixes

**Evidence:** [src/testing/pkt-oracle.ts:35-53](/Users/alizain/ContextLayer/pggit/src/testing/pkt-oracle.ts:35) iterates only `decodePktStream(buf).packets`; the same pattern appears at lines 67 and 111.

**Why it lies:** `decodePktStream` also returns undecoded `rest`. A valid response followed by a truncated pkt-line or garbage renders identically to the valid response, so wire goldens can pass malformed output.

**Minimal strengthening:** Require `rest.length === 0` in every complete-stream oracle and add valid-prefix-plus-truncated-suffix negatives.

### CRITICAL — An active conformance test deliberately enforces behavior its canonical sibling calls buggy

**Evidence:** [src/e2e/fetch-multiround.spec.test.ts:87-94](/Users/alizain/ContextLayer/pggit/src/e2e/fetch-multiround.spec.test.ts:87) asserts `not.toContain("packfile")`. [src/e2e/fetch-ready-sibling.skip.test.ts:30-33](/Users/alizain/ContextLayer/pggit/src/e2e/fetch-ready-sibling.skip.test.ts:30) says that test “currently enshrines the BUGGY behavior”; the canonical `ready + packfile` case is skipped at [lines 110-115](/Users/alizain/ContextLayer/pggit/src/e2e/fetch-ready-sibling.skip.test.ts:110).

**Why it lies:** The green test defines a known Git divergence as the contract while the real-Git regression is disabled.

**Minimal strengthening:** Reverse the active expectation to canonical `ready + packfile`, unskip the sibling regression, and retain a genuinely unrelated-have case for the no-pack response.

### CRITICAL — The exact-OID want router can reject every valid request without failing the perf differential

**Evidence:** [perf/breakage/realrepo--differential.ts:610-628](/Users/alizain/ContextLayer/pggit/perf/breakage/realrepo--differential.ts:610) does `if (!f.ok) { oidRejected++; ... continue }`; canonical `file://` fetch runs only after pggit succeeds.

**Why it lies:** Deleting or breaking historical exact-OID routing merely increases a reported rejection count; the harness still exits successfully.

**Minimal strengthening:** Always run both remotes and compare outcomes. Require pggit success whenever canonical Git accepts the OID, then compare resulting object sets.

### CRITICAL — Fault-injection suites do not prove that a fault occurred

**Evidence:** [src/e2e/breakage/pg-txn--ingest-fault-sweep.test.ts:243-261](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/pg-txn--ingest-fault-sweep.test.ts:243) breaks from polling after `pg_cancel_backend` but has no observed/cancelled guard, and maps a successful first push to `refsAfterFailedPush = []`. [src/e2e/breakage/pg-txn--txn-death-kills-host-process.test.ts:115-125](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/pg-txn--txn-death-kills-host-process.test.ts:115) prints `CHILD never saw the fault point` and exits normally. [src/e2e/breakage/pg-txn--post-cas-failure-tears-push.test.ts:239-255](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/pg-txn--post-cas-failure-tears-push.test.ts:239) records a successful push and `continue`s. [perf/breakage/txn--interrupted-repack-cost.ts:102-107](/Users/alizain/ContextLayer/pggit/perf/breakage/txn--interrupted-repack-cost.ts:102) catches any exception and also accepts successful completion.

**Why it lies:** Renaming/removing a target statement—or merely losing the timing race—makes these suites greener. Unrelated exceptions are also accepted as the intended crash.

**Minimal strengthening:** Add a per-case `faultObserved` barrier, require `pg_cancel_backend`/termination to report success, require the first operation to fail with the exact injected error, and fail if injection never fires.

### HIGH — A perf gate crashes before reaching its threshold

**Evidence:** [perf/breakage/pg-bloat--encoding-tier-vs-git-pack.ts:287-291](/Users/alizain/ContextLayer/pggit/perf/breakage/pg-bloat--encoding-tier-vs-git-pack.ts:287) reads `edge.total`, but no `edge` variable exists.

**Why it lies:** Every successful run throws `ReferenceError` before `if (ratio > TIER_LIMIT)`, so the intended gate cannot produce a verdict.

**Minimal strengthening:** Use the declared topology measurement and include all perf entry points in a typechecked configuration.

### HIGH — The capability golden is deterministically stale

**Evidence:** [src/protocol/upload-pack-wire.spec.test.ts:34-45](/Users/alizain/ContextLayer/pggit/src/protocol/upload-pack-wire.spec.test.ts:34) expects exactly `fetch=filter include-tag`; [src/protocol/v2.ts:19](/Users/alizain/ContextLayer/pggit/src/protocol/v2.ts:19) advertises `fetch=filter include-tag thin-pack`.

**Why it lies:** The golden now fails for the implemented, intended capability and rewards deleting `thin-pack`.

**Minimal strengthening:** Add `thin-pack` to the canonical advert and explicitly test its semantics rather than only its spelling.

### HIGH — Thin-pack negotiation can be deleted while semantic tests remain green

**Evidence:** [src/testing/wire-fetch.ts:14-20](/Users/alizain/ContextLayer/pggit/src/testing/wire-fetch.ts:14) has no `thinPack` option. [src/e2e/thin-pack-serve.test.ts:123-147](/Users/alizain/ContextLayer/pggit/src/e2e/thin-pack-serve.test.ts:123) calls `buildPack(..., true/false)` directly. The real-client case at [lines 156-180](/Users/alizain/ContextLayer/pggit/src/e2e/thin-pack-serve.test.ts:156) asserts only `expect(fetched.sort()).toEqual(expected.sort())`.

**Why it lies:** Removing advertisement, parsing, or transport propagation makes Git receive a self-contained pack with the same final objects. Direct store calls still force the boolean.

**Minimal strengthening:** Issue raw v2 requests with and without `thin-pack`, demux the actual response, prove an external `REF_DELTA` exists only in the negotiated response, and run that exact pack through `git index-pack --fix-thin`.

### HIGH — The claimed warm-delta fixture is satisfied by stored-delta serving

**Evidence:** [src/e2e/thin-pack-serve.test.ts:60-64](/Users/alizain/ContextLayer/pggit/src/e2e/thin-pack-serve.test.ts:60) repacks after both tips exist, yet [lines 133-136](/Users/alizain/ContextLayer/pggit/src/e2e/thin-pack-serve.test.ts:133) concludes “the new wide root tree rode a warm delta.” Stored deltas have priority at [src/store/object-store.ts:181-196](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:181).

**Why it lies:** The changed wide tree can already have a stored delta against the old tree. `indexedCount > headerCount` proves only an external base, not warm computation; deleting warm-delta generation leaves the assertion satisfied.

**Minimal strengthening:** Repack after only `oldTip`, push `newTip` afterward, assert the new tree has no encoding row, then require an external-base delta. Keep stored-delta serving as a separate case.

### HIGH — Epoch/bitmap correctness is pggit compared with pggit

**Evidence:** [src/e2e/reach-epoch-producer.test.ts:74-91](/Users/alizain/ContextLayer/pggit/src/e2e/reach-epoch-producer.test.ts:74) calls `fullClosure` its “exactness oracle.” [src/e2e/bitmap-serve.test.ts:112-118](/Users/alizain/ContextLayer/pggit/src/e2e/bitmap-serve.test.ts:112) compares a pre-drain pggit clone with a post-drain pggit clone. [perf/breakage/perf--bitmap-clone-queries.ts:113-118](/Users/alizain/ContextLayer/pggit/perf/breakage/perf--bitmap-clone-queries.ts:113) likewise compares walk-served pggit with bitmap-served pggit.

**Why it lies:** Shared traversal, type, ref, or omission defects self-confirm. The e2e assertions also do not distinguish bitmap service from fallback; the perf query gate catches only a gross pure-clone routing regression.

**Minimal strengthening:** Derive per-ref expected closures and ref maps from canonical Git, include unreachable stored objects to expose over-serving, and assert route/fallback telemetry independently.

### HIGH — Partial-clone tests never require objects to be omitted

**Evidence:** [src/e2e/bitmap-serve.test.ts:182-195](/Users/alizain/ContextLayer/pggit/src/e2e/bitmap-serve.test.ts:182) claims a “strict subset” but only checks `filtered.every((o) => full.includes(o))`. [src/e2e/transport-filter-tree0.test.ts:65-87](/Users/alizain/ContextLayer/pggit/src/e2e/transport-filter-tree0.test.ts:65) checks only clone success and tip presence. [src/e2e/breakage/wire--partial-clone-blobless.test.ts:132-137](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/wire--partial-clone-blobless.test.ts:132) computes `localBlobs`, but [lines 203-229](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/wire--partial-clone-blobless.test.ts:203) uses the counts only in messages.

**Why it lies:** A server that ignores `blob:none` or `tree:0` and sends the full repository passes every cited assertion.

**Minimal strengthening:** Compare the pre-checkout OID/type inventory with canonical filtered Git and require a guarded strict subset with the fixture’s blobs/trees absent.

### HIGH — Idempotence tests validate only the second no-op, not the first operation

**Evidence:** [src/generative/gc.spec.test.ts:375-386](/Users/alizain/ContextLayer/pggit/src/generative/gc.spec.test.ts:375) discards the first GC result and takes `afterFirst` as truth; [src/generative/gc-stress.spec.test.ts:489-500](/Users/alizain/ContextLayer/pggit/src/generative/gc-stress.spec.test.ts:489) repeats the pattern. [src/e2e/breakage/lifecycle--incremental-repack-idempotence.test.ts:173-178](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/lifecycle--incremental-repack-idempotence.test.ts:173) discards the first repack and records only `second`.

**Why it lies:** Permanently no-op GC/repack implementations pass: the second call is also a no-op, while raw objects keep clones working.

**Minimal strengthening:** Require positive, independently expected first-pass work and canonical post-first-pass state, then assert the second pass is unchanged.

### HIGH — Race tests neither require participant success nor establish overlap

**Evidence:** [src/e2e/breakage/race--concurrent-gc.test.ts:143-157](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/race--concurrent-gc.test.ts:143) catches GC errors into `errs`, which are only printed at [lines 179-182](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/race--concurrent-gc.test.ts:179). [src/e2e/breakage/txn--garbage-race-and-storage.test.ts:84-87](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/txn--garbage-race-and-storage.test.ts:84) uses `Promise.allSettled`; outcomes become diagnostic `notes`. [src/e2e/breakage/race--push-gc-repack.test.ts:223-247](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/race--push-gc-repack.test.ts:223) checks the core pushed-tip property only inside `if (pushErr === undefined)`. [perf/breakage/realrepo--drain-races.ts:148-159](/Users/alizain/ContextLayer/pggit/perf/breakage/realrepo--drain-races.ts:148) merely starts repack and clone promises together.

**Why it lies:** All mutating actors can reject before changing state, leaving a clean original repository. Promise co-start does not prove either operation entered the intended critical window.

**Minimal strengthening:** Use explicit barriers at the relevant snapshot/write seam, assert each barrier was reached, and define required success or narrowly permitted conflict outcomes for every actor.

### HIGH — The short-pack race targets a removed architecture and accepts most failures

**Evidence:** [src/e2e/breakage/race--short-pack-closure-truncation.test.ts:5-20](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/race--short-pack-closure-truncation.test.ts:5) describes a recursive CTE followed by a second tree query, while current reachability is a different walk. GC and resurrection errors are swallowed at [lines 187-205](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/race--short-pack-closure-truncation.test.ts:187), and [lines 228-233](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/race--short-pack-closure-truncation.test.ts:228) fail only `SHORTPACK` or `CORRUPT`.

**Why it lies:** No-op/failing GC, no resurrection, HTTP 500, protocol errors, and other failures all pass a test aimed at a data race that no longer has the documented seam.

**Minimal strengthening:** Rebuild the test around current walk/load seams, require GC deletion and resurrection activity, and accept only a canonical complete response or an explicitly specified clean refusal.

### HIGH — Client-rewritten packfiles are treated as raw wire evidence

**Evidence:** [src/e2e/fetch-negotiation.test.ts:82-90](/Users/alizain/ContextLayer/pggit/src/e2e/fetch-negotiation.test.ts:82) inspects a stored pack and removes every pre-existing OID before comparing. [perf/breakage/_realrepo-util.ts:123-131](/Users/alizain/ContextLayer/pggit/perf/breakage/_realrepo-util.ts:123) claims client packfiles are “exactly what the remote put on the wire”; incremental perf gates derive transfer bytes from those files.

**Why it lies:** `index-pack --fix-thin` adds external bases before storing a fetched pack. Filtering every existing OID also hides arbitrary over-sending of old history.

**Minimal strengthening:** Capture and depacketize the HTTP response itself. Parse the original thin pack, distinguish omitted external bases from transmitted objects, and compare exact wire OIDs/bytes.

### HIGH — Delta assertions routinely pass on zero delta cases

**Evidence:** [src/e2e/breakage/wire--delta-before-base-ordering.test.ts:218-226](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/wire--delta-before-base-ordering.test.ts:218) does `if (pggitOrder.deltas === 0) return`. [src/e2e/breakage/shapes--negative-sweep.test.ts:969-975](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/shapes--negative-sweep.test.ts:969) says delta-path proof is “Recorded, not asserted.” [perf/delta-corpus.ts:215-220](/Users/alizain/ContextLayer/pggit/perf/delta-corpus.ts:215) silently stores whole when no pair exists, while [lines 328-333](/Users/alizain/ContextLayer/pggit/perf/delta-corpus.ts:328) gates only failure arrays. [perf/breakage/txn--holes-never-redeltify.ts:104-119](/Users/alizain/ContextLayer/pggit/perf/breakage/txn--holes-never-redeltify.ts:104) never requires a nonempty lineage or a delta.

**Why it lies:** Deleting delta production/serving, breaking the pair parser, or choosing an unsuitable fixture yields zero exercised cases and a green result.

**Minimal strengthening:** Designate delta-required fixtures and require nonzero eligible, encoded, transmitted, and parsed delta counts before checking their properties.

### HIGH — Several perf gates encode missing data as the best score

**Evidence:** [perf/breakage/pg-bloat--force-push-churn.ts:378-385](/Users/alizain/ContextLayer/pggit/perf/breakage/pg-bloat--force-push-churn.ts:378) gates bloat only when `sameContent` is true. [perf/breakage/realrepo--serve-size-vs-git.ts:95-109](/Users/alizain/ContextLayer/pggit/perf/breakage/realrepo--serve-size-vs-git.ts:95) compares sizes after fsck but never compares refs/OIDs. [perf/breakage/perf--blob-delta-gap.ts:147-150](/Users/alizain/ContextLayer/pggit/perf/breakage/perf--blob-delta-gap.ts:147) defaults missing `packBytes` instrumentation to zero. [perf/breakage/perf--gc-encoding-sweep.ts:53-61](/Users/alizain/ContextLayer/pggit/perf/breakage/perf--gc-encoding-sweep.ts:53) records encoding count, but [lines 115-120](/Users/alizain/ContextLayer/pggit/perf/breakage/perf--gc-encoding-sweep.ts:115) gates timing only.

**Why it lies:** Missing rows, missing refs, missing instrumentation, or a deleted encoding producer reduce or skip the metric and therefore improve the verdict.

**Minimal strengthening:** Fail prerequisite correctness first: exact canonical refs/OIDs/live-row counts, required nonzero counters, and complete encoding coverage. Score performance only afterward.

### HIGH — Named fallback and large-program fixtures do not establish their named preconditions

**Evidence:** [src/e2e/breakage/pg-corrupt--big-bytea-encoding-serve.test.ts:112-115](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/pg-corrupt--big-bytea-encoding-serve.test.ts:112) accepts `NO encoding row ... raw path only`, but [lines 147-154](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/pg-corrupt--big-bytea-encoding-serve.test.ts:147) claims the second clone uses the encoding row. [src/e2e/breakage/wire--force-push-gc-repack.test.ts:157-159](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/wire--force-push-gc-repack.test.ts:157) only comments that the kept tree’s anchor is unreachable. [src/e2e/breakage/wire--large-trees-and-negotiation.test.ts:225-226](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/wire--large-trees-and-negotiation.test.ts:225) proves tree size, not that a delta program contains the claimed large COPY instruction.

**Why it lies:** Raw/whole serving passes tests named for encoded-row selection, missing-base fallback, and large-delta instruction splitting.

**Minimal strengthening:** Query the exact target row and base, prove the base’s canonical reachability status, inspect the delta program, and assert route-specific instrumentation.

### HIGH — The generative merge command suppresses every Git merge failure

**Evidence:** [src/generative/commands.ts:208-213](/Users/alizain/ContextLayer/pggit/src/generative/commands.ts:208) says “Anything else is real — rethrow” but rethrows only when the error is not `GitCommandError`.

**Why it lies:** Every nonzero Git merge is a `GitCommandError`, not only content conflicts. Broken configuration, object corruption, hooks, and command regressions are all treated as expected skips.

**Minimal strengthening:** Suppress only a proven conflict state, such as nonempty `git ls-files -u`; rethrow every other exit.

### HIGH — Several named graph dimensions do not create the advertised graph

**Evidence:** [src/generative/gc-stress.spec.test.ts:270-283](/Users/alizain/ContextLayer/pggit/src/generative/gc-stress.spec.test.ts:270) creates every “wide” ref as `main~${depthBack}`, so `main` already reaches them all. [src/generative/rejection.spec.test.ts:48-67](/Users/alizain/ContextLayer/pggit/src/generative/rejection.spec.test.ts:48) always sends only the tip commit, guaranteeing failure at its immediate tree. [src/e2e/push-merge-graphs.test.ts:131-135](/Users/alizain/ContextLayer/pggit/src/e2e/push-merge-graphs.test.ts:131) performs `x ← y` and then merges updated `x` into `y`, making the second operation a fast-forward rather than a criss-cross.

**Why it lies:** Ignoring non-main refs passes “wide refs”; deep/merge rejection dimensions never reach their intended missing dependency; criss-cross-specific ancestry code is never exercised.

**Minimal strengthening:** Generate divergent exclusive refs and guard each contributes objects, omit a selected deeper dependency while seeding predecessors, and assert `git merge-base --all` returns two bases for the criss-cross fixture.

### MEDIUM — The projection property can execute no transition assertions

**Evidence:** [src/repo-view/projection-differential.test.ts:89-113](/Users/alizain/ContextLayer/pggit/src/repo-view/projection-differential.test.ts:89) catches all operation and commit errors, returning `null`; [lines 147-164](/Users/alizain/ContextLayer/pggit/src/repo-view/projection-differential.test.ts:147) does `if (next === null) continue`.

**Why it lies:** A systemic commit failure can skip every generated transition and every differential assertion.

**Minimal strengthening:** Catch only the verified nothing-to-commit case, require at least one checked transition, and assert the initial projection before generated mutations.

### MEDIUM — Object-store idempotence compares two implementation receipts and can loop over nothing

**Evidence:** [src/store/object-store.test.ts:59-63](/Users/alizain/ContextLayer/pggit/src/store/object-store.test.ts:59) compares `second.oids` with `first.oids`, then iterates `first.oids`.

**Why it lies:** Two empty or identically wrong receipts pass, and the presence loop becomes vacuous.

**Minimal strengthening:** Compute expected Git OIDs independently, require the exact nonempty set, and verify the database row count/content.

### MEDIUM — Wire error tests reject only a narrow symptom, not the stated contract

**Evidence:** [src/e2e/transport-malformed-framing.test.ts:5-8](/Users/alizain/ContextLayer/pggit/src/e2e/transport-malformed-framing.test.ts:5) requires a 4xx and “never ... 200,” but [lines 58-72](/Users/alizain/ContextLayer/pggit/src/e2e/transport-malformed-framing.test.ts:58) asserts only `< 500`. [src/e2e/large-blob.test.ts:189-201](/Users/alizain/ContextLayer/pggit/src/e2e/large-blob.test.ts:189) checks status 200 plus `body.includes("PACK")`, which a zero-object pack satisfies. [src/e2e/fetch-want-ref.test.ts:99-107](/Users/alizain/ContextLayer/pggit/src/e2e/fetch-want-ref.test.ts:99) rejects only `200 + zero objects`, accepting any unrelated nonempty pack.

**Why it lies:** Malformed 2xx responses, empty large-blob fetches, and incorrect nonempty want-ref responses all pass.

**Minimal strengthening:** Assert exact status/protocol error semantics and parse/index each successful pack against the exact canonical closure.

### MEDIUM — Epoch producer tests are an order-dependent state machine split across `it` blocks

**Evidence:** [src/e2e/reach-epoch-producer.test.ts:97-152](/Users/alizain/ContextLayer/pggit/src/e2e/reach-epoch-producer.test.ts:97) expects epoch 1, then mutates the same repo to epoch 2, rewinds it, deletes a ref, and finally empties it across separate tests.

**Why it lies:** Individual execution is invalid, and an early failure cascades into misleading failures whose preconditions were never established.

**Minimal strengthening:** Make this one explicitly staged scenario, or give every case an independent fixture/prestate.

## Plausible

### HIGH — Fast-check scheduler shrinking can inherit failed candidates’ database state

**Evidence:** [src/generative/gc-scheduler.spec.test.ts:232-242](/Users/alizain/ContextLayer/pggit/src/generative/gc-scheduler.spec.test.ts:232) creates one fixture in `beforeAll`; [lines 282-290](/Users/alizain/ContextLayer/pggit/src/generative/gc-scheduler.spec.test.ts:282) expects each `drainOnce()` summary to equal only the current candidate’s touched repos.

**Risk:** If a candidate throws before draining/cleaning its repos, a shrink replay sees leftover eligible repos and produces order-dependent failures or a misleading minimal counterexample.

**Minimal strengthening:** Use a fresh schema per property run or unconditionally delete all candidate repos in `finally`.

### HIGH — The incremental-push property guarantees neither existing-ref CAS nor thin input

**Evidence:** [src/generative/incremental-push.spec.test.ts:55-62](/Users/alizain/ContextLayer/pggit/src/generative/incremental-push.spec.test.ts:55) relies only on `fc.pre(model.commitCount > baseCommitCount)` while claiming existing branches advance and “the pack is THIN.”

**Risk:** Generated commands can advance only a newly created ref, and small/random content may be sent whole. CAS and thin-pack ingest could be deleted without every run noticing.

**Minimal strengthening:** Snapshot initial refs and require at least one existing ref to advance; add a guaranteed large similar object and prove its external base is absent from the incoming pack but present in storage.

### MEDIUM — The grace split is controlled by wall-clock sleep and then masked by zero-grace cleanup

**Evidence:** [src/e2e/breakage/lifecycle--exotic-fetch-and-grace-split.test.ts:255-270](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/lifecycle--exotic-fetch-and-grace-split.test.ts:255) sleeps 2500 ms, uses a two-second grace, then immediately runs a zero-grace GC.

**Risk:** Under contention, “new” objects may already exceed grace; conversely, a no-op first GC is hidden by the second pass.

**Minimal strengthening:** Control timestamps or inject a clock, and assert the exact old objects deleted and exact new garbage retained after the first pass.

### MEDIUM — The gzip test never observes gzip

**Evidence:** [src/e2e/breakage/wire--exact-oid-and-gzip.test.ts:173-174](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/wire--exact-oid-and-gzip.test.ts:173) says Git “gzips a request body this long,” while [lines 260-266](/Users/alizain/ContextLayer/pggit/src/e2e/breakage/wire--exact-oid-and-gzip.test.ts:260) asserts only success and matching digest.

**Risk:** If Git stops compressing this fixture—or gzip decoding is deleted—the test remains green.

**Minimal strengthening:** Capture the request and require `Content-Encoding: gzip` plus a genuinely compressed body before asserting behavior.

### MEDIUM — Main-thread memory sampling can miss the synchronous allocation named by the gate

**Evidence:** [perf/breakage/perf--concurrent-clone-memory.ts:106-115](/Users/alizain/ContextLayer/pggit/perf/breakage/perf--concurrent-clone-memory.ts:106) samples RSS with `setInterval(..., 25)` on the same event loop as synchronous pack materialization.

**Risk:** The event loop cannot run the sampler during the allocation peak; the allocation can be released before the next tick.

**Minimal strengthening:** Use the existing off-thread sampler from `perf/memory.ts` or OS-level process sampling.

## Coverage gaps

### HIGH — Concurrent epoch publication and mixed-generation reads are untested

**Evidence (confirmed gap):** Bitmap tests serialize drain and fetch at [src/e2e/bitmap-serve.test.ts:112-118](/Users/alizain/ContextLayer/pggit/src/e2e/bitmap-serve.test.ts:112). The only GC concurrency seam at [src/e2e/gc-isolation-concurrency.test.ts:146-158](/Users/alizain/ContextLayer/pggit/src/e2e/gc-isolation-concurrency.test.ts:146) runs one GC plus a push, not two producers. Epoch replacement deletes/inserts without an epoch CAS at [src/store/reach-epoch.ts:89-104](/Users/alizain/ContextLayer/pggit/src/store/reach-epoch.ts:89), while `loadEpoch` reads metadata and bitmap rows in separate statements at [lines 47-64](/Users/alizain/ContextLayer/pggit/src/store/reach-epoch.ts:47).

**Missing cases:** Two GC passes planned from different ref snapshots; last-writer staleness; replacement between metadata and bitmap reads; one missing bitmap row during serve.

**Minimal strengthening:** Add deterministic barriers around live-set capture, epoch publication, and the two load statements; require the final epoch and every served pack to match canonical Git.

### HIGH — `boundaryHits` and positive `boundaryExact` behavior are not asserted

**Evidence (confirmed gap):** [src/e2e/bitmap-serve.test.ts:152-172](/Users/alizain/ContextLayer/pggit/src/e2e/bitmap-serve.test.ts:152) says `boundaryExact goes false` but observes only the final OID set. No test asserts either field returned at [src/store/reachability.ts:693-708](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:693).

**Missing cases:** Exact descendant boundary hit; fork meeting below a boundary; two haves with one exact hit and one inexact meet; duplicate haves/wants preserving provenance.

**Minimal strengthening:** Table-drive `frontier` and assert both fields as well as the canonical served set. Also assert route telemetry so “always false, always fall back” fails.

### HIGH — Chained-tag epoch subtraction and bitmap `include-tag` are absent

**Evidence (confirmed gap):** The epoch producer creates one ordinary annotated tag at [src/e2e/reach-epoch-producer.test.ts:52-58](/Users/alizain/ContextLayer/pggit/src/e2e/reach-epoch-producer.test.ts:52). Deep tag chains at [src/e2e/refs-peeling.spec.test.ts:38-53](/Users/alizain/ContextLayer/pggit/src/e2e/refs-peeling.spec.test.ts:38) test only peeling. Include-tag tests at [src/e2e/fetch-include-tag.spec.test.ts:72-76](/Users/alizain/ContextLayer/pggit/src/e2e/fetch-include-tag.spec.test.ts:72) do not build an epoch, while bitmap single-ref fetches explicitly use `--no-tags` at [src/e2e/bitmap-serve.test.ts:96-100](/Users/alizain/ContextLayer/pggit/src/e2e/bitmap-serve.test.ts:96).

**Missing case:** An epoch tip `tag2 → tag1 → commit`, followed by a descendant commit fetch both with and without `include-tag`.

**Minimal strengthening:** Without `include-tag`, require neither tag object; with it, require both transitively, using canonical Git’s exact pack set.

### HIGH — The epoch producer’s ancestor-rewind branch is untested

**Evidence (confirmed gap):** [src/e2e/reach-epoch-producer.test.ts:125-130](/Users/alizain/ContextLayer/pggit/src/e2e/reach-epoch-producer.test.ts:125) explicitly force-pushes an `UNRELATED single-commit history`. The special “tip already inside old epoch array” decision lives at [src/store/gc.ts:295-304](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:295).

**Missing case:** Moving a ref backward to an ancestor already present in `epoch.oids`.

**Minimal strengthening:** Require `epoch: "rebuilt"`, reclamation of former descendants, and canonical equality of the rebuilt bitmaps.

### MEDIUM — Duplicate and mixed wants are absent from bitmap serving

**Evidence (confirmed gap):** Bitmap tests use Git-generated unique wants or the single-ref helper at [src/e2e/bitmap-serve.test.ts:91-106](/Users/alizain/ContextLayer/pggit/src/e2e/bitmap-serve.test.ts:91), while `epochServe` explicitly deduplicates and splits tip/rest wants at [src/store/reachability.ts:738-746](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:738).

**Missing cases:** `[tip, tip]`, `[epochTip, descendant, descendant]`, several epoch tips with shared closure, and partial/missing bitmap rows.

**Minimal strengthening:** Send raw no-have requests for each combination and assert canonical exact sets plus expected fast-path/fallback behavior.

### MEDIUM — The want-type router lacks its haveful and mixed-type matrix

**Evidence (confirmed gap):** [src/e2e/served-set-oracle.test.ts:36](/Users/alizain/ContextLayer/pggit/src/e2e/served-set-oracle.test.ts:36) claims “every (want, have) pair,” but its store-level additions at [lines 243-263](/Users/alizain/ContextLayer/pggit/src/e2e/served-set-oracle.test.ts:243) cover only tag→commit and one exact blob want.

**Missing cases:** Exact tree want with haves; tag→tree and tag→blob; tag haves; ignored tree/blob haves; mixed commit/tree/blob/tag wants; duplicate and multi-want unions.

**Minimal strengthening:** Table-drive the router over those combinations and derive every expected set from canonical Git rather than hand-authored closures.


## Appendix C — raw round-3 report (review of the round-2 fixes)

## Confirmed

1. **CONFIRMED — Critical — typed-edge handling can turn a missing derived row into destructive GC.**

   Evidence — [src/store/reachability.ts:116](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:116) says `if (want === "commit") return true`; callers handle that before [src/store/reachability.ts:252](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:252), `assertDerivedRow(...)`. `originClosure` then executes [src/store/reachability.ts:390](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:390), `masks.delete(oid)`, while GC’s error path still uses [src/store/gc.ts:333](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:333), `live: [...walk.masks.keys()]`.

   Scenario — Commit `C` names parent `P`; `P`’s raw commit object exists but its `git_commit` row is missing. `P` falls through to object metadata, is classified as a typed-edge “missing” object before the loud invariant assertion, and is removed from the live mask. After grace, GC can delete reachable `P` and all history below it instead of aborting on corruption.

2. **CONFIRMED — High — typed-edge validation is path-dependent, admitting malformed pushes and potentially deleting valid objects.**

   Evidence — `originClosure` checks [src/store/reachability.ts:328](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:328), `if (stopAt.has(oid))`, and returns before recording or checking the expectation. Receive connectivity supplies all pre-push tips as that stop-set at [src/index.ts:146](/Users/alizain/ContextLayer/pggit/src/index.ts:146). Independently, `fullClosure` returns on [src/store/reachability.ts:207](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:207), `if (visited.has(oid)) return`, before `expected.set`; `originClosure` similarly records an expectation only when [src/store/reachability.ts:335](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:335), `have === 0n`.

   Scenarios —

   - Existing `refs/tags/treetag` points at tree `T`; a new branch commit contains blob-mode entry `100644 f → T`. Connectivity stops at `T`, reports no missing object, and ACKs the branch. A later cold walk detects the mismatch and refuses that accepted tip.
   - A tree contains `40000 a → T` followed by `100644 b → T`, with `T` actually a tree. The valid first edge records `"tree"` and the invalid blob edge is ignored. Reversing the names records `"blob"` first; GC removes `T` from all masks and can sweep `T` and its descendants despite the valid directory edge.

3. **CONFIRMED — High — both optimized serve routes bypass the new type policy.**

   Evidence — Frontier’s blob probe selects any object without a type predicate at [src/store/reachability.ts:783](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:783), then [src/store/reachability.ts:790](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:790) adds every present OID to `served`. Separately, unchanged tips cause GC to trust the stored epoch verbatim at [src/store/gc.ts:262](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:262), while an exact epoch-tip want returns [src/store/reachability.ts:855](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:855), `missing: new Set()`.

   Scenario — A malformed graph admitted through the preceding bugs, or represented by a pre-7e97b38 epoch, remains serve-authoritative. A haveful fetch treats a tree/commit named by a blob edge as a valid leaf. A no-have exact-tip fetch uses the bitmap without validation. With unchanged tips, subsequent GC never re-walks or invalidates that epoch.

4. **CONFIRMED — High — receive-pack accepts one-level names below `refs/` that canonical Git rejects.**

   Evidence — [src/protocol/receive-pack.ts:158](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:158) only requires `ref.startsWith("refs/")`; no second suffix component is required. Branch typing applies only to [src/protocol/receive-pack.ts:303](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:303), `refs/heads/`. Canonical receive-pack instead validates `name + 5` without `REFNAME_ALLOW_ONELEVEL` for creates/updates. [Git’s implementation shows that distinction directly.](https://github.com/git/git/blob/master/builtin/receive-pack.c#L1401-L1419)

   Scenario — A hostile client creates `refs/heads` pointing at a blob. Pggit accepts both the name and non-commit tip; the persisted ref then D/F-conflicts with every ordinary `refs/heads/*` branch. Canonical Git rejects the original update as `funny refname`.

5. **CONFIRMED — High — the D/F rule is neither atomic nor complete.**

   Evidence — The namespace snapshot is read at [src/protocol/receive-pack.ts:229](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:229), but mutation occurs later at [src/protocol/receive-pack.ts:335](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:335). Storage enforces only [src/database/migrations/0001_init.ts:85](/Users/alizain/ContextLayer/pggit/src/database/migrations/0001_init.ts:85), `primary key (repo_id, name)`. Moreover, `listRefNames` uses `listRefs` at [src/index.ts:150](/Users/alizain/ContextLayer/pggit/src/index.ts:150), which explicitly filters out symrefs with [src/store/refs-store.ts:316](/Users/alizain/ContextLayer/pggit/src/store/refs-store.ts:316), `.where("oid", "is not", null)`.

   Scenarios —

   - Concurrent pushes creating `refs/heads/a` and `refs/heads/a/b` both observe an empty namespace and both exact-key inserts succeed.
   - An existing symbolic `refs/remotes/origin/HEAD` is invisible, allowing a push to persist `refs/remotes/origin/HEAD/x`.

6. **CONFIRMED — Medium — a command that later fails still reserves its namespace against valid commands.**

   Evidence — [src/protocol/receive-pack.ts:233](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:233) builds `acceptedNames` using only syntactic validity, and [src/protocol/receive-pack.ts:241](/Users/alizain/ContextLayer/pggit/src/protocol/receive-pack.ts:241) records the name before connectivity, tip-type, fast-forward, or CAS checks.

   Scenario — In a non-atomic push, command 1 creates a blob at `refs/heads/a`; command 2 creates a valid commit at `refs/heads/a/b`. Command 1 later fails as `invalid new value provided`, but it has already caused command 2 to fail D/F validation. Git 2.55’s receive-pack applies command 2 because the rejected first command never occupies the namespace.

7. **CONFIRMED — Medium — `sharesAncestry` is not Git’s `ok_to_give_up` relation.**

   Evidence — [src/store/reachability.ts:473](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:473) and [src/store/reachability.ts:485](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:485) recursively build both complete closures, then accept any intersection at [src/store/reachability.ts:497](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:497). Git marks an acknowledged commit and only its immediate parents `THEY_HAVE`, then checks whether every commit want reaches that marked set; it also skips non-commit wants for this test. [Git upload-pack](https://github.com/git/git/blob/master/upload-pack.c#L486-L531), [reachability implementation](https://github.com/git/git/blob/master/commit-reach.c#L817-L912).

   Scenarios —

   - For `B←W` and `B←H1←H2`, with `want=W` and only `have=H2`, pggit intersects at distant base `B` and emits `ready`; Git does not, because only `H2` and `H1` are marked.
   - A blob/tree want with an unrelated common commit returns false in pggit, while Git ignores that non-commit want for readiness and emits `ready`.

8. **CONFIRMED — Medium — the strict delta decoder still accepts programs canonical `index-pack` rejects.**

   Evidence — [src/pack/delta.ts:173](/Users/alizain/ContextLayer/pggit/src/pack/delta.ts:173) reads the two sizes and immediately reaches [src/pack/delta.ts:184](/Users/alizain/ContextLayer/pggit/src/pack/delta.ts:184), `while (pos < delta.length)`, without a minimum-length check. The new pack-header equality check therefore accepts a two-byte program when its header also declares two bytes. Git rejects `delta_size < DELTA_SIZE_MIN`, where the minimum is four bytes. [Git patch-delta.c](https://github.com/git/git/blob/master/patch-delta.c#L13-L22).

   Scenario — With one-byte base `"x"`, delta `01 00` declares source length one and zero-length output. Pggit returns an empty object; canonical `index-pack` rejects the delta.

9. **CONFIRMED — Medium — `sharesAncestry` repeats the same deep common walk once per want, serially.**

   Evidence — [src/store/object-store.ts:490](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:490) loops over wants and [src/store/object-store.ts:491](/Users/alizain/ContextLayer/pggit/src/store/object-store.ts:491) awaits each query. Every invocation reconstructs both `want_anc` and `have_anc` at [src/store/reachability.ts:473](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:473).

   Scenario — One hundred wanted branch tips each fork near the root of a 100,000-commit common lineage. Every result is true, so the identical common closure is rebuilt roughly one hundred times before pack construction. Duplicate valid `want` lines cause the same amplification.

10. **CONFIRMED — Medium — grace settling repeats the full GC pipeline two to three times per ordinary push under shipped defaults.**

   Evidence — Unsettled repositories remain selected by [src/gc-scheduler.ts:74](/Users/alizain/ContextLayer/pggit/src/gc-scheduler.ts:74); settling requires [src/gc-scheduler.ts:108](/Users/alizain/ContextLayer/pggit/src/gc-scheduler.ts:108), `last_pushed_at + make_interval(...) <= t0`. Defaults are 60 seconds grace and 30 seconds cadence at [src/env.ts:21](/Users/alizain/ContextLayer/pggit/src/env.ts:21). Contrary to the claim of “cheap re-passes,” an unchanged epoch still expands all OIDs at [src/store/gc.ts:262](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:262), COPYs them at [src/store/gc.ts:425](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:425), analyzes both tables at [src/store/gc.ts:163](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:163), and runs the sweep at [src/store/gc.ts:178](/Users/alizain/ContextLayer/pggit/src/store/gc.ts:178).

   Scenario — A push just after a tick is fully GC’d at approximately 29 and 59 seconds without settling, then again around 89 seconds. Pushes arriving more frequently than grace keep a large repository permanently eligible, repeating the whole live-set pipeline every tick.

## Plausible

1. **PLAUSIBLE — Medium — the negotiation hot path reintroduces recursive-CTE plan and spill exposure.**

   Evidence — [src/store/reachability.ts:152](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:152) says the old recursive CTE fragility is deleted and “structurally unexpressible,” but [src/store/reachability.ts:473](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:473) introduces two recursive `UNION` worktables plus a join. Repository history records the previous CTE plan flip taking over 1,800 seconds at [docs/2026-08-17-derived-state-spine-design.md:3](/Users/alizain/ContextLayer/pggit/docs/2026-08-17-derived-state-spine-design.md:3).

   Scenario — Large, near-root intersections materialize deep worktables per want and per stateless round; limited `work_mem` can spill them, and a join-plan change can magnify the already-confirmed repeated work. Primary-key commit/tag probes make this safer than the deleted `git_edge` query, so the actual planner failure remains plausible rather than confirmed.

2. **PLAUSIBLE — Low — typed expectations add another retained O(reachable objects) hash map to both hot walks.**

   Evidence — `fullClosure` creates `expected` beside `visited` at [src/store/reachability.ts:197](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:197), while `originClosure` creates it beside `masks` at [src/store/reachability.ts:304](/Users/alizain/ContextLayer/pggit/src/store/reachability.ts:304). Entries are retained until the walk completes.

   Scenario — Million-object cold clones or GC passes retain nearly one additional map entry per non-root object, adding tens of MiB plus hashing/collection work per concurrent walk. The allocation is deterministic; whether it causes material latency or OOM at production concurrency is not yet measured.


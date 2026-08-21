# The excellence pass — charter, method, and running record

The derived-state spine (S1–S7) landed on `delta-packs` as commits `ab4664a..db0dfa0`, survived three adversarial review rounds, and reached green on every gate. This document is the charter and running record of the pass that follows: making the repo **excellent**, not merely correct. It is the single source of truth for where the pass stands; the session driving it can die at any time, and a successor picks up from here.

Driving-session transcript (if a successor needs the blow-by-blow): Claude Code session `d9b35932-0fc5-488f-b703-7b3363de5edb`, transcript at `~/.claude/projects/-Users-alizain-ContextLayer/d9b35932-0fc5-488f-b703-7b3363de5edb.jsonl` on the owner's machine — transcripts are deleted after ~30 days, so this doc must stand without it. Finding IDs like "R16" or "round-3 CRITICAL" refer to `docs/2026-08-19-adversarial-review-findings.md`; design decision IDs like "D1"/"D4"/"S2" refer to `docs/2026-08-17-derived-state-spine-design.md`.

## Charter

The whole repo is in scope — not just the spine work. Refactor, simplify, re-layer, reshape dataflow, strip accidental complexity, reorganize and rename files, split modules: all sanctioned. The bar, verbatim from the owner: **"THE REPO SHOULD READ AS A SINGLE COHESIVE, CONCEPTUALLY CLEAR, AND INTEGRAL SYSTEM… as if it was written in one go with one mind with one clarity of thought."**

Mechanism: the `applychecks` skill (`../contextlayer/.agents/skills/applychecks`) drives codex (gpt-5.6-sol, xhigh reasoning) over named check groups from `../contextlayer/.agents/checks/`, editing the tree directly in this faux worktree. Definitions:

- **cycleCore** = functionality → layering → ownership passes, in that order.
- **cycleFull** = cycleCore + testing → language passes, in that order.
- **Chunks**: implementation (`src/` minus tests), tests, performance-testing-code (`perf/`).
- **Order**: cycleCore:implementation → cycleCore:testing → cycleCore:performance-testing-code → cycleFull:repo. All passes serial.

The testing passes are the most important for this repo: they are the verified signal against the real oracle (canonical git + fast-check differentials) that keeps every refactor honest. Expanding test scope is sanctioned and encouraged — especially generative/fuzz tests against the oracle. Culling or strengthening vacuous tests is in scope.

Codex prompts must tell it: massive chunks remain, use subagents liberally, ExecPlans per `../contextlayer/.agents/PLANS.md` are available (plan file in $TMPDIR, never in the worktree), review EVERY file with explicit per-file coverage reporting, and dispatch dedicated subagents for cross-file opportunities.

## The driver loop (each pass)

1. Derive the pass prompt from the previous run's template (run dirs live under the driving job's tmp; the prompt text is the durable part — each records scope, the check-group file list, landmines, gate commands, and the summary contract).
2. Launch codex: `codex exec --json -s workspace-write -C <worktree> -m gpt-5.6-sol -c model_reasoning_effort="xhigh" -c approval_policy="never" -c project_doc_max_bytes=1048576 --disable plugins --disable apps -o <rundir>/last-message.txt - < prompt.md`. Resume a paused/killed thread with `codex exec resume … <THREAD_ID> - < answer-N.md` (repeat every config flag; resume starts from config defaults, not the thread).
3. On completion: read the full report, then review the COMPLETE diff against the checks and the landmine list — never sample.
4. Statics by exit code, never by grepping output (ANSI colors defeat `grep "error TS"`): `tsc -b tsconfig.json --force` (delete stale `dist-types/tsconfig.tsbuildinfo` first), `biome check --error-on-warnings .`, `tsdown`.
5. Tests: `npx vitest run` is the suite (projects config: parallel project maxWorkers 3, then a solo phase). **Standing rule: no full-suite runs without the owner's explicit permission — gate on the blast-radius subset codex names, plus targeted files.** Full gates are owner-scheduled.
6. Perf-sensitive changes: re-run representative probes (`perf--bitmap-clone-queries`, `perf--incremental-fetch`, `perf--blob-delta-gap` with `--expose-gc`, `perf--delta-duplicate-oids`) against the long-lived Postgres on localhost:6489 on a QUIET box. Headline expectations: warm fetch ≈ 1.4–1.5× git at 2001 commits; bitmap clone queries cut ≈ 71×.
7. Feed diagnosed failures back to the same codex thread (resume) so it finishes gate-passing; then commit via `gitc`/`gitcp` (never hand-written messages, never chained with other commands — commits need a 1Password approval the owner clicks; when they are AFK the commit queues). Verify `git log -1` after every generated commit.

## State of the cycles

Branch: `spine-excellence` (faux worktree of pggit), pushed to origin. Base: `db0dfa0` (spine tip).

### Cycle A — cycleCore:implementation — DONE
Commits `8b558ed`, `43a1e4f`, `b8b5801`. Highlight: production seam `bindRepoBackend(stores, repoId)` in `src/protocol/repo-backend.ts`.

### Test-review interlude (owner-inserted before the testing cycle) — DONE
Deep review by driver + subagents produced a verified findings brief; wave-1 fixes landed FIRST (`127f02f`), then the clean codex testing pass (`bba0071`, including the probed `encodeErr` no-trailing-newline fix), then wave-2 oracle properties (`7f3df6f`). The new differentials caught four real wire divergences from canonical git, fixed in `fc29e42` (breaking): ERR pkt framing, zero-have FETCH_SEND_PACK short-circuit, got_oid ACK suppression (`processHaves` → `{common, acks}`), D/F deepest-wins in receive-pack. A fifth finding (empty-blob over-send) triggered R16's own upgrade ruling: client-held expansion at boundary parents only (git's `--objects-edge`); the first attempt (have-tip expansion) caused a 2.2× perf regression, bisected and fixed.

### Cycle B — cycleCore:testing — DONE
Commits `81a135f` (layering), `bed95ce` (functionality), `9517e5a` (ownership). Suite ended ~1,700 lines lighter with stronger oracles.

### Vitest-native gate — DONE
`ecece3d`: projects config (parallel maxWorkers 3 + solo phase for the four contention-sensitive files), the `PGGIT_TEST_DATABASE_URL` escape hatch and its scripts deleted entirely per owner ruling. Gate 69→48 min.

### Cycle C — cycleCore:performance-testing-code — DONE (closed 2026-08-21; quiet-box probe rerun owed)
- Functionality: `58d5e5c` (probes prove preconditions, raw-wire size evidence, strict parsers, perf/ typechecked for the first time).
- Layering: `09f78e1` (one Zod argv boundary per harness, shared `table`/`collector-evidence`, `assertCanonicalStoreFixture` census proofs, discriminated unions; plus driver fixes: unborn-HEAD representation in mirror comparison, self-calibrating delays in `pg-txn--clone-vs-rewind-gc`, vitest `hookTimeout` 600s).
- `2e61899`: GC scheduler e2e runs with nonzero grace (grace=0 + 50ms cadence let the drain reclaim a just-pushed closure mid-fetch — "not our ref" on its own tip).
- Ownership (codex thread `01a02153-a8b0-75a3-b422-32cc9d5e9fbc`, twice interrupted externally and resumed to completion): **complete and verified by driver review; committed `98bd9ac` (2026-08-21) after its blast-radius subset ran green FIRST (8 files / 28 tests).** 66/66 file coverage, net ≈ −500 lines. Consolidations: `createScratchArena`, `FAST_IMPORT_COMMITTER`/`deterministicFiller`/`uuidFromSeed`, `putGitObjects`, `gitObjectInventory`, `verifyPackObjectsInRepo`, `mirrorStateOf`, `directoryBytes`, `vacuumVerbose` (perf/vacuum-evidence.ts), `parseLsRemoteRefs`; `tryGit` deleted in favor of the existing `attemptGit`; `_txn-util.ts` deleted; export hygiene. Best find: byte-chunked fixture seeding in sorted-OID order could split a child from its parent across `putPack` batches — `computeGenerations` treats an absent out-of-batch parent as NULL, and NULL is absorbing, so fixtures could silently freeze generations in a shape production pushes (closure-complete) can never produce. Fixture pushes now reach `putPack` as one ingest.
- **Cycle C closed (2026-08-21)**: the blast-radius subset (perf/memory.test.ts, git-fixtures.test, row-derivation.test, e2e/clone.test, pack-encoding-derivation.test, lifecycle--exotic-fetch-and-grace-split, lifecycle--randomized-sequence-fuzz, repack-invariants.spec) ran green BEFORE the commit. The representative probes still owe a QUIET-box run (the box carried load 9–24 all night) — fold them into the next owner-scheduled gate window.

### Interleaved mission (owner-directed, active) — test-suite efficiency
Trigger: full gates are too heavy on the owner's laptop. Rulings: **no full gates without permission**; rejected approaches: QoS/nice demotion, fewer workers, gate scheduling; **sanctioned approach: make the test CONTENT less wasteful and smaller in budget, driven by flamegraphs/empirical hotspot data, not guesses.**

Incident that corrupted today's timing data: twelve orphaned CPU busy-loops from another agent session (a git-clone-under-load probe whose cleanup died with its parent) saturated the box for 5h14m (load avg ~80–99). Killed by exact PID with owner permission. Every afternoon gate and probe ran ~1.5× inflated; the morning quiet-box reference is 164 files green in 2,897 s wall (5,971 s test time).

Measured ranking (vitest results cache `node_modules/.vite/vitest/*/results.json`, last full run, load-inflated but rank-stable): total 9,183 s test time; `race--clone-vs-repack.test.ts` alone 2,593 s = **28%**; top 7 = 55%; top 25 = 80%. The 30-min fuzz timeout earlier was load+bug artifact, not a real cost (fuzz is not in the top 25).

Structural hypothesis (later CONFIRMED with one revision by the decompositions in the efficiency doc — the seeding owns the PG/idle share, while the raced serves own the largest single share): the race family's cost is dominated by per-iteration re-seeding of the same immutable multi-thousand-object set into fresh repos via `putPack` (clone-vs-repack: 30 iters × 3 modes, up to 2 seeds per round of a ~10k-object set; err-pkt-overflow: 20 × 10k; concurrent-repack: 40 × 3.5k; short-pack: 60 × 2k; two-pushes: 25 × 3.5k) — fixture assembly wrapped around race windows of a few seconds.

The mission's rulings, measurements, and running state live in `docs/2026-08-20-test-efficiency.md` — by late 2026-08-20 all major fixes were RULED (template-copy fixture pattern, mode-split, calibration, iteration trims paired with calibration, monster fixture-scale halving, then a worker-count A/B) and wave 1 was landed and MEASURED: `race--clone-vs-repack` 1,632 s → 987 s (−40%) via template-copy + delta-only seeds, and the negative-sweep four-way split landed at 119 s parallel wall. Wave 2 (rulings 5–6: the monster mode-split with calibrated fraction sweeps, iteration trims across the race family, `RUNS` halving) landed 2026-08-21 — the race family now measures 48.8 / 33.6 / 27.8 / 70.1 / 33.3 s solo; the efficiency doc carries the full record.

Profiling instrumentation (temporary UNSTAGED scratch, still in the tree at time of writing: env-gated git-subprocess timing in `src/testing/spawn-git.ts`, query counting in `src/testing/pg.ts`, untracked `vitest.profile.config.ts` adding `--cpu-prof` to the fork pool) has done its job — both decompositions are measured and recorded in the efficiency doc. **The scratch must be reverted before any efficiency commit and must never be committed.** (Reverted 2026-08-21 before the commit sequence; nothing of it landed.)

### Remaining after cycle C close

1. **File-rename + folder re-org pass** (owner-ordered, "at some point", before or early in cycle D): execute the verified reorg plan with recorded rulings — `lang.ts` extraction YES; `repo-view/` → `repo-file` naming + snapshots→projection collapse executed as ONE `refactor!` commit; `repack.ts` exports `createRepack`; full `.spec` suffix strip; mechanics: `codegraph sync` first, `git mv` + per-file import edits (never sed), commit-per-coherent-move. The full plan is durably committed as `docs/2026-08-20-reorg-plan.md` (commit `a707c2f`), with a staleness addendum that must be honored at execution time.
2. **Cycle D — cycleFull:repo**: functionality → layering → ownership → testing → language over the whole repo, serial, each with the full driver loop. The language/prose pass must also reconcile docs drift: the design doc's stale "sequential batches" doctrine, an R16 note, and a ledger addendum recording the observed depth-2 concurrent-repack instance (RECORDED race-family flake, seen once under load, arbitrated not-chased).
3. **Final comprehensive gate + report**: full suite (owner-scheduled), statics, probes re-measured, merge-ready summary. Merge back together with the owner at the end (their ruling).

## Landmines — never "fix" these

- `readyToGiveUp` is git's exact `ok_to_give_up` (ACKed have marks itself + direct parents; directional walk from want into the set). Never simplify to merge-base-exists.
- `judgeProbedType`'s corruption-vs-violation split (src/store/reachability.ts): a commit/tag with a missing derived row CRASHES the walk, never becomes sweepable.
- `originClosure` violation modes are per-consumer (connectivity rejects; GC retains) and any violation withholds the epoch.
- `DELTA_SIZE_MIN` is wire-boundaries-only; `applyDelta` accepts our encoder's 2-byte empty-target programs; round-trip properties depend on it.
- The `postgres` dependency is patched (patches/postgres.patch) — never bump or re-resolve. Migrations are frozen. `package.json` version is semantic-release's.
- Adversarial-review findings marked RECORDED stay deferred; DISPUTED carry their reasoning. `_MAPPING-*.md` rows under point-in-time disclaimers are frozen provenance, not drift.
- Checks under `../contextlayer/.agents/checks/` and this repo's AGENTS.md/CLAUDE.md: propose edits, never apply unilaterally.

## Machine-local operating notes (rot with the machine, not the repo)

- Commits/pushes need a 1Password click from the owner; failure signature is `1Password: failed to fill whole buffer` → `failed to write commit object`. Never chain `gitc` with other commands.
- The perf Postgres on localhost:6489 IS the machine-global docker-compose Postgres (`contextlayer-postgres-1`, port mapping `6489:5432` — verified 2026-08-21, they are one instance, not two) — never restart it from a session; after a reboot leaves it down, `docker compose up -d postgres` from the workspace `contextlayer/` checkout is the one sanctioned way to bring it back. Kill only exact PIDs you spawned.
- The pnpm mise shim currently has no global default (`mise use -g` would fix); drive vitest/tsc via `node_modules/.bin/*` meanwhile.
- Codex sandbox: reads outside the worktree OK, no network, no Docker — codex never runs vitest; the driver does.
- Network dependencies of the loop itself: codex runs and `gitc`'s message generation (`claude -p`) both need internet; an offline stretch blocks commits and codex passes but not local review, statics, tests, or profiling.

## The driver's subjective layer (2026-08-20, end of the cycle-C/efficiency work)

What follows is judgment, not record — the part a successor cannot re-derive from artifacts.

**Thoughts / leans.** Of the three efficiency fixes, I would bet on the template-repo DB-copy (fix a): it removes the dominant cost while preserving every iteration of race coverage, whereas ITERS trims (fix c) spend coverage to buy time. Fix b (delta-only second seeds) is free-standing, semantically identical to what a real push carries, and should land regardless. Codex pass quality has been consistently high — the checks-driven prompts outperform generic "clean this up" prompting, and the ownership pass's absorbing-NULL find is evidence the discipline pays.

**Concerns.** (1) The staged ownership pass has been validated by statics and full driver review only — its blast-radius test files have NOT run against the final continuation state; the full gate that would have covered it was killed for laptop-load reasons. It must not be committed without at least the blast-radius subset green. *(Resolved 2026-08-21: the subset ran green first, then the commit.)* (2) The per-file cost ranking came from a load-inflated run; contention-sensitive race files may be over-ranked relative to CPU-bound files — the profiling reruns recalibrate the top, but mid-tail ranks carry uncertainty. (3) The cycle-C probe verifications also ran under that load; they matched the headline numbers anyway, but a clean-box probe rerun belongs in the cycle-C close. (4) The `gitc` message generator has no sanitizer — check `git log -1` after every commit; one prompt-leak commit message already had to be amended earlier in this effort.

**Fears.** The specific failure I half-expect: the ownership pass's single-ingest seeding change (`putGitObjects` no longer chunks) interacts badly with the largest fixtures — a single `putPack` of a ~180 MB object set now materializes all COPY rows around one call, and an RSS spike or a slow path in the biggest e2e suites would only surface in the not-yet-run full gate. Second fear: the two unexplained external kills of long-running codex processes — if something on this machine reaps long background processes, cycle D's passes will hit it too; the mitigation (codex resume with full flag repetition) is proven but costs attention.

**Open questions, and what they gate** *(status annotated 2026-08-21 — (1) and (2) were already RULED in the efficiency doc when this layer was written; the contradiction was audit-flagged)*: (1) Template-repo DB-copy — RULED YES (efficiency ruling 1). (2) Full delay-sweep exactly once — RULED YES, paired with calibration (ruling 5). (3) Commit sequencing — RESOLVED 2026-08-21: ownership pass first (blast-radius green → `98bd9ac`), then the efficiency commits. (4) When may the next full gate run? — STILL OPEN; that window now also carries the quiet-box probe rerun and the worker-count A/B (ruling 7).

**Reflections.** Measuring before acting paid off twice today: the vitest results cache already held the per-file ranking (no run needed), and chasing a wrong-looking `pgrep` match instead of dismissing it found twelve orphaned CPU spinners from another session that had been corrupting every measurement for five hours. The session's worst error was its mirror image: declaring the box "idle" from thermals and `top`'s first sample (whose %CPU column is always 0.0) without reading the load average — hours went into a race-test "failure" that was partly contention artifact, though the calibrated-delay fix it produced is genuinely better than the frozen delays it replaced. Standing lesson reconfirmed twice: never chain `gitc` with anything.

**Curiosities (noticed, not pulled).** Spotlight (`mds_stores`) burns real CPU indexing the thousands of short-lived files the suite creates under TMPDIR — a `.metadata_never_index` or equivalent might cut background load; never investigated. The gate's module-import phase costs ~65 s of worker time (the `Duration` line's `import` figure) — nobody has looked at what imports slowly. Whether the external codex kills correlate with laptop sleep or the owner's session switches is unknown.

**Ideas (worth trying, not the task).** A ~30-line vitest custom reporter appending per-file durations to a committed JSONL after each full gate would make test-cost regressions visible over time. A content-keyed cache for `createAppendOnlyRepo` (build each `(docs, runs)` fixture once per gate, `cp -R` per consumer) is the second-order seeding win after fix (a). The `typed-edge` extraction (pure predicate out of `reachability.ts`, unit-testable without Postgres) is already written up in the reorg plan's REJECTED #1 as a separate proposal.

**Latent nuances a fresh reader would not guess.** `maxWorkers: 3` and the solo-file list in `vitest.config.ts` are contention envelopes, not preferences — changing either needs an A/B against solo timings. *(Audit correction 2026-08-21: "measured" overstated the cap's provenance — the 3 was inherited from the old batch runner and nothing has bracketed it from above; the ruling-7 worker A/B is what will actually measure it.)* In `assertCanonicalStoreFixture`, `encodings: { kind: "exact", objects: [] }` asserts ZERO encoding rows while `{ kind: "unchecked" }` skips the check — they read like synonyms and are not. A `race--concurrent-repack` red observed under parallel load early in this effort was arbitrated as an instance of the adversarial ledger's RECORDED race-family flake and deliberately not chased; that arbitration lives only here. The perf probes' Postgres (localhost:6489) and the test suite's testcontainers Postgres are different instances with different lifecycles. The reorg plan's step 14 must keep the `!` in `refactor!:` — semantic-release derives the major bump from it.

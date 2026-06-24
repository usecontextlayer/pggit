# pggit — force-commit + reachability GC: design

- **Date:** 2026-06-24
- **Status:** approved design, pre-implementation. Next step is **tests-first** (behavioural, observable-only — see §8), then implementation.
- **Scope:** ONE new offline capability — **per-repo reachability GC** — plus a **force-commit** storage model that needs *no* protocol change. The hot path (clone / fetch / push / `repo_file`) and every existing git-server behaviour are unchanged.
- **Lineage:** completes **§7** of `internal/archived/2026-06-22-pggit-postgres-native-storage-redesign.md` (GC was the one deferred piece of that redesign; everything else shipped). Motivated by per-user `~/.claude` conversation persistence; the engine/slate *capture* side is a separate track and is out of scope here.
- **Cross-references:** bare `§N` / `§N.M` citations below (e.g. §7, §5.4, §11, §15) point to **that redesign doc**, not to sections of this one (this doc has only §1–§9, no subsections).

---

## 1. Why — the problem

A host pushes a per-user `~/.claude` tree to pggit **after every agent turn**. The transcript JSONL grows append-only, so keeping full commit history *pins every version of it forever*. Measured against real git: a 3.8 MiB file grown over 150 commits leaves **170 MiB of full loose copies** until a repack runs (`/tmp` demo, 2026-06-24). pggit today is exactly git's loose store *with no repack* — one full LZ4'd row per object version (`object-store.ts` ingest; `read-pack.ts:204` expands the wire delta), and its only planned reclamation is reachability GC, which **cannot** touch versions that history keeps reachable.

**Decision (made, not open):** bound storage with **force-commit + GC**, *not* repack/delta.

- **Force-commit:** the client replaces the snapshot ref each turn (amend / fresh commit, force-pushed), so prior commit/tree/transcript-blob objects become **unreachable**.
- **GC:** an offline, per-repo pass reclaims unreachable-and-old-enough objects.
- **Result:** steady-state storage ≈ the *current* reachable tree, with **zero delta machinery**.

**The trade:** no tree-level history / rewind. This is acceptable — resume reads the latest transcript (which contains the entire conversation), every current session is a file in the current snapshot, and Claude's own `file-history/` handles intra-session rewind locally. Repack/at-rest deltas are explicitly rejected (§7); re-open only if a deep-history consumer ever makes *storage* the binding constraint.

pggit already supports the **force-commit half**: non-fast-forward ref updates are accepted by compare-and-swap on the advertised old OID, with no ancestry check (`refs-store.ts:111-158`). CAS is the concurrency guard (a stale/racy push is rejected) — equivalent to git's `--force-with-lease`. So the **only missing half is GC.** This document specifies the GC and the force-commit contract pggit must honour.

---

## 2. The model (observable)

| Concern | Behaviour |
|---|---|
| **Force-commit** | Client moves the snapshot ref to a new, non-descendant commit each turn. pggit accepts via CAS. Old objects become unreachable. (Existing behaviour — no new code.) |
| **GC** | Offline, per-repo. Deletes objects unreachable from all refs **and** older than `grace`. Reachable objects are always retained; a clone after GC is byte-identical and `fsck`-clean. |
| **Grace** | Short, **configurable** (minutes for persistence — *not* git's days-long `gc.pruneExpire` default). The storage/safety dial: every amend orphans the prior transcript, so `grace` = how long orphans linger = the storage overhang. |

---

## 3. GC mechanism (informative — for implementers; rationale in §7)

The exact algorithm is specified in §7 (lines 474–496). Summary:

1. **Materialize the live set** — the reachable closure from all ref tips + their `peeled_oid`s, walking `git_edge` (kinds 1,2,3,5) for commits/trees/tags and **enumerating blobs from tree content** (blobs are not edges — `0003_git_edge.ts:5-8`). This is exactly `reachableClosure(…, omitBlobs=false)` (`store/reachability.ts`). Read under `REPEATABLE READ` with ref tips taken under the **per-repo advisory lock**, into an `UNLOGGED`/temp table.
2. **Sweep in batches, each its own short transaction**, with an anti-join (`NOT EXISTS`, never `NOT IN`):
   ```sql
   DELETE FROM git_object o
   WHERE o.repo_id = $1
     AND NOT EXISTS (SELECT 1 FROM live WHERE oid = o.oid)
     AND o.created_at < clock_timestamp() - $grace
   ```
   `clock_timestamp()` (not `now()`) so the cutoff advances per batch. Batch with `LIMIT N` to cap dead-tuple bursts and lock duration.
3. **Delete orphaned `git_edge` rows** the same way — no FK cascade exists (`0003_git_edge.ts:28-35`), so edges of deleted objects must be swept explicitly.
4. **After a bulk sweep:** `VACUUM (ANALYZE)` heap **and TOAST**, reindex `git_edge_walk`. GC is the sole dead-tuple source, so steady-state bloat is near zero.

GC depends only on **forward `reachableClosure`** — *not* the fetch-negotiation ancestry path that carries the known `neg01` bug — so that bug is irrelevant here.

> **Note for the tests-first phase:** §3 and §5 describe *how*. They are **not** the test target. Tests assert the **observable contract (§4)** only — never the transaction choreography, temp-table use, batch internals, or CTE shape. Those are implementation details and must be free to change.

---

## 4. Observable contract (normative — this is the test spec)

Two observable surfaces, both first-class:

- **Git-protocol surface** — what stock `git` sees over the wire: `clone` / `fetch` / `fsck` / ref advertisement. Oracle = the real `git` binary (`testing/spawn-git.ts`), as everywhere else in pggit.
- **Postgres surface** — rows in `git_object`, `git_edge`, `git_ref`. *What's in Postgres is observable.* Tests may also **control** it (e.g. set a row's `created_at`, or pick `grace = 0` vs `grace = ∞`) to probe boundaries deterministically without waiting on wall-clock.

Every item below must hold and must be covered by a test.

**Reclamation & preservation**

- **GC-1 — Liveness preserved.** After GC, every object reachable from any ref tip (including peeled tag targets) is still present. A full `clone` after GC yields byte-identical reachable content and `git fsck --full` passes.
- **GC-2 — Unreachable reclaimed.** An object unreachable from all refs **and** with `created_at` older than `grace` is absent from `git_object` after GC.
- **GC-3 — Grace protects recent.** An unreachable object **younger** than `grace` is retained after GC. (Probe via two GC runs: `grace = ∞` retains; `grace = 0` reclaims.)
- **GC-4 — Force-commit reclamation & bound.** After a force-commit (ref moved to a non-descendant), the orphaned old commit/tree/blob objects, once older than `grace`, are gone. Over a sequence of *K* amend-then-GC cycles with `grace = 0`, `git_object` row count returns to ≈ the current reachable-set size (does **not** grow with *K*).

**Integrity**

- **GC-5 — No dangling edges / object⟺edges invariant.** After GC: no surviving `git_edge` row has a `parent` or `child` oid absent from `git_object` among the survivors; and every surviving commit/tree/tag still has its complete edge set. (Postgres anti-join assertions.)
- **GC-6 — Idempotence.** Running GC twice consecutively: the second run deletes nothing and leaves `git_object` / `git_edge` / `git_ref` and a subsequent clone byte-identical to after the first.
- **GC-7 — Reachable set is exactly git's.** With `grace = 0`, the set of `git_object` rows surviving GC equals the **real-git reachable object closure** over an equivalent on-disk repo — every object (commit, tree, blob, *and* annotated-tag object) reachable from any ref, computed via the `git` oracle (the exact incantation, e.g. `rev-list --objects --all` plus tag objects, is pinned in the test harness). Neither over- nor under-deletes.

**Isolation & concurrency**

- **GC-8 — Tenant isolation.** GC on repo A never deletes any object/edge of repo B; a clone of repo B and its row counts are unchanged.
- **GC-9 — In-flight push safety.** A push that completes during a concurrent GC is never partially reclaimed: a clone of the pushed ref afterwards is complete and `fsck`-clean. (REPEATABLE-READ live set + advisory-locked ref-tip read + grace; see §5.)
- **GC-10 — Batch invariance.** GC run with batch `LIMIT = 1` reaches the same final observable state (rows + clone) as `LIMIT = ∞`.

**Force-commit contract (mostly existing behaviour — pin it so a regression is caught)**

- **FC-1 — Non-ff accepted on CAS match.** A push moving a ref to a non-descendant commit succeeds when the advertised old OID equals the current tip; a clone then yields the new tip's tree.
- **FC-2 — Stale push rejected.** A ref update whose advertised old OID ≠ current tip is rejected (CAS), leaving the ref unchanged.
- **FC-3 — Preservation regression gate.** All pre-existing protocol behaviours — clone, fetch, incremental/multiround fetch, push (atomic & non-atomic), `repo_file` query, large blobs, non-UTF-8 paths — pass unchanged before and after a GC. The existing suite (242 tests) stays green.

**Property-based (random inputs, oracle-checked)**

- **PBT-1 — Reachability differential.** For random commit DAGs with random ref sets (reuse `generative/commands.ts`), GC with `grace = 0` leaves survivors == the real-git reachable object closure (GC-7's oracle). Generalises GC-1/2/7.
- **PBT-2 — Force-commit storage bound.** For random amend/force-commit sequences, repeated GC keeps `git_object` rows == the current reachable closure (no monotonic growth). Generalises GC-4.
- **PBT-3 — Idempotence under random graphs.** GC∘GC == GC for any generated repo. Generalises GC-6.

---

## 5. Grace & safety

Two defences, by scope (§7):

1. **`REPEATABLE READ` consistent live set** — hides objects from transactions not yet committed at snapshot time; ref tips read under the **per-repo advisory lock** (the same lock the write path holds — `repos.ts`), so the live-set snapshot cannot interleave with a push's ref update.
2. **Time grace on `created_at`** — protects the genuinely present-but-unreachable set: objects a push sent that no ref yet reaches, and commits orphaned by a force-push. Because ingest + connectivity + ref-CAS commit in **one** advisory-locked transaction (§5.4), an object and the ref that reaches it land atomically, so the inserted-before / referenced-after window is tiny.

**The grace is a policy, not a soundness proof.** An object left unreferenced longer than `grace` is treated as garbage — so *pushing objects far in advance of referencing them is unsupported*. For the force-commit workload this is exactly what we want, and a **short** grace (minutes) is safe because the only present-but-unreachable objects are (a) the momentary in-flight window above and (b) the orphans we intend to reclaim. The cleaner endgame — an `xmin` / epoch / last-reachable bound that is *provably* safe against in-flight pushes with no arbitrary timer — is the §15 hardening lever; the high-churn force-commit workload is the consumer that justifies pulling it, but it is **out of scope for v1** (a short time-grace ships first).

---

## 6. Invocation / surface

- GC is a **library function** — roughly `gc(repoId, { graceSeconds, batchLimit })` — invoked **offline, off-peak, per-repo** by the host (e.g. on a cadence, or after a session). It is **not** wired into the push/fetch hot path; the server stays zero-change and the redesign's zero-git-binary hot path is preserved (GC is pure SQL — no `git` shell-out).
- A thin `manage.ts` / CLI entry to run GC for a repo is in scope for operability.
- **Tenant deletion** (delete every object/edge/ref for a `repo_id`, then the `repos` row) is the *same* batched-DELETE machinery (§11) and is naturally enabled by this work, but is **out of scope** for this design — listed only so the GC code is shaped to allow it later.

---

## 7. Explicitly out of scope (named, not silently dropped)

- **Repack / at-rest deltas** — rejected by §7; force-commit removes the need. Re-open only if a deep-history consumer makes storage the binding constraint.
- **Auth / per-user isolation** — no work this round (DB already isolates by `repo_id`; an auth middleware seam exists at `index.ts:133-139` if ever needed).
- **Protected refs / `denyNonFastForwards`** — dropped; CAS (force-with-lease semantics) is sufficient.
- **Per-turn push-cost optimization** — the connectivity full-closure walk (`object-store.ts:251-261`) and full `repo_file` rebuild (`rebuild.ts:21-43`) both scale with *tree size, not change size*. They work today; flagged as a known latency item to revisit **only if** per-turn push gets slow on multi-GB trees.
- **Restore / lazy hydration** — already covered by existing `git clone` + `blob:none` partial clone; a client concern.

---

## 8. Test strategy (next phase)

**Principle: behavioural, observable-only.** Assert §4 — git-oracle behaviour and Postgres rows — never §3/§5 internals. Drive with TDD: write the failing observable test first, then implement.

- **Oracles:** the real `git` binary (`testing/spawn-git.ts`) for clone/fetch/fsck and the reachable-closure differential (`git rev-list --objects --all`); direct Postgres queries for row presence/absence and the edge invariants. Reuse `testing/git-fixtures.ts`.
- **Example-based:** GC-1 … GC-10 + FC-1 … FC-3 as discrete `e2e/gc.test.ts` cases. (`e2e/repack.test.ts`'s `it.todo` GC stubs at `:100-101` are superseded by these; its at-rest re-ingest invariant stays.)
- **Property-based (`fast-check`, reusing `generative/commands.ts`):** PBT-1/2/3 — random DAGs, random ref sets, random amend/force-commit sequences, differentially checked against the git oracle.
- **Concurrency:** GC-9 — interleave a real push with a GC and assert the pushed ref clones clean.
- **Determinism for grace:** control `created_at` and `grace` (incl. `0` and `∞`) rather than wall-clock waits.
- **Regression gate:** FC-3 — the full existing suite stays green; GC is additive.

Build the tests with subagents/workflows, verifying every §4 item before implementation begins.

---

## 9. Open items (resolve during tests/impl, not blocking the design)

- **Default `graceSeconds`** for persistence repos — a small number (single-digit minutes) pending a measured choice; the parameter is the contract, the default is tunable.
- **Surface shape** — library-only vs `manage.ts` subcommand vs both (lean: both).
- **`xmin`/epoch grace** — deferred §15 hardening; v1 ships the short time-grace.

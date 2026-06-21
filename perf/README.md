# perf — pggit diagnostic performance harness

Drives a **real `git clone`** (the `spawnGit` oracle) over loopback against the
**in-process** server, profiles the server process, and emits a machine-readable
`report.json` plus a flamegraph. One-shot and diagnostic — **not** a CI gate.

## Run

```sh
pnpm run perf -- --scenario=markdown          # the target workload (many small files)
pnpm run perf -- --scenario=tiny --rtt=200    # expose per-query round-trip cost
pnpm run perf -- --scenario=adversarial       # many refs / deep history
```

Flags: `--scenario=tiny|markdown|adversarial`, `--repeat=N` (best-of-N wall),
`--rtt=N` (inject N ms Postgres latency via toxiproxy; sweeps 0 vs N),
`--blobs/--history/--churn=N` (override scenario size), `--seed=N`.

Artifacts land in `perf/runs/<scenario>-<timestamp>/`: `report.json` (the agent's
primary read), `hotspots.md` (flame's LLM hotspot table), `flamegraph.html`,
`cpu.pb` (pprof; opens in speedscope / `go tool pprof`).

## What it measures

- **Phase wall-time** (`ref-advertise` / `graph-walk` / `read-objects` / `write-pack`) via `perf_hooks`.
- **Counters** (`getObjectCalls`, `packBytesRead`, `bytesInflated`, `packReadAmplification`, …) via an `AsyncLocalStorage` collector (`src/instrument.ts`) that is **a no-op when the harness isn't driving** — production and the oracle suite pay only a `Map.get`.
- **Per-phase Postgres query count + time** via the Kysely `log` hook.
- **CPU flamegraph** via `@datadog/pprof` (captured in-process), rendered to markdown + HTML by `@platformatic/flame`.
- **Process** event-loop delay, GC pause totals, peak RSS.

### Threadpool caveat — read this before trusting the flamegraph

Async zlib **inflate runs on the libuv threadpool**, not the main JS thread, so it
is **invisible to the main-thread CPU flamegraph** (and there is no `perf` on
macOS to see threadpool CPU). The `bytesInflated` / `packReadAmplification`
counters and the `read-objects` phase **wall-time** are what expose it. Do **not**
read "low main-thread CPU" as "cheap" — in the markdown scenario the server burns
~45s of CPU during a ~33s wall because inflate spreads across threadpool threads.

## Reproducing the known bottlenecks (as of 2026-06-21)

All root to one cause: `object-store.getObject` re-reads + re-inflates the
**entire** stored pack for every object, and `handleFetch` reads every object
**twice** (graph-walk enumerate, then read-objects). Numbers below are from an
Apple-Silicon dev box; absolute timings vary, the ratios don't.

| Bottleneck | Reproduce | Signal in `report.json` |
|---|---|---|
| **O(N²) whole-pack re-inflate** | `pnpm run perf -- --scenario=markdown` | `derived.packReadAmplification` ≈ **1564×**; `derived.gbInflated` ≈ **1.14 GB** to serve a 0.63 MB pack; `read-objects` phase ≈ 17s of a 33s clone (779 objects) |
| **Every object read twice** | same run | `derived.getObjectCallsPerObject` ≈ **2.0** |
| **Per-object round-trips** | `pnpm run perf -- --scenario=tiny --rtt=200` | `rttSweep`: 0 ms ≈ **175 ms** vs 200 ms ≈ **42 s** for a 25-object clone (≈ query count × RTT) |
| **SHA-1 over the whole pack each read** | `--scenario=markdown`, then open `hotspots.md` | `write` / `update` native frames ≈ **28%** main-thread self-time |
| **GC churn** | same | `process.gcCount` ≈ 1600, ≈ **18%** main-thread; `process.peakRssMb` ≈ 410 |

The fix collapses all of them at once: offset-targeted reads (or read-pack-once +
an in-memory index/cache) in `getObject`, plus not enumerating-then-rereading the
object set. (Out of scope for this harness — measure, don't fix.)

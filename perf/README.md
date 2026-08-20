# perf — pggit diagnostic performance harness

Drives a **real `git clone`** over loopback against the **in-process** server, checks its advertised refs and reachable object set against canonical Git, profiles the server process, and emits a machine-readable `report.json` plus a flamegraph. This driver is one-shot and diagnostic; the named probes under `perf/breakage/` enforce their own exit-1 regression bounds.

## Run

```sh
pnpm run perf -- --scenario=markdown          # the target workload (many small files)
pnpm run perf -- --scenario=tiny --rtt=200    # expose per-query round-trip cost
pnpm run perf -- --scenario=adversarial       # many refs / deep history
```

Flags: `--scenario=tiny|markdown|adversarial`, `--repeat=N` (best-of-N wall), `--rtt=N` (inject N ms Postgres latency via toxiproxy; sweeps 0 vs N), `--blobs/--history/--churn=N` (override scenario size), `--seed=N`.

Artifacts land in `perf/runs/<scenario>-<timestamp>/`: `report.json` (the agent's primary read), `hotspots.md` (flame's LLM hotspot table), `flamegraph.html`, `cpu.pb` (pprof; opens in speedscope / `go tool pprof`).

## What it measures

- **Phase wall-time** (`ref-advertise` / `closure` / `pack-encode`) via `perf_hooks`.
- **Counters** (`objectsServed`, `packBytes`, `deltasServed`, `warmDeltasServed`, …) via an `AsyncLocalStorage` collector (`src/instrument.ts`) that is **a no-op when the harness isn't driving** — production and the oracle suite pay only a `Map.get`.
- **Per-phase Postgres query count + time** via the Kysely `log` hook.
- **CPU flamegraph** via `@datadog/pprof` (captured in-process), rendered to markdown + HTML by `@platformatic/flame`.
- **Process** event-loop delay, GC pause totals, peak RSS.

### Flamegraph caveat

The CPU profile samples the Node main thread. Native or off-thread work is not fully attributed there, so wall time, process CPU, Postgres query totals, and the off-thread RSS sampler remain the authoritative boundary measurements. Treat the phase and counter breakdown as an explanation of a run, not as a stable contract.

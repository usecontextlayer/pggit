# pggit — agent conventions

This is a **standalone** repo (NOT a member of the ContextLayer monorepo
workspace). It mirrors the `@usecontextlayer/` engineering conventions:

- pnpm 10 (`packageManager` pinned), node 24 via mise.
- Biome for format + lint (`pnpm run format.fix` / `format.verify`,
  `--error-on-warnings` is load-bearing).
- tsdown owns the shipped build (`dist/*.mjs` + `dist/*.d.mts`); `tsc -b` is the
  typecheck-only pass (emits to `dist-types/`).
- Vitest for tests, with the `*.test.ts` / `*.node.integration.test.ts` taxonomy.
- ESM only (`"type": "module"`), `@/*` → `./src/*` import alias, Zod-validated
  `src/env.ts` singleton, errors must be loud (no silent fallbacks).
- General-engineering discipline from the monorepo AGENTS.md applies: data
  structures first, transform at boundaries / trust types in the core, validate
  at edges, libraries-first, net-negative line delta on bug fixes. The monorepo's
  Dagster/dlt/PyAirbyte/plugin/Slate-specific rules do NOT apply here.

## This repo is harness/oracle-first

Per the design spec at
`/Users/alizain/ContextLayer/internal/in-progress/2026-06-20-git-remote-postgres-design.md`,
`pggit` is a generic git remote that speaks the git smart-HTTP wire protocol
(v2 fetch, v0 push) and stores all git objects + refs in Postgres. The protocol
is fully specified and **verifiable against a perfect oracle** (real `git` +
generative property tests via `fast-check`). Write the harness/oracle FIRST and
let it drive the implementation: every server behavior is checked by round-
tripping against canonical `git`. Hot path is zero-filesystem / zero-git-binary;
the only `git` shell-out is the offline M3 repack worker.

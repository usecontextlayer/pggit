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

## Releases & versioning

Published to npm as `@usecontextlayer/pggit` by **semantic-release**, driven by
the Conventional Commit history (`.releaserc.json`). The `version` field in
`package.json` is a placeholder (`0.0.0-development`) and is intentionally **not**
kept current — the authoritative version lives in the git tags, the npm registry,
and the GitHub Releases. Do NOT hand-bump it; the bump comes from your commit
types (`fix` → patch, `feat` → minor, `!`/`BREAKING CHANGE` → major).

### Cutting a release

Releases are **manual** (`.github/workflows/release.yml`, `workflow_dispatch`
only) so a publish is always deliberate. The gate before publish is fast checks
only (`format.verify` + `tsc` + `build`); the testcontainers suite is not run in
CI.

1. Preview (publishes nothing — computes the next version + notes):
   `gh workflow run release.yml --ref main -f dry_run=true`
   then `gh run watch <id>` and read the version/notes from the log.
2. Ship: `gh workflow run release.yml --ref main -f dry_run=false`.

Auth is the `NPM_TOKEN` repo secret only (granular token with publish rights to
the `@usecontextlayer` scope) + the built-in `GITHUB_TOKEN`.

### Gotchas

- **No npm provenance / `id-token: write`.** On npm CLI 11.x, an available
  id-token makes npm prefer OIDC trusted publishing, which **404s on this scoped
  package** (no trusted publisher configured) instead of using `NPM_TOKEN`
  (npm/cli#8976). Pure token auth, like the monorepo. Want provenance later?
  Configure a trusted publisher on npmjs.com — don't re-add `id-token` here.
- **A failed publish can leave a dangling tag.** semantic-release's step order is
  *create Git tag → prepare → publish*, so the `vX.Y.Z` tag is pushed to origin
  **before** `npm publish`; if publish fails, the tag exists but nothing shipped.
  Delete it before retrying or semantic-release thinks that version already
  released: `git push origin :refs/tags/vX.Y.Z` (and `git tag -d vX.Y.Z` locally).
- **If a scoped publish still 404s on `PUT .../@usecontextlayer%2fpggit`** after
  the above, it's the token, not the config: the `NPM_TOKEN` must have read-write
  on the whole `@usecontextlayer` **scope**. A granular token limited to "select
  packages" cannot CREATE a not-yet-existing package.

See `docs/2026-06-26-npm-publishing-design.md` for the full design + rationale.

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

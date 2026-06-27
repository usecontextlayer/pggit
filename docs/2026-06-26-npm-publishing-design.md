# npm publishing for pggit

**Date:** 2026-06-26
**Status:** implemented

## Goal

Publish `@usecontextlayer/pggit` to npmjs.com with minimal hand-rolled
machinery, following the spirit of the ContextLayer monorepo's release pattern
but scaled to a single standalone package.

## Why not copy the monorepo's `release.ts`/`release.yml`?

The monorepo hand-rolls its release tooling because it versions **three
ecosystems in lockstep** — npm packages, PyPI wheels, and ghcr container images
— which no off-the-shelf tool handles. pggit is a single npm package, so that
justification doesn't apply. The monorepo's own "Libraries First" rule points
the other way here: use a ready-made release tool.

## Tool: semantic-release

`semantic-release` derives the version from Conventional Commit messages,
generates release notes, publishes to npm, and cuts the GitHub Release — fully
automated from the commit history. pggit's history is already Conventional
(`feat(...)`, `fix(...)`, `refactor(...)`, `!` for breaking), so it fits
without changing how we commit.

Considered and rejected:

- **changesets** — strong control (publish = merging a "Version Packages" PR)
  but adds per-change changeset files; more ceremony than a single package needs.
- **Hand-rolled tag workflow** — the monorepo pattern minus PyPI/images; no new
  dependency, but more YAML to maintain than semantic-release's ~4-line config.

## Versioning

semantic-release owns the version. The first release lands on **1.0.0** —
semantic-release's hardcoded initial version. We accept that (staying pre-1.0
would require seeding a `v0.0.0` tag *and* a `breaking → minor` `releaseRules`
override to dodge the breaking-change commits already in history; not worth it).

`package.json` `version` is a placeholder (`0.0.0-development`) and is **not
kept up to date** in the repo — the authoritative version lives in the git tags
/ the npm registry / the GitHub Releases. (semantic-release's documented
convention; see its FAQ.) We deliberately do **not** use `@semantic-release/git`
to commit the bumped version + a `CHANGELOG.md` back to `main`, because that
pushes a commit from CI and this org signs commits via 1Password, which can't
sign in a runner. The GitHub Release notes are the changelog of record.

## Config (`.releaserc.json`)

The default plugin set (all bundled with semantic-release core, no extra deps):

- `@semantic-release/commit-analyzer` — commits → version bump
- `@semantic-release/release-notes-generator` — commits → notes
- `@semantic-release/npm` — `npm publish`
- `@semantic-release/github` — GitHub Release + tag

`branches: ["main"]`.

## CI (`.github/workflows/release.yml`)

One workflow, **`workflow_dispatch` only** (manual). This reconciles "let the
tool do everything" with "I decide when to publish": semantic-release does all
the mechanical work, but a release only happens when the workflow is run by
hand. A `dry_run` input (default **true**) makes the default run a preview
(`semantic-release --dry-run`) that prints the next version + notes and
publishes nothing — the confirm-before-publish gate. Re-run with `dry_run`
unchecked to ship.

Steps: checkout (`fetch-depth: 0`) → mise (node 24) → pnpm install → **fast
gate** (`format.verify` + `tsc` + `build`) → `npx semantic-release`. The full
testcontainers test suite is intentionally **not** in this gate (it needs
Docker/Postgres and is heavy); add it as a separate PR-check workflow if/when
wanted.

Auth: `NPM_TOKEN` repo secret (granular token with publish rights to the
`@usecontextlayer` scope) + the built-in `GITHUB_TOKEN`. Pure token auth, like
the monorepo.

**No npm provenance.** Provenance was tried first (`publishConfig.provenance`
+ `id-token: write`) and broke the publish: on npm CLI 11.x the available
id-token makes npm prefer OIDC trusted publishing, which 404s on this scoped
package because no trusted publisher is configured, instead of falling back to
`NPM_TOKEN` (npm/cli#8976). The symptom was `OIDC token exchange ... 404 ...
package not found` followed by `npm error 404 ... PUT .../@usecontextlayer%2fpggit`.
Removing `provenance` + `id-token: write` (pure token auth) fixes it. To get the
provenance badge later, configure a trusted publisher on npmjs.com (the proper
OIDC path) rather than re-adding `id-token` to this workflow.

## Manifest additions (`package.json`)

`description`, `license: "MIT"` (the field; the LICENSE file already existed),
`repository`, `homepage`, `bugs`, `keywords`, and
`publishConfig: { access: "public" }`. `files: ["dist"]` was already correct
(npm always includes README + LICENSE + package.json on top).

## One-time manual step (repo owner)

Mint a granular npm token with publish rights to `@usecontextlayer` and add it
as the `NPM_TOKEN` repository secret. Nothing else is published from a laptop.

## Release procedure

1. Ensure `NPM_TOKEN` is set.
2. Actions → **release** → Run workflow (leave `dry_run` checked) → read the
   computed version + notes in the log.
3. Run it again with `dry_run` unchecked to publish to npm + cut the GitHub
   Release.

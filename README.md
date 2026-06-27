<div align="center">

# pggit

A battle-tested git server that runs on Postgres.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

```sh
# Point it at a Postgres database and start it. No bare repo on disk, no git binary.
PGGIT_DATABASE_URL=postgres://localhost/pggit pnpm run dev
# [pggit] listening on http://localhost:8080

# Push with stock git. The repo is created on first push, HEAD -> refs/heads/main.
git push http://localhost:8080/myrepo main

# Clone it back. Every object came out of Postgres. (git >= 2.26)
git clone http://localhost:8080/myrepo
```

```sql
-- A branch's working tree is plain SQL — no clone, no checkout, no git.
select f.path, f.mode, o.content
from repo_file f
join repos r      on r.id = f.repo_id
join git_object o on o.repo_id = f.repo_id and o.oid = f.blob_oid
where r.name = 'myrepo' and f.ref_name = 'refs/heads/main'
order by f.path;
```

- **It's just Postgres** — every git object and ref is a row in your database, sitting next to the rest of your data. No bare repos on disk, no git host to run.
- **Compatible with any modern git client, nothing special needed** — `clone`, `fetch`, and `push` work over standard smart-HTTP with the git you already have (>= 2.26, the default since 2020).
- **Queryable** — an optional per-branch index maps each branch tip's files to their blobs, so a `SELECT` returns a repo's working tree with no clone and no checkout.
- **Thoroughly tested** — every operation round-trips against the canonical `git` binary (clone or push, then `fsck --full`), plus property-based differential tests over thousands of random commit graphs.
- **Pure TypeScript** — a git smart-HTTP server built from scratch; no native addons and no `git` binary on the request path.
- **Embed into your app** — it's a Hono sub-app: `host.route("/git", createGitApp(deps))` runs the git server in-process, inside your own service.

## Why?

A git server normally needs a filesystem: bare repos on disk, backed up and replicated out of band, reached through a `git` process. pggit drops that. Objects and refs live in Postgres, so the database you already run, back up, and replicate holds your git data too — right next to everything else. Point any `git remote` at it; it doesn't care what you store: generated files, per-user workspaces, agent output, application content.

## Installation

```sh
npm install @usecontextlayer/pggit
```

Or build from source to hack on it (Node >= 20, pnpm, and a Postgres you can reach):

```sh
git clone https://github.com/usecontextlayer/pggit
cd pggit
pnpm install
pnpm run build
```

Create the schema. Migrations use `DATABASE_URL` (note: the server uses `PGGIT_DATABASE_URL`):

```sh
DATABASE_URL=postgres://localhost/pggit pnpm run db.manage latest
```

## Usage

### As a standalone server

```sh
PGGIT_DATABASE_URL=postgres://localhost/pggit pnpm run dev
# [pggit] listening on http://localhost:8080
```

Then treat it as an ordinary remote:

```sh
git push  http://localhost:8080/myrepo main                  # first push creates the repo
git clone http://localhost:8080/myrepo                       # git >= 2.26 (negotiates v2)
git clone --filter=blob:none http://localhost:8080/myrepo    # blobless / partial clone
```

The standalone server wires the queryable view on by default, so the `repo_file` SQL above works against any repo you push.

### As a Hono sub-app

`createGitApp(deps)` returns a Hono app you mount into your own server, keeping one Postgres connection for the whole host:

```ts
import { createGitApp } from "@usecontextlayer/pggit"

// `deps` supplies the Postgres-backed object and ref stores, plus an optional
// snapshot store that maintains the queryable repo_file index. Omit `snapshots`
// and pggit is a plain git remote.
host.route("/git", createGitApp({ objects, refs, snapshots }))
```

The app exposes the smart-HTTP endpoints under the mount point: `GET /:repo/info/refs`, `POST /:repo/git-upload-pack` (fetch), `POST /:repo/git-receive-pack` (push), and `GET /health`.

## How It Works

git's core data is immutable, content-addressed objects, so pggit stores them that way rather than as packfiles:

- **`git_object`** holds one row per object — the raw inflated body (no loose `<type> <size>\0` header, no zlib), LZ4-compressed Postgres-side, keyed `(repo_id, oid)` and hash-partitioned by repo. Append-only on the push path; unreachable rows are later reclaimed by the background GC drain (below).
- **`git_ref`** is git's only mutable surface. Each row is either a direct ref or a symref; ref updates are compare-and-swap against the advertised old OID.
- **`git_edge`** materializes the commit/tree/tag DAG so reachability — fetch negotiation and the push connectivity check — is a recursive SQL walk instead of re-parsing objects.
- **`repo_file`** is the optional projection: on each push it rebuilds a branch tip's `path -> (mode, blob_oid)` index. It stores no duplicate bytes; content is read by joining `git_object`.

Pushes ingest via binary `COPY` (no per-row bind-parameter ceiling, so a single push can carry huge blobs and tens of thousands of files). Thin-pack delta bases are resolved against objects already in the store. Fetches serve undeltified packs built straight from the closure. OIDs are SHA-1 throughout; correctness is pinned by a suite that round-trips every operation against the real `git` binary and diffs generated commit graphs with `fast-check`.

Because objects are append-only, cleanup is deletion, not rewriting. A background **GC drain** keeps storage bounded: for any repo pushed since its last sweep, it reclaims objects unreachable from every ref and older than a grace window, using the same reachability engine the serve path uses — so a reachable object is never deleted — on a connection pool separate from the request path. The standalone server runs it on by default; a mounted host opts in with the exported `createGcScheduler`.

## Configuration

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `PGGIT_DATABASE_URL` | the server (`pnpm run dev`, `startServer`) | — | Required to serve; throws on boot if unset. |
| `PGGIT_PORT` | the server | `8080` | Listen port. |
| `PGGIT_GC_ENABLED` | the server | `true` | Runs the background GC drain that reclaims unreachable objects. |
| `PGGIT_GC_GRACE_SECONDS` | the server | `60` | Reclaim only objects unreachable for longer than this. |
| `PGGIT_GC_INTERVAL_MS` | the server | `30000` | How often the drain polls for repos to sweep. |
| `PGGIT_GC_CONCURRENCY` | the server | `4` | Max repos swept per drain pass. |
| `DATABASE_URL` | the migration CLI (`pnpm run db.manage`) | — | Required for `latest`/`up`/`down`/`reset`/`drop`. |

## Scope

pggit is deliberately narrow:

- **No authentication.** It serves every request; put it behind your own auth/network boundary.
- **SHA-1 only.** A SHA-256 client is rejected at the wire boundary.
- **Fetch is protocol v2 only**, push is v0. A v0/v1 fetch client fails loudly rather than silently cloning nothing. Shallow clones are rejected; `blob:none` is the only partial-clone filter that's honored — other filters are accepted but ignored, so you get a full clone.

MIT License

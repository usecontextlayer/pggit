import { gunzipSync } from "node:zlib"
import { type Context, Hono } from "hono"
import { cors } from "hono/cors"
import type { Sql } from "postgres"
import { count, runRequest } from "@/instrument"
import { GitProtocolError } from "@/protocol/errors"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import {
	encodeReceivePackAdvertisement,
	handleReceivePack,
	type ReceiveBackend,
} from "@/protocol/receive-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { encodeAdvertisement } from "@/protocol/v2"
import { syncRefSnapshot } from "@/repo-view/rebuild"
import {
	createRepoFileProjection,
	type RepoFileProjection,
} from "@/repo-view/repo-file-projection"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"

export type GitAppDeps = {
	objects: ObjectStore
	refs: RefStore
	/** Optional queryable-view layer. When provided, push maintains a `repo_file`
	 * path→blob index per branch; when omitted, this is a plain git remote. */
	snapshots?: RepoFileProjection
}

// Smart-HTTP info/refs body: the `# service` preamble + flush, then the v2
// capability advertisement.
const UPLOAD_PACK_ADVERTISEMENT = Buffer.concat([
	encodePktLine(Buffer.from("# service=git-upload-pack\n")),
	encodePkt({ type: "flush" }),
	encodeAdvertisement(),
])

// Hono's body types want an ArrayBuffer, not a Node Buffer (a Uint8Array view).
function toArrayBuffer(buf: Buffer): ArrayBuffer {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

const ADVERTISEMENT_BODY = toArrayBuffer(UPLOAD_PACK_ADVERTISEMENT)

/**
 * Read a smart-HTTP POST body, honoring `Content-Encoding`. Git compresses the
 * upload-pack/receive-pack request body with gzip once it is large enough
 * (`remote-curl.c`), exactly as `git http-backend` decompresses on the server
 * side — so we must too. Any other declared encoding is a hard error, never fed
 * raw to the pkt-line parser.
 */
async function readRequestBody(c: Context): Promise<Buffer> {
	const raw = Buffer.from(await c.req.arrayBuffer())
	const encoding = c.req.header("content-encoding")?.toLowerCase()
	if (encoding === undefined || encoding === "identity") return raw
	if (encoding === "gzip" || encoding === "x-gzip") {
		// A body that declares gzip but fails to inflate is a CLIENT wire fault, not a
		// server error — surface it on the same clean 400 path as the unsupported
		// encodings below, never let the ZlibError escape to a 500.
		try {
			return gunzipSync(raw)
		} catch (err) {
			throw new GitProtocolError(
				`request body declared Content-Encoding ${JSON.stringify(encoding)} but failed to gunzip: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}
	throw new GitProtocolError(
		`unsupported request Content-Encoding: ${JSON.stringify(encoding)}`,
	)
}

/**
 * Fetch is served over git protocol v2 ONLY (the charter). git requests v2 with a
 * `Git-Protocol: version=2` header (a `:`-joined key list; git ≥ 2.26 sends it by
 * default). A v0/v1 client sends no such header and cannot parse the v2
 * advertisement — it would read the `version 2` line + flush as an empty repo and
 * silently clone nothing. So reject the unnegotiated case loudly at the boundary
 * (400) instead of handing back an advertisement it will misread.
 */
function assertProtocolV2(header: string | undefined): void {
	const requested = (header ?? "").split(":").map((s) => s.trim())
	if (!requested.includes("version=2")) {
		throw new GitProtocolError(
			"pggit serves fetch over git protocol v2 only; set protocol.version=2 (git ≥ 2.26 negotiates it by default)",
		)
	}
}

/**
 * Split a smart-HTTP request path into the targeted git service and the repoId
 * prefix that precedes it. The repoId is everything before the trailing service
 * segment(s) — opaque and possibly slash-delimited (the persistence grammar
 * `<kind>/<owner>/<ws>[/<user>]`), matching how the store keys repos. `c.req.path`
 * must be mount-relative (a host embeds this app with `app.mount`, not
 * `app.route`; see the route comment).
 */
type GitService = "info/refs" | "git-upload-pack" | "git-receive-pack"
const GIT_PATH_SUFFIXES = [
	["/info/refs", "info/refs"],
	["/git-upload-pack", "git-upload-pack"],
	["/git-receive-pack", "git-receive-pack"],
] as const satisfies readonly (readonly [string, GitService])[]
function parseGitPath(path: string): { repoId: string; service: GitService } | null {
	for (const [suffix, service] of GIT_PATH_SUFFIXES) {
		if (path.endsWith(suffix)) {
			const repoId = path.slice(1, -suffix.length)
			return repoId.length > 0 ? { repoId, service } : null
		}
	}
	return null
}

function backendFor(deps: GitAppDeps, repoId: string): RepoBackend {
	return {
		buildPack: (wants, haves, omitBlobs, includeTag) =>
			deps.objects.buildPack(repoId, wants, haves, omitBlobs, includeTag),
		commonHaves: (haves) => deps.objects.commonHaves(repoId, haves),
		getSymref: (name) => deps.refs.getSymref(repoId, name),
		listRefs: () => deps.refs.listRefs(repoId),
		readyToGiveUp: (wants, common) => deps.objects.readyToGiveUp(repoId, wants, common),
	}
}

function receiveBackendFor(deps: GitAppDeps, repoId: string): ReceiveBackend {
	const backend: ReceiveBackend = {
		applyRefUpdates: (commands, atomic) =>
			deps.refs.applyRefUpdates(repoId, commands, atomic),
		ingest: async (pack) => {
			await deps.objects.ingestPack(repoId, pack)
		},
		isConnected: (oid) => deps.objects.isConnected(repoId, oid),
	}
	if (deps.snapshots) {
		const sdeps = { objects: deps.objects, snapshots: deps.snapshots }
		backend.syncRefSnapshot = (ref, newOid) => syncRefSnapshot(sdeps, repoId, ref, newOid)
	}
	return backend
}

/** v0 receive-pack ref advertisement body: the `# service` preamble + ref list. */
async function receivePackAdvertBody(deps: GitAppDeps, repoId: string): Promise<Buffer> {
	const refs = await deps.refs.listRefs(repoId)
	return Buffer.concat([
		encodePktLine(Buffer.from("# service=git-receive-pack\n")),
		encodePkt({ type: "flush" }),
		encodeReceivePackAdvertisement(refs),
	])
}

/**
 * Build the git-remote Hono app (smart-HTTP, protocol v2 fetch). Mountable into
 * a host app via `host.mount("/git", createGitApp(deps).fetch)` (mount, NOT route —
 * mount strips the prefix so the catch-all parses a mount-relative path); the host owns the
 * Postgres lifecycle behind `deps`.
 */
export function createGitApp(
	deps: GitAppDeps,
	opts: { instrument?: boolean } = {},
): Hono {
	const app = new Hono()
	if (opts.instrument) {
		app.use((c, next) =>
			runRequest({ method: c.req.method, path: c.req.path }, () => next()),
		)
	}
	app.use(cors())

	// A client-caused boundary error (malformed request, unsupported capability) is
	// a clean 400 with its message; anything else is an internal 500, logged loud.
	app.onError((err, c) => {
		if (err instanceof GitProtocolError) return c.text(err.message, 400)
		console.error(err)
		return c.text("internal server error", 500)
	})

	app.get("/health", (c) => c.text("ok"))

	// Smart-HTTP routes — a catch-all per method, with the trailing git service
	// split off the path by `parseGitPath`, rather than a `:repo` param. Two
	// reasons: (1) repoIds are slash-delimited (`<kind>/<owner>/<ws>[/<user>]`) and
	// Hono's RegExpRouter can't span a `:param` across slashes once routes coexist
	// (verified); (2) the repoId is exactly the opaque, possibly slash-containing
	// key the store already uses. A mounted host MUST embed this app with
	// `app.mount` (which strips the mount prefix from `c.req.path`) — `app.route`
	// would leave the prefix in the path and corrupt the parsed repoId.
	app.get("/*", async (c) => {
		const parsed = parseGitPath(c.req.path)
		if (parsed?.service !== "info/refs") return c.notFound()
		const service = c.req.query("service")
		if (service === "git-upload-pack") {
			assertProtocolV2(c.req.header("git-protocol"))
			return c.body(ADVERTISEMENT_BODY, 200, {
				"Cache-Control": "no-cache",
				"Content-Type": "application/x-git-upload-pack-advertisement",
			})
		}
		if (service === "git-receive-pack") {
			const body = await receivePackAdvertBody(deps, parsed.repoId)
			return c.body(toArrayBuffer(body), 200, {
				"Cache-Control": "no-cache",
				"Content-Type": "application/x-git-receive-pack-advertisement",
			})
		}
		return c.text(`unsupported service ${JSON.stringify(service)}`, 403)
	})

	app.post("/*", async (c) => {
		const parsed = parseGitPath(c.req.path)
		if (!parsed) return c.notFound()
		if (parsed.service === "git-upload-pack") {
			const body = await readRequestBody(c)
			const out = await handleUploadPack(body, backendFor(deps, parsed.repoId))
			// Layer-1 wire size, measured at the boundary where bytes actually leave —
			// a no-op unless the perf harness activated a collector, so production pays
			// nothing and the metric survives any restructure of the core.
			count("wireBytes", out.length)
			return c.body(toArrayBuffer(out), 200, {
				"Cache-Control": "no-cache",
				"Content-Type": "application/x-git-upload-pack-result",
			})
		}
		if (parsed.service === "git-receive-pack") {
			const body = await readRequestBody(c)
			const out = await handleReceivePack(body, receiveBackendFor(deps, parsed.repoId))
			return c.body(toArrayBuffer(out), 200, {
				"Cache-Control": "no-cache",
				"Content-Type": "application/x-git-receive-pack-result",
			})
		}
		return c.notFound()
	})

	return app
}

/**
 * Build the git-app deps from a Postgres connection — the embed-into-a-host
 * factory. The host owns the `pg` lifecycle and mounts pggit with
 * `host.mount("/git", createGitApp(createGitDeps(pg)).fetch)` — `app.mount` strips
 * the mount prefix so the catch-all parse sees a mount-relative path (`app.route`
 * would not). `startServer` (server.ts) is the standalone equivalent of this same
 * composition. `snapshots` is always
 * included so a mounted host gets the queryable `repo_file` projection maintained
 * on push (the read surface).
 */
export function createGitDeps(pg: Sql): GitAppDeps {
	return {
		objects: createObjectStore(pg),
		refs: createRefStore(pg),
		snapshots: createRepoFileProjection(pg),
	}
}

// Schema migration for a host that owns the pggit Postgres lifecycle: bring a fresh
// (or behind) database to the latest pggit schema before mounting `createGitApp`. The
// migration set is bundled into `dist` (static imports, not a disk read), so this works
// from the published package — a consumer e2e migrating a throwaway `ctx_pggit`, or a
// production deploy provisioning the agent-state store.
export { migrateToLatest } from "@/database/migrate"
export type {
	DrainEntry,
	DrainSummary,
	GcScheduler,
	GcSchedulerOptions,
} from "@/gc-scheduler"
// Public GC surface: the per-repo reachability GC primitive (a host may drive it
// directly on its own schedule) and the self-scheduling background drain that
// decides when to run it (docs/2026-06-24-gc-scheduler-design.md §4).
export { createGcScheduler } from "@/gc-scheduler"
export type { Gc, GcOptions, GcResult } from "@/store/gc"
export { createGc } from "@/store/gc"

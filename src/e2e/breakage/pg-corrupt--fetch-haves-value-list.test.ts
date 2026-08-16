/**
 * PG BIND-PARAMETER PROBE — the fetch `have` list is an UNBATCHED value list.
 *
 * Every other multi-OID lookup in the store chunks itself: the serve closure uses
 * `PACK_BATCH = 1000`, reachability uses `LOOKUP_BATCH = 1000`, GC loads in
 * `LIVE_LOAD_BATCH = 10000`, ingest goes through binary COPY (no binds at all).
 *
 * Two sites take the CLIENT'S have-list whole, with no chunk:
 *
 *   object-store.ts commonHaves →  .where("oid", "in", haves.map(Buffer.from))
 *   reachability.ts reachableClosure → `values ${sql.join(roots.map(…))}`
 *
 * Both turn one client-controlled list into one bind parameter each. The Postgres
 * extended-query Bind message counts parameters in an INT16, so the wall is 65535 —
 * and `parseFetch` does not even shape-check a `have` (only `want` gets `isOid`),
 * so the list is unfiltered client input.
 *
 * Part A pins the exact wall and its failure MODE (in-band ERR? clean 400? 500?).
 * Part B measures how many haves a REAL `git fetch` puts in one request, so the
 * wall's reachability is a measurement rather than a guess.
 *
 * MEASURED (2026-08-15, git 2.55.0, 4000 mutually-unreachable tips): the per-request
 * have counts were 16, 48, 112, 240, 496 — CUMULATIVE, confirming that
 * protocol-v2-over-HTTP being stateless makes git re-send the whole accumulated list
 * each round. But git then gave up (MAX_IN_VAIN) at 496, and a LINEAR history
 * collapses in one round because a single ACK marks the whole ancestor chain common.
 * So stock `git fetch` does not reach 65534 in these shapes: the wall is a
 * hostile-input / exotic-client crash, not an everyday one. It is still the only
 * unbatched, unvalidated, client-sized value list in the store, and it 500s.
 *
 * Converted from `breakage/pg-corrupt--fetch-haves-value-list.ts`, whose verdict was:
 * exit 0 = every request is answered (or refused in-band); non-zero = a fetch
 * crashes the server.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

const REPO = "workspace/probe/haves"
/** Shared history depth before the branch point — sets how deep git must negotiate. */
const DEPTH = 3000
/** Mutually-unreachable tips on both sides — the shape that makes git enumerate. */
const WIDTH = 4000
/** The Bind message counts parameters in an INT16; one is spent on the repo id. */
const BIND_WALL = 65_534
/** Have-list sizes driven straight at the wire, bracketing that wall. */
const HAVE_SIZES = [1_000, 32_000, 65_000, 65_600, 70_000]

describe("pg-corrupt — the unbatched fetch `have` value list", () => {
	let db: IsolatedDb
	let server: GitServer
	let url = ""
	let tip = ""
	/** Have-list lengths the store saw, one entry per `commonHaves` call. */
	const seen: number[] = []
	const dirs: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-haves-${tag}-`))
		dirs.push(d)
		return d
	}

	/** A linear history of `n` commits over an empty tree, built with fast-import. */
	async function buildHistory(dir: string, n: number): Promise<void> {
		await spawnGit(["init", "-q", "-b", "main", dir])
		const who = "pggit oracle <oracle@pggit.test> 1700000000 +0000"
		const lines: string[] = []
		let mark = 0
		let prev = 0
		for (let i = 0; i < n; i++) {
			const body = `c${i}`
			const blobMark = ++mark
			const commitMark = ++mark
			lines.push(
				`blob\nmark :${blobMark}\ndata ${body.length}\n${body}\n` +
					`commit refs/heads/main\nmark :${commitMark}\ncommitter ${who}\ndata ${body.length}\n${body}\n` +
					(prev === 0 ? "" : `from :${prev}\n`) +
					`M 100644 :${blobMark} f.txt\n`,
			)
			prev = commitMark
		}
		await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: lines.join("") })
	}

	/** `n` mutually-unreachable single-commit branches — a mirror-of-many-branches shape. */
	async function buildWide(dir: string, n: number): Promise<void> {
		await spawnGit(["init", "-q", "-b", "main", dir])
		const who = "pggit oracle <oracle@pggit.test> 1700000000 +0000"
		const lines: string[] = []
		let mark = 0
		for (let i = 0; i < n; i++) {
			const body = `t${i}`
			const blobMark = ++mark
			const commitMark = ++mark
			lines.push(
				`blob\nmark :${blobMark}\ndata ${body.length}\n${body}\n` +
					`commit refs/heads/t${i}\nmark :${commitMark}\ncommitter ${who}\ndata ${body.length}\n${body}\n` +
					`M 100644 :${blobMark} f.txt\n`,
			)
		}
		await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: lines.join("") })
	}

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		// Wrap the store so the test can SEE what the wire actually delivered per request.
		const objects = createObjectStore(db.sql)
		const spy = new Proxy(objects, {
			get(target, prop, receiver) {
				if (prop !== "commonHaves") return Reflect.get(target, prop, receiver)
				return async (repoId: string, haves: string[]) => {
					seen.push(haves.length)
					return target.commonHaves(repoId, haves)
				}
			},
		})
		const app = createGitApp({
			objects: spy,
			refs: createRefStore(db.sql),
			snapshots: createRepoFileProjection(db.sql),
		})
		server = await serveOnPort(app, 0)
		url = `http://127.0.0.1:${server.port}/${REPO}`

		const src = mk("src")
		console.log(`building a ${DEPTH}-commit history…`)
		await buildHistory(src, DEPTH)
		tip = (await spawnGit(["rev-parse", "refs/heads/main"], { cwd: src })).stdout.trim()
		await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], { cwd: src })
		console.log(`pushed ${DEPTH} commits; tip ${tip}`)
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("answers every have-list size without a server fault", async () => {
		const faults: string[] = []
		for (const n of HAVE_SIZES) {
			// Real, existing OIDs would need a repo that big; the wall is about the
			// PARAMETER COUNT, so shape-valid oids exercise exactly the same binds.
			const haves = Array.from({ length: n }, (_, i) => i.toString(16).padStart(40, "0"))
			const body = fetchRequest({ done: true, haves, wants: [tip] })
			const res = await fetch(`${url}/git-upload-pack`, {
				body,
				headers: { "content-type": "application/x-git-upload-pack-request" },
				method: "POST",
			})
			const text = Buffer.from(await res.arrayBuffer()).toString("latin1")
			const verdict =
				res.status === 200
					? text.includes("PACK")
						? "200 + pack"
						: `200 + ${JSON.stringify(text.slice(0, 120))}`
					: `${res.status} ${JSON.stringify(text.slice(0, 200))}`
			console.log(`  haves=${String(n).padStart(6)} → ${verdict}`)
			if (res.status >= 500) {
				faults.push(
					`a fetch with ${n} haves returned HTTP ${res.status} (server fault, not in-band)`,
				)
			}
		}
		expect(faults).toEqual([])
	}, 900_000)

	it(`a real git negotiation over ${WIDTH} unrelated tips stays under the bind wall`, async () => {
		// A LINEAR history negotiates in O(1) haves: one ACK marks the whole ancestor
		// chain common and the negotiator empties. The shape that actually makes git
		// enumerate is WIDE — many mutually-unreachable tips, i.e. a mirror of a repo
		// with many branches/tags. That is the realistic have-heavy client.
		const wide = mk("wide")
		await buildWide(wide, WIDTH)
		await spawnGit(["push", "-q", url, "refs/heads/*:refs/tips/*"], { cwd: wide })
		const client = join(mk("client"), "c")
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, client])

		// One more unrelated tip, server-side only: the client must negotiate against
		// a want that none of its tips can reach.
		const emptyTree = (
			await spawnGit(["hash-object", "-w", "-t", "tree", "--stdin"], {
				cwd: wide,
				input: Buffer.alloc(0),
			})
		).stdout.trim()
		const fresh = (
			await spawnGit(["commit-tree", emptyTree, "-m", "fresh"], { cwd: wide, input: "" })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/fresh", fresh], { cwd: wide })
		await spawnGit(["push", "-q", url, "refs/heads/fresh:refs/heads/fresh"], {
			cwd: wide,
		})

		seen.length = 0
		await spawnGit(
			[
				"-c",
				"protocol.version=2",
				"fetch",
				"-q",
				url,
				"refs/heads/fresh:refs/heads/fresh",
			],
			{ cwd: client },
		)
		const maxHaves = seen.reduce((a, b) => Math.max(a, b), 0)
		const cumulative = seen.reduce((a, b) => a + b, 0)
		console.log(`  requests: ${seen.length}; haves per request: ${seen.join(", ")}`)
		console.log(`  max haves in ONE request: ${maxHaves} (client tips: ${WIDTH + 1})`)
		console.log(
			`  resent-commons? ${seen.some((v, i) => i > 0 && v > (seen[i - 1] as number) * 1.9) ? "growing per round" : "flat/per-batch"}` +
				` (total haves across all requests: ${cumulative})`,
		)
		const ratio = maxHaves / (WIDTH + 1)
		console.log(
			`  → ${ratio.toFixed(2)} haves-in-one-request per client tip; ` +
				`the ${BIND_WALL} wall is reached at ~${Math.round(BIND_WALL / Math.max(ratio, 0.001))} tips`,
		)
		// The measurement, pinned: stock git does not drive the unbatched list into the
		// bind wall in this shape, so the wall is a hostile-client crash, not a daily one.
		expect(maxHaves).toBeLessThan(BIND_WALL)
	}, 900_000)
})

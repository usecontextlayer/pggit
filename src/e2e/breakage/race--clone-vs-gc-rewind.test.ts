/**
 * RACE: a real `git fetch` of an OLD tip (exact `want`, unadvertised) while
 * `gc(graceSeconds: 0)` reclaims that tip's now-unreachable closure.
 *
 * The rewind (`setRef` backwards — the public way the platform moves refs)
 * orphans a whole span of history. A client that still names the old tip drives
 * the store's `routeServeSet` reachability query while GC concurrently deletes out from
 * under it, batch by batch. The delta tier makes this sharper: the 0008 FK
 * cascades (design D7) take any delta whose ANCHOR the object sweep reclaims,
 * so the encoding tier is mutating mid-serve too.
 *
 * The verdict is the FAILURE MODE, compared against the same scenario on a plain
 * `file://` bare remote served by canonical git-upload-pack with a concurrent
 * `git gc --prune=now`:
 *
 *   OK       — fetch succeeded and `git fsck --strict` is clean
 *   PROTO    — clean in-band protocol refusal ("not our ref" / unadvertised)
 *   HTTP500  — server-side internal error surfaced as an HTTP 500
 *   CORRUPT  — fetch reported SUCCESS but the client is missing objects / fails
 *              fsck  <-- the only outcome that is a real defect
 *
 * Both halves are kept: the real-git oracle IS the standard the pggit half is
 * held to, so it is asserted here too (canonical git never hands a client a
 * corrupt result for this race).
 *
 * Converted from `breakage/race--clone-vs-gc-rewind.ts` (`--iters=40 --runs=150
 * --rewind=60`). Probabilistic: the iteration count and the swept gc-start delays
 * are frozen exactly as the script ran them.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { PackInputObject } from "@/pack/write-pack"
import type { GitServer } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { loadReachableObjects } from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 40
const RUNS = 150
/** How far back the ref is rewound — the size of the orphaned span GC eats. */
const REWIND = 60
/** Oracle rounds against the plain `file://` bare remote. */
const ORACLE_ROUNDS = 6

type Verdict = "OK" | "PROTO" | "HTTP500" | "CORRUPT" | "OTHER"

/** Classify one raced fetch by what the CLIENT ended up with. */
async function classify(
	dest: string,
	wantOid: string,
	fetchErr: unknown,
): Promise<{ verdict: Verdict; detail: string }> {
	if (fetchErr !== undefined) {
		const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
		if (/not our ref|unadvertised|not allow/i.test(message)) {
			return { detail: message, verdict: "PROTO" }
		}
		if (/500|internal server error/i.test(message)) {
			return { detail: message, verdict: "HTTP500" }
		}
		return { detail: message, verdict: "OTHER" }
	}
	// Fetch claimed success — hold it to that claim.
	try {
		await spawnGit(["update-ref", "refs/heads/probe", wantOid], { cwd: dest })
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
		return { detail: "", verdict: "OK" }
	} catch (err) {
		return {
			detail: err instanceof Error ? err.message : String(err),
			verdict: "CORRUPT",
		}
	}
}

describe("race — fetch of a rewound tip vs gc(graceSeconds: 0)", () => {
	let db: IsolatedDb
	let server: GitServer
	let store: ObjectStore
	let refs: RefStore
	let repack: Repack
	let gc: Gc
	let src = ""
	let objects: PackInputObject[] = []
	let tip = ""
	let rewindTo = ""
	const scratch: string[] = []

	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		scratch.push(src)
		objects = await loadReachableObjects(src, ["--all"])
		const commits = await commitsOldestFirst(src, "HEAD")
		tip = commits[commits.length - 1] as string
		rewindTo = commits[commits.length - 1 - REWIND] as string

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		store = fixture.deps.objects
		refs = fixture.deps.refs
		repack = createRepack(db.sql)
		gc = createGc(db.sql)
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	// The ORACLE: canonical git, plain file:// bare remote, concurrent
	// `git gc --prune=now`. This is the standard the pggit half is held to.
	it("oracle: canonical git never leaves the client CORRUPT under the same race", async () => {
		const observed: string[] = []
		const corrupt: string[] = []
		const bare = join(mkdtempSync(join(tmpdir(), "gcrew-bare-")), "r.git")
		scratch.push(bare)
		await spawnGit(["clone", "-q", "--bare", src, bare])
		await spawnGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: bare })
		await spawnGit(["update-ref", "refs/heads/main", rewindTo], { cwd: bare })

		for (let i = 0; i < ORACLE_ROUNDS; i++) {
			const dest = join(mkdtempSync(join(tmpdir(), "gcrew-odest-")), "c")
			scratch.push(dest)
			await spawnGit(["init", "-q", "-b", "main", dest])
			let err: unknown
			await Promise.allSettled([
				spawnGit(["fetch", "-q", `file://${bare}`, tip], { cwd: dest }).catch((e) => {
					err = e
				}),
				sleep(i * 3).then(() =>
					spawnGit(["gc", "--prune=now", "-q"], { cwd: bare }).catch(() => undefined),
				),
			])
			const { verdict, detail } = await classify(dest, tip, err)
			observed.push(`round ${i}: ${verdict}`)
			if (verdict === "CORRUPT") {
				corrupt.push(`round ${i}: ${detail.split("\n")[0] ?? ""}`)
			}
			rmSync(dest, { force: true, recursive: true })
			// Restore the pruned objects for the next oracle round.
			await spawnGit(["fetch", "-q", "--force", src, "+refs/heads/*:refs/heads/*"], {
				cwd: bare,
			})
			await spawnGit(["update-ref", "refs/heads/main", rewindTo], { cwd: bare })
		}

		expect(corrupt, observed.join("\n")).toEqual([])
		// A mis-set-up oracle that failed every round would certify the standard
		// vacuously: only rounds that actually completed a fetch are evidence.
		expect(
			observed.filter((v) => v.endsWith("OK")).length,
			observed.join("\n"),
		).toBeGreaterThan(0)
	}, 600_000)

	it("pggit: a fetch git reported as successful is never CORRUPT", async () => {
		const breaks: string[] = []
		const verdicts: string[] = []

		for (let i = 0; i < ITERS && breaks.length === 0; i++) {
			const repo = `race/gc-rewind/${i}`
			await store.putPack(repo, objects)
			await refs.setRef(repo, "refs/heads/main", tip)
			await refs.setSymref(repo, "HEAD", "refs/heads/main")
			await repack.repack(repo) // the delta tier is live for this race

			// Rewind through the PUBLIC ref surface, exactly how the platform does it.
			await refs.setRef(repo, "refs/heads/main", rewindTo)

			const dest = join(mkdtempSync(join(tmpdir(), "gcrew-dest-")), "c")
			scratch.push(dest)
			await spawnGit(["init", "-q", "-b", "main", dest])
			const url = repoUrl(server, repo)
			const delay = [0, 1, 2, 4, 7, 11, 16, 22, 30, 45][i % 10] as number

			let fetchErr: unknown
			await Promise.allSettled([
				spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, tip], {
					cwd: dest,
				}).catch((e) => {
					fetchErr = e
				}),
				// Small batchLimit ⇒ many short sweep transactions ⇒ the deletion is
				// spread across the whole serve, not one atomic instant.
				sleep(delay).then(() =>
					gc.gc(repo, { batchLimit: 25, graceSeconds: 0, maintain: false }),
				),
			])

			const { verdict, detail } = await classify(dest, tip, fetchErr)
			verdicts.push(`iter ${i} gcAt=+${delay}ms ${verdict}`)
			rmSync(dest, { force: true, recursive: true })
			if (verdict === "CORRUPT") {
				breaks.push(`iteration ${i} (gc started +${delay}ms): ${detail}`)
			}
		}

		expect(breaks, verdicts.join("\n")).toEqual([])
		// Only CORRUPT is a break, so a server that 500'd or refused every raced
		// fetch passes this test having served nothing. Require some to succeed.
		expect(
			verdicts.filter((v) => v.endsWith("OK")).length,
			verdicts.join("\n"),
		).toBeGreaterThan(0)
	}, 900_000)
})

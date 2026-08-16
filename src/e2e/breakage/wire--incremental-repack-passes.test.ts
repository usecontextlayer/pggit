/**
 * WIRE — the frozen-policy / star-topology invariants across MANY repack passes,
 * which is how the drain will actually run (one pass per push burst).
 * (Converted from `breakage/wire--incremental-repack-passes.ts`.)
 *
 * Within one pass the anchor bookkeeping (`segmentFill`, each encoding's base) is
 * in memory. Across passes it is reloaded from what was written. If that reload is
 * off — a segment counted wrong, an anchor resolved through a row that is itself a
 * delta — the visible symptom is a delta chain DEEPER than 1 in the served pack,
 * which `git verify-pack -v` on the client reports directly (design D2/D9).
 *
 * Shapes driven here, all through the real wire:
 *   - 90 pushes of one commit each, with a repack pass after every push
 *   - a segment-boundary sweep: clones taken at commit counts that straddle
 *     ANCHOR_EVERY (31/32/33/63/64/65)
 *   - a second repo where tree content is RANDOM per commit, so deltas mostly
 *     LOSE to the whole form and the "delta only when it wins" branch dominates
 */
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const COMMITS = 90
const CHECKPOINTS = new Set([1, 31, 32, 33, 63, 64, 65, COMMITS])

type Checkpoint = {
	commits: number
	cloneError: string | null
	shape: { maxDepth: number; deltas: number; inventoryMatchesSource: boolean } | null
}

/** Max delta chain depth over every pack in a clone, plus the delta count. */
async function depthOf(dir: string): Promise<{ maxDepth: number; deltas: number }> {
	const p = join(dir, ".git", "objects", "pack")
	let maxDepth = 0
	let deltas = 0
	for (const f of readdirSync(p).filter((x) => x.endsWith(".idx"))) {
		const out = await spawnGit(["verify-pack", "-v", join(p, f)], { cwd: dir })
		for (const line of out.stdout.split("\n")) {
			const parts = line.trim().split(/\s+/)
			if (parts.length < 7 || !/^[0-9a-f]{40}$/.test(parts[0] as string)) continue
			deltas++
			maxDepth = Math.max(maxDepth, Number(parts[5]))
		}
	}
	return { deltas, maxDepth }
}

async function inventory(dir: string): Promise<string> {
	return (
		await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], { cwd: dir })
	).stdout
		.split("\n")
		.filter(Boolean)
		.sort()
		.join("\n")
}

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run()
		return null
	} catch (err) {
		return String(err)
	}
}

describe("wire — depth ≤ 1 and exact object sets across every incremental pass", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	const appendOnly: Checkpoint[] = []
	const churn: Checkpoint[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const repack = createRepack(db.sql)
		const base = `http://127.0.0.1:${server.port}`

		/** One scenario: `mutate(dir, i)` writes commit i's worktree state. */
		const run = async (
			name: string,
			repo: string,
			out: Checkpoint[],
			mutate: (dir: string, i: number) => void,
		): Promise<void> => {
			const url = `${base}/${repo}`
			const src = mk(`src-${name}`)
			await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
			mkdirSync(join(src, "dir"))

			for (let i = 0; i < COMMITS; i++) {
				mutate(src, i)
				await spawnGit(["add", "-A"], { cwd: src })
				await spawnGit(["commit", "-q", "-m", `c${i}`], { cwd: src })
				await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], {
					cwd: src,
				})
				// A repack pass after EVERY push — the drain's real cadence.
				await repack.repack(repo)

				if (!CHECKPOINTS.has(i + 1)) continue
				const dest = join(mk(`c-${name}-${i + 1}`), "c")
				const cloneError = await errorOf(async () => {
					await spawnGit([
						"-c",
						"protocol.version=2",
						"-c",
						"transfer.fsckobjects=true",
						"-c",
						"fetch.fsckobjects=true",
						"clone",
						"-q",
						url,
						dest,
					])
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				})
				if (cloneError !== null) {
					out.push({ cloneError, commits: i + 1, shape: null })
					continue
				}
				const d = await depthOf(dest)
				out.push({
					cloneError,
					commits: i + 1,
					shape: {
						deltas: d.deltas,
						inventoryMatchesSource: (await inventory(dest)) === (await inventory(src)),
						maxDepth: d.maxDepth,
					},
				})
			}
		}

		// A. Append-only: every tree version differs from the last by one entry, so
		// deltas overwhelmingly WIN and long segments form.
		await run("append-only", "workspace/probe/passes-append", appendOnly, (dir, i) => {
			writeFileSync(
				join(dir, "dir", `f${String(i).padStart(4, "0")}.txt`),
				`content ${i}\n`.repeat(4),
			)
		})

		// B. Churn: every commit REPLACES the directory with fresh random-ish content,
		// so successive versions share almost nothing and most deltas LOSE.
		await run("churn", "workspace/probe/passes-churn", churn, (dir, i) => {
			rmSync(join(dir, "dir"), { force: true, recursive: true })
			mkdirSync(join(dir, "dir"))
			for (let k = 0; k < 6; k++) {
				const h = createHash("sha1").update(`churn-${i}-${k}`).digest("hex")
				writeFileSync(join(dir, "dir", `${h.slice(0, 12)}.txt`), `${h}\n`.repeat(6))
			}
		})
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	/** The three client-observable claims at one checkpoint of one scenario. */
	function assertCheckpoints(name: string, checkpoints: Checkpoint[]): void {
		expect(checkpoints.length).toBe(CHECKPOINTS.size)
		for (const c of checkpoints) {
			const at = `[${name}] at ${c.commits} commits`
			expect(c.cloneError, at).toBeNull()
			if (!c.shape) throw new Error(`${at}: clone succeeded but no shape was recorded`)
			// The star topology claims depth ≤ 1 (design D2/D9).
			expect(c.shape.maxDepth, `${at} (${c.shape.deltas} deltas)`).toBeLessThanOrEqual(1)
			expect(c.shape.inventoryMatchesSource, at).toBe(true)
		}
	}

	it("append-only: every checkpoint clone is fsck-clean, depth ≤ 1, exact set", () => {
		assertCheckpoints("append-only", appendOnly)
	})

	it("churn: every checkpoint clone is fsck-clean, depth ≤ 1, exact set", () => {
		assertCheckpoints("churn", churn)
	})
})

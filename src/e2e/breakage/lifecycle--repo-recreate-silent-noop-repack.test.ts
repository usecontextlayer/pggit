/**
 * FINDING — after `admin.deleteRepo(name)` and a re-push under the SAME name,
 * a long-lived `createRepack(sql)` (and `createGc(sql)`) silently no-ops on that
 * repo forever, so the encoding tier is never built and the repo's garbage is
 * never reclaimed. No error, no log line: `repack()` returns `{wholes:0,deltas:0}`
 * — indistinguishable from "already covered".
 *
 * Mechanism, entirely from the public surface: every one of these components
 * builds its OWN `createRepoResolver`, whose name->id cache is documented as safe
 * because "the mapping is immutable once a repo exists". Deletion breaks that
 * premise, which is why `RepoResolver.invalidate()` exists — but only the ONE
 * resolver inside a `createGitDeps` composition is invalidated by
 * `admin.deleteRepo`. `createRepack(pg)` / `createGc(pg)` are outside that
 * composition by construction (each takes a bare `Sql`), so they keep resolving
 * the dead id: their queries hit a repo_id with zero rows and report zero work.
 *
 * Why this lands with the delta work rather than being purely pre-existing: W1
 * puts `createRepack()` on the drain (`drainRepo`), built once per process and
 * held for its lifetime — exactly the shape that goes stale. The GC half has sat
 * built-but-unwired since 2026-07-09, so this is the first time the pattern gets
 * a second, size-critical consumer.
 *
 * Proven below with git-observable evidence only:
 *   1. long-lived repack after recreate -> {0,0}, long-lived gc -> all zeros
 *   2. a FRESH repack/gc over the same schema does real work — so (1) was a lie
 *   3. a mirror clone taken between (1) and (2) receives a pack N times larger
 *      than the one taken after (2): the tier really was absent on the wire
 *
 * Converted from `breakage/lifecycle--repo-recreate-silent-noop-repack.ts` at
 * full scale (200 append-only run commits). The source exits 1 when the bug
 * reproduces; here every assertion states the CORRECT outcome — the long-lived
 * components do the work, the fresh ones find nothing left, and the two clones
 * are the same size — so a live reproduction is RED.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type GcResult } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack, type RepackResult } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/recreated"
/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`

function filler(salt: string, len: number): string {
	let out = ""
	while (out.length < len) {
		out += createHash("sha1").update(`${salt}-${out.length}`).digest("hex")
	}
	return out.slice(0, len)
}

/** The append-only shape the delta tier exists for: one run dir per commit. */
function stream(runs: number): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (c: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(c)}\n${c}\n`)
		return m
	}
	const seeded: string[] = []
	for (let i = 0; i < 6; i++) {
		seeded.push(
			`M 100644 :${blob(`# doc ${i}\n${filler(`doc-${i}`, 600)}\n`)} docs/doc-${i}.md`,
		)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	for (let i = 0; i < runs; i++) {
		const h = createHash("sha1").update(`run-${i}`).digest("hex")
		const d = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
		const rec = blob(`{"run":"${d}","payload":"${filler(`rec-${i}`, 400)}"}\n`)
		const err = blob(`${filler(`err-${i}`, 120)}\n`)
		const cm = next()
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata 3\nrun\nfrom :${prev}\n` +
				`M 100644 :${rec} .engine/runs/planner-updates/${d}/record.json\n` +
				`M 100644 :${err} .engine/runs/planner-updates/${d}/stderr\n`,
		)
		prev = cm
	}
	return out.join("")
}

/** Bytes of the pack a mirror clone received (client-side, no server counters). */
async function clonedPackBytes(url: string, dest: string): Promise<number> {
	await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
	await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
	const kb = Number(
		(await spawnGit(["count-objects", "-v"], { cwd: dest })).stdout.match(
			/size-pack: (\d+)/,
		)?.[1] ?? 0,
	)
	rmSync(dest, { force: true, recursive: true })
	return kb * 1024
}

/** Index into a fixture list, loudly (`noUncheckedIndexedAccess`). */
function at<T>(xs: T[], i: number): T {
	const v = xs[i]
	if (v === undefined) throw new Error(`fixture too short: index ${i} of ${xs.length}`)
	return v
}

describe("lifecycle breakage — silent no-op repack after repo recreate", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	let longLivedRepack: RepackResult = { deltas: 0, wholes: 0 }
	let longLivedGc: GcResult = { deletedEdges: 0, deletedEncodings: 0, deletedObjects: 0 }
	let freshRepack: RepackResult = { deltas: 0, wholes: 0 }
	let freshGc: GcResult = { deletedEdges: 0, deletedEncodings: 0, deletedObjects: 0 }
	let packWhileStale = 0
	let packAfterFresh = 0

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-recreate-"))

		const src = join(root, "src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: stream(200) })
		const commits = (
			await spawnGit(["rev-list", "--reverse", "main"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		const tip = at(commits, commits.length - 1)
		const mid = at(commits, 80)

		const deps = createGitDeps(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		// The long-lived components a server process holds for its whole lifetime.
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = createRefStore(db.sql)

		// --- life 1: normal operation, caches warm ---------------------------
		await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
		await repack.repack(REPO)
		await gc.gc(REPO, { graceSeconds: 0 })

		// --- the lifecycle event ---------------------------------------------
		await deps.admin.deleteRepo(REPO)
		await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
		// make real garbage so a working gc would have something to report
		await refs.setRef(REPO, "refs/heads/main", mid)

		// --- life 2: the SAME long-lived components ---------------------------
		longLivedRepack = await repack.repack(REPO)
		longLivedGc = await gc.gc(REPO, { graceSeconds: 0 })

		packWhileStale = await clonedPackBytes(url, join(root, "c1"))

		// --- the truth, from freshly built components -------------------------
		freshRepack = await createRepack(db.sql).repack(REPO)
		// clone BEFORE the fresh gc, so the pack delta below is the TIER alone
		packAfterFresh = await clonedPackBytes(url, join(root, "c2"))
		freshGc = await createGc(db.sql).gc(REPO, { graceSeconds: 0 })
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("re-encodes the recreated repo through the long-lived repack", () => {
		expect(longLivedRepack.wholes + longLivedRepack.deltas).toBeGreaterThan(0)
	})

	it("leaves a freshly built repack nothing to do", () => {
		// The inverse half of the lie: the source only calls it a reproduction when
		// the long-lived pass reported zero AND a fresh one then found real work.
		expect(freshRepack).toEqual({ deltas: 0, wholes: 0 })
	})

	it("reclaims the recreated repo's garbage through the long-lived gc", () => {
		expect(longLivedGc.deletedObjects).toBeGreaterThan(0)
	})

	it("leaves a freshly built gc nothing to reclaim", () => {
		expect(freshGc.deletedObjects).toBe(0)
	})

	it("serves the encoded tier on the wire while the long-lived repack held it", () => {
		// The git-observable consequence: with the tier really built by the
		// long-lived pass, the clone taken before the fresh repack cannot be the
		// bigger one — under the bug it is several times larger.
		expect(packWhileStale).toBeLessThanOrEqual(packAfterFresh)
	})
})

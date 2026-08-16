/**
 * TRANSACTIONAL-INTEGRITY PROBE 3 — the tier's producers and its reaper, overlapped.
 *
 * The design (D5) serializes GC-then-repack per repo INSIDE one drain. Nothing
 * enforces that: `createRepack` and `createGc` are exported, `manage.ts` drives
 * them by hand, and the drain is a per-instance loop. Two overlapping actors on
 * one repo are therefore reachable today. This overlaps them deliberately and asks
 * whether any interleaving can leave a state that is WORSE than loud.
 *
 * Scenarios:
 *   S1  repack || repack   (two passes, same repo, same instant)
 *   S2  repack || gc       (a pass encoding what a sweep is deleting)
 *   S3  clone || repack || gc  (a customer clone through the middle of both)
 *
 * Judged at: the tier's invariants (depth <= 1, no dangling base, no self-delta,
 * exactly one row per object) and canonical git's verdict on the served pack. An
 * actor that THROWS is acceptable — loud is a fine outcome for a race nothing
 * serializes; the settled results ride along in each assertion's message. What is
 * not acceptable is a tier or a served pack left broken, which is what is asserted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import type { GitObjectType } from "@/object/object"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import {
	commitsOldestFirst,
	createAppendOnlyRepo,
	RUNS_DIR,
} from "@/testing/append-only-repo"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "r"
const RUNS = 150
/** Where the divergent history branches from main — orphans ~110 commits (GC work)
 * while the fork's own commits are new (repack work), so the two overlapping actors
 * have genuinely shared subject matter to race over. */
const FORK_AT = 40
const FORK_COMMITS = 60

/** Every invariant the tier owes, as a list of what is broken (empty = all hold). */
async function tierViolations(db: IsolatedDb): Promise<string[]> {
	const rows = await db.sql<{ oid: string; base: string | null }[]>`
		select encode(oid,'hex') as oid, encode(base_oid,'hex') as base from git_pack_encoding`
	const topo = new Map(rows.map((r) => [r.oid, r.base]))
	const bad: string[] = []
	let noRow = 0
	let depth2 = 0
	let self = 0
	for (const [oid, base] of topo) {
		if (base === null) continue
		if (base === oid) self++
		if (!topo.has(base)) noRow++
		else if (topo.get(base) !== null) depth2++
	}
	if (noRow) bad.push(`${noRow} deltas whose base has no encoding row`)
	if (depth2) bad.push(`DEPTH>1: ${depth2} deltas whose base is itself a delta`)
	if (self) bad.push(`${self} self-deltas`)
	const [x] = await db.sql<{ dup: number; orphan: number; ghost: number }[]>`
		select
			(select count(*) from (select oid from git_pack_encoding group by repo_id,oid having count(*)>1) d)::int as dup,
			(select count(*) from git_pack_encoding e where e.base_oid is not null
				and not exists (select 1 from git_object o where o.oid=e.base_oid))::int as orphan,
			(select count(*) from git_pack_encoding e
				where not exists (select 1 from git_object o where o.oid=e.oid))::int as ghost`
	if (!x) throw new Error("tier-invariant query returned no row")
	if (x.dup) bad.push(`${x.dup} duplicate rows`)
	if (x.orphan) bad.push(`${x.orphan} deltas whose base OBJECT is gone`)
	if (x.ghost) bad.push(`${x.ghost} rows for objects that no longer exist`)
	return bad
}

/** A mirror clone of the served repo, judged by canonical git. */
async function cloneVerdict(port: number, dest: string): Promise<string> {
	try {
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			"--mirror",
			`http://127.0.0.1:${port}/${REPO}`,
			dest,
		])
		const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
		return `${fsck.stdout}${fsck.stderr}`.trim() || "clean"
	} catch (err) {
		return `*** FAILED: ${(err as Error).message.slice(0, 200)}`
	}
}

const settled = (r: PromiseSettledResult<unknown>): string =>
	r.status === "fulfilled"
		? JSON.stringify(r.value)
		: `THREW ${(r.reason as Error).message}`

type ScenarioOutcome = { notes: string[]; clone: string; violations: string[] }

describe("repack × GC × clone — overlapping actors on one repo", () => {
	let pgBaseUrl = ""
	let src = ""
	let root = ""
	let forkTip = ""
	const forkOnly: { type: GitObjectType; content: Buffer }[] = []

	beforeAll(async () => {
		pgBaseUrl = inject("pgBaseUrl")
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-concurrent-"))
		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		const commits = await commitsOldestFirst(src)
		const forkBase = commits[FORK_AT]
		if (!forkBase) throw new Error(`fixture too short: no commit #${FORK_AT}`)

		// A divergent history branched at commit #40, built in a CLONE so `src` stays
		// the pristine seed. Pointing the repo's main at this tip is a force push that
		// both orphans ~110 commits (GC work) and adds ~60 new ones (repack work).
		const fork = join(root, "fork")
		await spawnGit(["clone", "-q", "--no-local", src, fork])
		await spawnGit(["checkout", "-q", "-b", "fork", forkBase], { cwd: fork })
		for (let i = 0; i < FORK_COMMITS; i++) {
			const dir = join(
				fork,
				RUNS_DIR,
				`fork-${String(i).padStart(4, "0")}-aaaaaaaa-bbbb-cccc`,
			)
			mkdirSync(dir, { recursive: true })
			writeFileSync(
				join(dir, "record.json"),
				`{"fork":${i},"pad":"${"x".repeat(400)}"}\n`,
			)
			await spawnGit(["add", "-A"], { cwd: fork })
			await spawnGit(["commit", "-q", "-m", `fork ${i}`], { cwd: fork })
		}
		forkTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: fork })).stdout.trim()

		const list = await spawnGit(["rev-list", "--objects", forkTip, `^${forkBase}`], {
			cwd: fork,
		})
		for (const line of list.stdout.trim().split("\n").filter(Boolean)) {
			const oid = line.slice(0, 40)
			const type = (
				await spawnGit(["cat-file", "-t", oid], { cwd: fork })
			).stdout.trim() as GitObjectType
			forkOnly.push({
				content: (await spawnGit(["cat-file", type, oid], { cwd: fork })).stdoutBytes,
				type,
			})
		}
		if (forkOnly.length === 0) throw new Error("fixture wrong: the fork adds no objects")
	}, 600_000)

	afterAll(() => {
		if (src) rmSync(src, { force: true, recursive: true })
		if (root) rmSync(root, { force: true, recursive: true })
	})

	/** Seed a pristine schema, serve it, run `body`, then judge the tier. */
	async function scenario(
		body: (ctx: { db: IsolatedDb; port: number; refs: RefStore }) => Promise<{
			notes: string[]
			clone: string
		}>,
	): Promise<ScenarioOutcome> {
		const db = await createIsolatedSchema(pgBaseUrl)
		let server: GitServer | undefined
		try {
			const objects = createObjectStore(db.sql)
			const refs = createRefStore(db.sql)
			await seedRepoIntoStore(REPO, src, { objects, refs })
			server = await serveOnPort(createGitApp({ objects, refs }), 0)
			const { clone, notes } = await body({ db, port: server.port, refs })
			return { clone, notes, violations: await tierViolations(db) }
		} finally {
			await server?.close()
			await db.drop()
		}
	}

	/** The force push, applied to the store: new objects land, main jumps to the fork. */
	async function rewindAndExtend(db: IsolatedDb, refs: RefStore): Promise<void> {
		await createObjectStore(db.sql).putPack(REPO, forkOnly)
		await refs.setRef(REPO, "refs/heads/main", forkTip)
	}

	function expectSound(name: string, o: ScenarioOutcome): void {
		const context = `${name}\n  ${o.notes.join("\n  ")}`
		expect(o.violations, context).toEqual([])
		expect(o.clone, context).toBe("clean")
	}

	it("S1 repack || repack — the tier stays sound and the repo still clones", async () => {
		const outcome = await scenario(async ({ db, port }) => {
			const [a, b] = await Promise.allSettled([
				createRepack(db.sql).repack(REPO),
				createRepack(db.sql).repack(REPO),
			])
			const clone = await cloneVerdict(port, join(root, "s1"))
			return {
				clone,
				notes: [`pass A: ${settled(a)}`, `pass B: ${settled(b)}`, `clone: ${clone}`],
			}
		})
		expectSound("S1 repack || repack", outcome)
	}, 600_000)

	it("S2 repack || gc on a force-pushed repo — the tier stays sound and the repo still clones", async () => {
		const outcome = await scenario(async ({ db, port, refs }) => {
			await createRepack(db.sql).repack(REPO)
			await rewindAndExtend(db, refs)
			const [a, b] = await Promise.allSettled([
				createRepack(db.sql).repack(REPO),
				createGc(db.sql).gc(REPO, { graceSeconds: 0, maintain: false }),
			])
			const clone = await cloneVerdict(port, join(root, "s2"))
			return {
				clone,
				notes: [`repack: ${settled(a)}`, `gc: ${settled(b)}`, `clone: ${clone}`],
			}
		})
		expectSound("S2 repack || gc", outcome)
	}, 600_000)

	it("S3 clone || repack || gc — a customer clone through the middle of both", async () => {
		const outcome = await scenario(async ({ db, port, refs }) => {
			await createRepack(db.sql).repack(REPO)
			await rewindAndExtend(db, refs)
			const [c, a, b] = await Promise.allSettled([
				cloneVerdict(port, join(root, "s3")),
				createRepack(db.sql).repack(REPO),
				createGc(db.sql).gc(REPO, { graceSeconds: 0, maintain: false }),
			])
			// `cloneVerdict` never rejects — it reports its own failure as the verdict.
			const clone = c.status === "fulfilled" ? c.value : `THREW ${String(c.reason)}`
			return {
				clone,
				notes: [`clone: ${settled(c)}`, `repack: ${settled(a)}`, `gc: ${settled(b)}`],
			}
		})
		expectSound("S3 clone || repack || gc", outcome)
	}, 600_000)
})

/**
 * BREAKAGE (pg-txn) — a cancel on every statement of the ingest transaction.
 * Converted from `breakage/pg-txn--ingest-fault-sweep.ts`; its rationale verbatim:
 *
 * HUNT: does the §10.1 object⟺edges invariant survive a fault landing on each
 * statement of `insertObjects`' transaction — and on the post-commit stamp that
 * sits OUTSIDE it — and does the store converge?
 *
 * `insertObjects` is one `pg.begin` containing two `copyInsert` calls (each a
 * `create temp table … on commit drop`, a streaming `COPY … from stdin`, and an
 * `insert … select … on conflict do nothing`), followed AFTER the commit by
 * `update repos set last_pushed_at = clock_timestamp()`. Each of those is a
 * distinct crash point with a distinct consequence.
 *
 * FAULT INJECTED: `pg_cancel_backend` against ONLY the pid this test read from
 * its own app connection (`select pg_backend_pid()` on a max:1 pool), fired the
 * moment `pg_stat_activity` shows that pid inside the targeted statement. A
 * cancel (not a terminate) is used deliberately: terminating a backend inside a
 * `pg.begin` kills the host process outright — that is its own finding, see
 * pg-txn--txn-death-kills-host-process.test.ts — which would mask this question.
 *
 * The `copy … from stdin` statement is NOT a fault point here: cancelling it
 * hangs the push forever (pg-txn--copy-cancel-hangs-push-forever.test.ts), so it
 * is covered there instead.
 *
 * CHECKED after every fault, then again after a clean retry push:
 *   1. no `git_object` row whose derived edges are missing from `git_edge`
 *      (re-derived in JS from stored content — the invariant under test)
 *   2. no `git_edge` row whose parent object is absent
 *   3. the client saw a clean failure or a clean success, never a hang
 *   4. refs did not move on a failed push
 *   5. a retry push through a healthy connection succeeds, and a fresh mirror
 *      clone is fsck-clean and carries every source object
 *
 * One observation the source printed as a NOTE rather than a verdict, kept here
 * because it is real and deliberately NOT asserted: a cancelled push can leave
 * objects committed while `repos.last_pushed_at` is still NULL — those objects are
 * invisible to the GC drain until some later push stamps that repo.
 *
 * The source script exits 0 when the invariants hold and every case converges — a
 * NEGATIVE result, so this suite is expected GREEN. The negative IS the finding:
 * these ingest fault points do not tear the object⟺edges invariant.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { deriveEdges } from "@/object/edges"
import type { GitObjectType } from "@/object/object"
import { PACK_OBJ_TYPE } from "@/pack/object-header"
import { type GitServer, serveOnPort } from "@/server"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const RUNS = 700
const BOUND_MS = 45_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const TYPE_NAME: Record<number, GitObjectType> = {
	[PACK_OBJ_TYPE.BLOB]: "blob",
	[PACK_OBJ_TYPE.COMMIT]: "commit",
	[PACK_OBJ_TYPE.TAG]: "tag",
	[PACK_OBJ_TYPE.TREE]: "tree",
}

type BoundedGit = { settled: boolean; code: number | null; ms: number; out: string }

/** git with a hard wall-clock bound, so a hang is observed rather than waited on. */
function gitBounded(
	args: string[],
	cwd: string,
	limitMs = BOUND_MS,
): Promise<BoundedGit> {
	return new Promise((resolve) => {
		const t0 = Date.now()
		const child = spawn("git", ["-c", "gc.auto=0", ...args], {
			cwd,
			env: {
				...Object.fromEntries(
					Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
				),
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
		})
		let out = ""
		child.stdout.on("data", (d) => {
			out += d
		})
		child.stderr.on("data", (d) => {
			out += d
		})
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			resolve({ code: null, ms: Date.now() - t0, out, settled: false })
		}, limitMs)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ code, ms: Date.now() - t0, out, settled: true })
		})
	})
}

type Inv = { missing: string[]; dangling: string[]; objects: number; edges: number }

/** The §10.1 invariant, both directions, re-derived from stored content. */
async function invariant(admin: Sql, repo: string): Promise<Inv> {
	const rows = await admin<{ oid: string; type: number; content: Buffer }[]>`
		select encode(o.oid, 'hex') as oid, o.type, o.content from git_object o
		where o.repo_id = (select id from repos where name = ${repo})`
	const edges = await admin<{ parent: string; child: string; kind: number }[]>`
		select encode(parent, 'hex') as parent, encode(child, 'hex') as child, kind
		from git_edge where repo_id = (select id from repos where name = ${repo})`
	const stored = new Set(edges.map((e) => `${e.parent}:${e.child}:${e.kind}`))
	const present = new Set(rows.map((r) => r.oid))
	const missing: string[] = []
	for (const r of rows) {
		const type = TYPE_NAME[r.type]
		if (!type) throw new Error(`unknown git_object.type ${r.type} for ${r.oid}`)
		for (const e of deriveEdges(type, r.content)) {
			if (!stored.has(`${r.oid}:${e.child}:${e.kind}`)) {
				missing.push(`${r.oid}(t${r.type}) -${e.kind}-> ${e.child}`)
			}
		}
	}
	return {
		dangling: [...new Set(edges.map((e) => e.parent))].filter((p) => !present.has(p)),
		edges: edges.length,
		missing,
		objects: rows.length,
	}
}

/** Statement to cancel, matched against `pg_stat_activity.query` for our pid. */
const POINTS: { label: string; needle: string }[] = [
	{ label: "object INSERT (inside the txn)", needle: "insert into git_object" },
	{ label: "edge COPY (inside the txn)", needle: 'copy "copy_stg_git_edge"' },
	{ label: "edge INSERT (inside the txn)", needle: "insert into git_edge" },
	{
		label: "post-commit last_pushed_at stamp (OUTSIDE the txn)",
		needle: "update repos set last_pushed_at",
	},
]

type PointResult = {
	label: string
	pushSettled: boolean
	pushTail: string
	inv: Inv
	refsAfterFailedPush: string[]
	retryOk: boolean
	retryTail: string
	invAfterRetry: Inv | null
	cloneOk: boolean
	cloneTail: string
	fsckClean: boolean
	fsckTail: string
	lostObjects: number
}

describe("breakage/pg-txn — a cancel on every ingest statement", () => {
	let db: IsolatedDb
	let admin: Sql
	let cleanSql: Sql
	let clean: GitServer
	let src = ""
	let root = ""
	const results: PointResult[] = []
	const leaked: string[] = []
	const onLeak = (e: unknown) => {
		leaked.push(`${(e as Error).message}`.slice(0, 80))
	}

	beforeAll(async () => {
		process.on("unhandledRejection", onLeak)
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		root = mkdtempSync(join(tmpdir(), "pggit-txn-ingest-"))
		src = await createAppendOnlyRepo({ runs: RUNS })
		admin = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 3,
			onnotice: () => {},
		})
		cleanSql = postgres(baseUrl, {
			connection: { search_path: db.schema },
			max: 4,
			onnotice: () => {},
		})
		clean = await serveOnPort(createGitApp(createGitDeps(cleanSql)), 0)

		const srcObjects = (
			await spawnGit(["rev-list", "--objects", "--all"], { cwd: src })
		).stdout
			.split("\n")
			.map((l) => l.slice(0, 40))
			.filter((o) => /^[0-9a-f]{40}$/.test(o))
			.sort()

		for (const [i, point] of POINTS.entries()) {
			const repo = `txn/ingest-${i}`
			const faultSql = postgres(baseUrl, {
				connection: { search_path: db.schema },
				max: 1,
				onnotice: () => {},
			})
			const [p] = await faultSql<{ pid: number }[]>`select pg_backend_pid() as pid`
			const pid = p?.pid ?? 0
			const faulty = await serveOnPort(createGitApp(createGitDeps(faultSql)), 0)
			const faultUrl = `http://127.0.0.1:${faulty.port}/${repo}`
			const cleanUrl = `http://127.0.0.1:${clean.port}/${repo}`
			try {
				const push = gitBounded(
					["push", faultUrl, "refs/heads/main:refs/heads/main"],
					src,
				)
				// Cancel ONLY the pid this test opened, and only once it is inside the
				// targeted statement.
				const t0 = Date.now()
				while (Date.now() - t0 < BOUND_MS) {
					const [a] = await admin<{ q: string }[]>`
						select query as q from pg_stat_activity where pid = ${pid}`
					if (a?.q?.toLowerCase().replace(/\s+/g, " ").includes(point.needle)) {
						await admin`select pg_cancel_backend(${pid})`
						break
					}
					await sleep(1)
				}
				const res = await push
				const pushTail = res.out.trim().split("\n").filter(Boolean).slice(-1)[0] ?? ""

				const inv = await invariant(admin, repo)
				const refs = await admin<{ n: string }[]>`
					select name as n from git_ref
					where repo_id = (select id from repos where name = ${repo}) and oid is not null`
				const refsAfterFailedPush =
					res.settled && res.code !== 0 ? refs.map((r) => r.n) : []

				// CONVERGENCE through a healthy connection.
				const retry = await gitBounded(
					["push", cleanUrl, "refs/heads/main:refs/heads/main"],
					src,
				)
				const retryOk = retry.settled && retry.code === 0
				const retryTail = retry.out.trim().split("\n").filter(Boolean).slice(-1)[0] ?? ""

				let invAfterRetry: Inv | null = null
				let cloneOk = false
				let cloneTail = ""
				let fsckClean = false
				let fsckTail = ""
				let lostObjects = 0
				if (retryOk) {
					invAfterRetry = await invariant(admin, repo)
					const dest = join(root, `clone-${i}`)
					const cl = await gitBounded(
						["-c", "protocol.version=2", "clone", "-q", "--mirror", cleanUrl, dest],
						root,
					)
					cloneOk = cl.settled && cl.code === 0
					cloneTail = cl.out.trim().split("\n").filter(Boolean).slice(-1)[0] ?? ""
					if (cloneOk) {
						const fsck = await gitBounded(["fsck", "--strict", "--no-dangling"], dest)
						fsckClean = fsck.code === 0
						fsckTail = fsck.out.trim().slice(0, 200)
						const got = new Set(
							(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dest })).stdout
								.split("\n")
								.map((l) => l.slice(0, 40))
								.filter((o) => /^[0-9a-f]{40}$/.test(o)),
						)
						lostObjects = srcObjects.filter((o) => !got.has(o)).length
					}
					rmSync(dest, { force: true, recursive: true })
				}

				results.push({
					cloneOk,
					cloneTail,
					fsckClean,
					fsckTail,
					inv,
					invAfterRetry,
					label: point.label,
					lostObjects,
					pushSettled: res.settled,
					pushTail,
					refsAfterFailedPush,
					retryOk,
					retryTail,
				})
			} finally {
				await Promise.race([faulty.close().catch(() => {}), sleep(4000)])
				await Promise.race([faultSql.end({ timeout: 3 }).catch(() => {}), sleep(4000)])
			}
		}
	}, 1_800_000)

	afterAll(async () => {
		process.off("unhandledRejection", onLeak)
		await Promise.race([clean?.close().catch(() => {}), sleep(4000)])
		await cleanSql?.end().catch(() => {})
		await admin?.end()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("swept every ingest fault point", () => {
		expect(results.map((r) => r.label)).toEqual(POINTS.map((p) => p.label))
	})

	it("the client always sees a settled push, never a hang", () => {
		expect(
			results
				.filter((r) => !r.pushSettled)
				.map(
					(r) =>
						`${r.label}: push HUNG — no error ever reached the client (last line: "${r.pushTail}")`,
				),
		).toEqual([])
	})

	it("no object survives without its derived edges", () => {
		expect(
			results
				.filter((r) => r.inv.missing.length > 0)
				.map((r) => `${r.label}: ${r.inv.missing.slice(0, 2).join(", ")}`),
		).toEqual([])
	})

	it("no edge survives with an absent parent object", () => {
		expect(
			results
				.filter((r) => r.inv.dangling.length > 0)
				.map((r) => `${r.label}: ${r.inv.dangling.slice(0, 2).join(", ")}`),
		).toEqual([])
	})

	it("refs do not move on a failed push", () => {
		expect(
			results
				.filter((r) => r.refsAfterFailedPush.length > 0)
				.map((r) => `${r.label}: ${r.refsAfterFailedPush.join(",")}`),
		).toEqual([])
	})

	it("a retry through a healthy connection converges the store", () => {
		expect(
			results.filter((r) => !r.retryOk).map((r) => `${r.label}: ${r.retryTail}`),
		).toEqual([])
		expect(
			results
				.filter(
					(r) =>
						r.invAfterRetry !== null &&
						(r.invAfterRetry.missing.length > 0 || r.invAfterRetry.dangling.length > 0),
				)
				.map(
					(r) =>
						`${r.label}: missing=${r.invAfterRetry?.missing.length} dangling=${r.invAfterRetry?.dangling.length}`,
				),
		).toEqual([])
	})

	// Only points whose retry landed can be judged on the clone — a failed retry is
	// already reported by the test above, exactly as the source script's `continue`
	// stopped it from reporting the same cause twice.
	it("the converged repo clones fsck-clean with every source object", () => {
		const converged = results.filter((r) => r.retryOk)
		expect(
			converged.filter((r) => !r.cloneOk).map((r) => `${r.label}: ${r.cloneTail}`),
		).toEqual([])
		expect(
			converged
				.filter((r) => r.cloneOk && !r.fsckClean)
				.map((r) => `${r.label}: fsck DIRTY ${r.fsckTail}`),
		).toEqual([])
		expect(
			converged
				.filter((r) => r.lostObjects > 0)
				.map((r) => `${r.label}: clone missing ${r.lostObjects} source objects`),
		).toEqual([])
	})

	// The source RECORDED unhandled rejections into `leaked` (via the beforeAll
	// listener) but deliberately never made them a verdict — an aborted ingest can
	// legitimately surface an async rejection the store still tolerates. That
	// listener stays (it suppresses stray rejections so the run stays attributable),
	// but asserting `leaked === []` would fail this GREEN negative for behavior the
	// source classified as non-verdict, so it is intentionally not asserted here.
})

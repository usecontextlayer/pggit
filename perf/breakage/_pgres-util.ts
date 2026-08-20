/**
 * Shared plumbing for the `perf/breakage/pgres--*.ts` harnesses — the Postgres
 * RESOURCE lens on the derived pack-encoding tier.
 *
 * Everything here is either a public pggit surface (`createObjectStore`,
 * `createRepack`, `createGc`, `createRefStore`, the wire server) or a READ of the
 * Postgres catalog scoped to the harness's OWN schema. Scores measure resource
 * boundaries (bytes, counts, and time); exact internal censuses are prerequisite
 * integrity proofs that run before those measurements can be scored.
 *
 * NOT a test: a helper module, like `perf/fast-import.ts`. It is imported by the
 * harnesses beside it and never run on its own.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Sql } from "postgres"
import type { Oid } from "@/oid"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	branchAndTagRefsOf,
	type GitObjectWithOid,
	gitReachableOids,
	loadReachableObjects,
	requiredAt,
} from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"

export { revParse } from "@/testing/git-fixtures"
export { table } from "../table"

export const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(2)

const scratch: string[] = []
export function mkTmp(tag: string): string {
	const d = mkdtempSync(join(tmpdir(), `pggit-pgres-${tag}-`))
	scratch.push(d)
	return d
}
export function cleanupTmp(): void {
	for (const d of scratch.splice(0)) rmSync(d, { force: true, recursive: true })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── catalog measurement (own schema only) ────────────────────────────────────

/** One logical table's storage + autovacuum state, summed over its 16 hash leaves. */
export type TableStat = {
	heap: number
	idx: number
	toast: number
	live: number
	dead: number
	autovac: number
	vac: number
	autoanalyze: number
}
export type SchemaStats = Record<string, TableStat>

/**
 * Storage + autovacuum counters for `git_object` / `git_commit` / `git_tag` /
 * `git_pack_encoding`, summed across their leaf partitions, in ONE schema.
 * `pg_relation_size` / `pg_indexes_size` are exact (page counts); the
 * `pg_stat_all_tables` counters are the stats collector's, so callers that just
 * churned should `await sleep(1500)` first (PG flushes backend stats ~1/s).
 */
export async function schemaStats(pg: Sql, schema: string): Promise<SchemaStats> {
	const rows = await pg<
		{
			tbl: string
			heap: string
			idx: string
			toast: string
			live: string
			dead: string
			autovac: string
			vac: string
			autoanalyze: string
		}[]
	>`
		select
			case
				when c.relname like 'git_object%' then 'git_object'
				when c.relname like 'git_commit%' then 'git_commit'
				when c.relname like 'git_tag%' then 'git_tag'
				when c.relname like 'git_pack_encoding%' then 'git_pack_encoding'
				else c.relname
			end as tbl,
			sum(pg_relation_size(c.oid))::text as heap,
			sum(pg_indexes_size(c.oid))::text as idx,
			sum(coalesce(pg_total_relation_size(c.reltoastrelid), 0))::text as toast,
			sum(coalesce(s.n_live_tup, 0))::text as live,
			sum(coalesce(s.n_dead_tup, 0))::text as dead,
			sum(coalesce(s.autovacuum_count, 0))::text as autovac,
			sum(coalesce(s.vacuum_count, 0))::text as vac,
			sum(coalesce(s.autoanalyze_count, 0))::text as autoanalyze
		from pg_class c
			join pg_namespace n on n.oid = c.relnamespace
			left join pg_stat_all_tables s on s.relid = c.oid
		where n.nspname = ${schema} and c.relkind = 'r'
		group by 1`
	const out: SchemaStats = {}
	for (const r of rows) {
		out[r.tbl] = {
			autoanalyze: Number(r.autoanalyze),
			autovac: Number(r.autovac),
			dead: Number(r.dead),
			heap: Number(r.heap),
			idx: Number(r.idx),
			live: Number(r.live),
			toast: Number(r.toast),
			vac: Number(r.vac),
		}
	}
	return out
}

export function stat(s: SchemaStats, table: string): TableStat {
	const value = s[table]
	if (value === undefined) {
		throw new Error(`schema statistics omitted required table ${table}`)
	}
	return value
}
export const total = (t: TableStat): number => t.heap + t.idx + t.toast

/** Rows currently in the encoding tier, and the deflated bytes they hold. */
export async function encodingCensus(
	pg: Sql,
): Promise<{ rows: number; deltas: number; dataBytes: number }> {
	const [r] = await pg<{ rows: string; deltas: string; bytes: string }[]>`
		select count(*)::text as rows,
			count(*) filter (where base_oid is not null)::text as deltas,
			coalesce(sum(octet_length(data)), 0)::text as bytes
		from git_pack_encoding`
	if (r === undefined) throw new Error("encoding census returned no row")
	return { dataBytes: Number(r.bytes), deltas: Number(r.deltas), rows: Number(r.rows) }
}

/** Instance-wide WAL position. POLLUTED by sibling agents — relative only. */
export async function walLsn(pg: Sql): Promise<bigint> {
	const [r] = await pg<{ n: string }[]>`select pg_current_wal_lsn() - '0/0' as n`
	if (r === undefined) throw new Error("WAL position query returned no row")
	return BigInt(r.n)
}

/** Connections this harness's own pools hold, by state. */
export async function ownConnections(
	pg: Sql,
	appName: string,
): Promise<{ total: number; active: number; idleInTxn: number }> {
	const [r] = await pg<{ total: string; active: string; idle_in_txn: string }[]>`
		select count(*)::text as total,
			count(*) filter (where state = 'active')::text as active,
			count(*) filter (where state like 'idle in transaction%')::text as idle_in_txn
		from pg_stat_activity where application_name = ${appName}`
	if (r === undefined) throw new Error("connection census returned no row")
	return {
		active: Number(r.active),
		idleInTxn: Number(r.idle_in_txn),
		total: Number(r.total),
	}
}

// ── fixture building ─────────────────────────────────────────────────────────

const WHEN = "1700000000 +0000"
const COMMITTER = `pggit oracle <oracle@pggit.test> ${WHEN}`
export const RUNS_DIR = ".engine/runs/planner-updates"

let fillerCache = new Map<string, string>()
export function filler(salt: string, len: number): string {
	const key = `${salt}:${len}`
	const hit = fillerCache.get(key)
	if (hit) return hit
	let out = ""
	let i = 0
	while (out.length < len) {
		// deterministic, poorly-compressible hex
		out += hash32(`${salt}-${i++}`)
	}
	const v = out.slice(0, len)
	if (fillerCache.size > 4096) fillerCache = new Map()
	fillerCache.set(key, v)
	return v
}

function hash32(s: string): string {
	// tiny deterministic hex generator (no crypto import churn in hot loops)
	let h1 = 0x811c9dc5
	let h2 = 0x01000193
	for (let i = 0; i < s.length; i++) {
		h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0
		h2 = Math.imul(h2 + s.charCodeAt(i), 2654435761) >>> 0
	}
	return (
		(h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")
	)
}

export function runDirName(salt: string, i: number): string {
	const h = `${hash32(`${salt}-run-${i}`)}${hash32(`${salt}-run2-${i}`)}${hash32(`${salt}-run3-${i}`)}${hash32(`${salt}-run4-${i}`)}`
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** A fast-import stream fragment: `n` append-only run commits onto `fromMark`. */
export function runCommits(opts: {
	branch: string
	salt: string
	count: number
	from?: string
	blobChars: number
	markStart: number
}): { stream: string; nextMark: number } {
	const out: string[] = []
	let mark = opts.markStart
	const next = () => ++mark
	const blob = (content: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return m
	}
	let from = opts.from
	for (let i = 0; i < opts.count; i++) {
		const dir = runDirName(opts.salt, i)
		const record = blob(
			`{"run":"${dir}","payload":"${filler(`${opts.salt}-rec-${i}`, opts.blobChars)}"}\n`,
		)
		const stderr = blob(`${filler(`${opts.salt}-err-${i}`, 120)}\n`)
		const cm = next()
		const msg = `${opts.salt} run ${i}`
		out.push(
			`commit ${opts.branch}\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\n` +
				(from ? `from ${from}\n` : "") +
				`M 100644 :${record} ${RUNS_DIR}/${dir}/record.json\n` +
				`M 100644 :${stderr} ${RUNS_DIR}/${dir}/stderr\n`,
		)
		from = `:${cm}`
	}
	return { nextMark: mark, stream: out.join("") }
}

export async function initRepo(tag: string): Promise<string> {
	const dir = join(mkTmp(tag), "repo")
	mkdirSync(dir, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	return dir
}

export async function fastImport(dir: string, stream: string): Promise<void> {
	await spawnGit(["fast-import", "--quiet", "--force"], { cwd: dir, input: stream })
}

export type Obj = GitObjectWithOid

/** Objects reachable from `tip` but not from any of `notTips`, via one cat-file batch. */
export async function objectsBetween(
	dir: string,
	tip: string,
	notTips: string[],
): Promise<Obj[]> {
	return loadReachableObjects(dir, [tip, ...notTips.map((notTip) => `^${notTip}`)])
}

/** Seed a set of objects through the public store, batched by bytes. */
export async function seedObjects(pg: Sql, repo: string, objs: Obj[]): Promise<void> {
	const store = createObjectStore(pg)
	let batch: Obj[] = []
	let bytes = 0
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return
		await store.putPack(repo, batch)
		batch = []
		bytes = 0
	}
	for (const o of objs) {
		batch.push(o)
		bytes += o.content.length
		if (bytes >= 12_000_000 || batch.length >= 5000) await flush()
	}
	await flush()
}

export async function setMain(pg: Sql, repo: string, oid: Oid): Promise<void> {
	await createRefStore(pg).setRef(repo, "refs/heads/main", oid)
}

// ── correctness judge: real git ──────────────────────────────────────────────

/** Clone over the wire, fsck --strict, and return the sorted reachable object set. */
export async function cloneAndVerify(
	url: string,
	dest: string,
): Promise<{ objects: Oid[]; refs: string[]; fsck: string }> {
	await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
	const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
	const refs = (await branchAndTagRefsOf(dest)).map(({ name, oid }) => `${oid} ${name}`)
	const objects = await gitReachableOids(dest)
	return { fsck: `${fsck.stdout}${fsck.stderr}`.trim(), objects, refs }
}

/** Fire-and-collect: run `git clone` as a child, resolving with wall ms + exit code. */
export function raceClone(
	url: string,
	dest: string,
): Promise<{ ms: number; code: number; stderr: string }> {
	const t0 = Date.now()
	return new Promise((resolve, reject) => {
		const child = spawn(
			"git",
			["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest],
			{
				env: {
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
				},
			},
		)
		let err = ""
		child.stderr.on("data", (c: Buffer) => {
			err += c.toString()
		})
		child.stdout.on("data", () => {})
		child.on("error", reject)
		child.on("close", (code, signal) => {
			if (code === null) {
				reject(new Error(`git clone was terminated by signal ${signal ?? "unknown"}`))
				return
			}
			resolve({ code, ms: Date.now() - t0, stderr: err })
		})
	})
}

// ── output ───────────────────────────────────────────────────────────────────

export function median(xs: number[]): number {
	if (xs.length === 0) throw new Error("cannot take median of an empty sample")
	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)
	const middle = requiredAt(s, m, "median")
	if (s.length % 2 === 1) return middle
	return (requiredAt(s, m - 1, "median") + middle) / 2
}

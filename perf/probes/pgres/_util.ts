/**
 * Shared plumbing for the `perf/probes/pgres/*.ts` harnesses — the Postgres
 * RESOURCE lens on the derived pack-encoding tier.
 *
 * Everything here is either a public pggit surface (`createObjectStore`,
 * `createRepack`, `createGc`, `createRefStore`, the wire server) or a READ of the
 * Postgres catalog scoped to the harness's OWN schema. Scores measure resource
 * boundaries (bytes, counts, and time); exact internal censuses are prerequisite
 * integrity proofs that run before those measurements can be scored.
 *
 * NOT a test: a helper module, like `perf/harness/fast-import.ts`. It is imported by the
 * harnesses beside it and never run on its own.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "postgres"
import type { Oid } from "@/oid"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	deterministicFiller,
	FAST_IMPORT_COMMITTER,
	RUNS_DIR,
	uuidFromSeed,
} from "@/testing/append-only-repo"
import { type GitObjectWithOid, loadReachableObjects } from "@/testing/git-fixtures"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"

export const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(2)

const scratch = createScratchArena()
export const mkTmp = scratch.make
export const cleanupTmp = scratch.cleanup

// ── catalog measurement (own schema only) ────────────────────────────────────

/** One logical table's storage + autovacuum state, summed over its 16 hash leaves. */
type TableStat = {
	heap: number
	idx: number
	toast: number
	live: number
	dead: number
	autovac: number
	vac: number
	autoanalyze: number
}
type SchemaStats = Record<string, TableStat>

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

// ── fixture building ─────────────────────────────────────────────────────────

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
		const dir = uuidFromSeed(`${opts.salt}-run-${i}`)
		const record = blob(
			`{"run":"${dir}","payload":"${deterministicFiller(`${opts.salt}-rec-${i}`, opts.blobChars)}"}\n`,
		)
		const stderr = blob(`${deterministicFiller(`${opts.salt}-err-${i}`, 120)}\n`)
		const cm = next()
		const msg = `${opts.salt} run ${i}`
		out.push(
			`commit ${opts.branch}\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${msg.length}\n${msg}\n` +
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

/** Objects reachable from `tip` but not from any of `notTips`, via one cat-file batch. */
export async function objectsBetween(
	dir: string,
	tip: string,
	notTips: string[],
): Promise<GitObjectWithOid[]> {
	return loadReachableObjects(dir, [tip, ...notTips.map((notTip) => `^${notTip}`)])
}

/** Seed one push's complete object set through the public store. */
export async function seedObjects(
	pg: Sql,
	repo: string,
	objs: GitObjectWithOid[],
): Promise<void> {
	await createObjectStore(pg).putPack(repo, objs)
}

export async function setMain(pg: Sql, repo: string, oid: Oid): Promise<void> {
	await createRefStore(pg).setRef(repo, "refs/heads/main", oid)
}

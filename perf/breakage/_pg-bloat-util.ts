/**
 * Shared instruments for the storage-economics harnesses (row volume, table/index
 * bloat, TOAST behaviour, vacuum interactions).
 *
 * SUPPORT ONLY — not a harness itself. Every finding ships as a self-contained
 * `pg-bloat--<slug>.ts` beside this file that prints its own measurement table and
 * sets a non-zero `process.exitCode` on its own threshold.
 *
 * Everything here is read-only against the catalog except `vacuumFull`/
 * `vacuumAnalyze`, which the caller runs only on tables inside the isolated schema
 * it created.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgresFactory, { type Sql } from "postgres"
import {
	gitReachableOids,
	loadGitObjects,
	loadReachableObjects,
} from "@/testing/git-fixtures"

export {
	flag,
	increasingIntegerListFlag,
	positiveIntegerFlag,
	positiveNumberFlag,
} from "../args"

/** Default target for `--pg=`; every harness takes the flag and falls back here. */
export const DEFAULT_PG_URL = "postgres://postgres:postgres@localhost:6489/postgres"
export const WHEN = "1700000000 +0000"
export const COMMITTER = `pggit oracle <oracle@pggit.test> ${WHEN}`

/** The tables whose economics this hunt is about. */
export const TABLES = [
	"git_object",
	"git_commit",
	"git_tag",
	"git_pack_encoding",
	"git_ref",
	"repo_file",
	"repos",
] as const
export type TableName = (typeof TABLES)[number]

/** Which of those are HASH-partitioned ×16 (sizes must sum over leaves). */
export const PARTITIONED = new Set<string>([
	"git_object",
	"git_commit",
	"git_tag",
	"git_pack_encoding",
	"repo_file",
])

export function mb(bytes: number): string {
	return `${(bytes / 1_000_000).toFixed(2)}`
}
export function kb(bytes: number): string {
	return `${(bytes / 1000).toFixed(1)}`
}
export function pad(s: string | number, n: number): string {
	return String(s).padStart(n)
}
export function padr(s: string | number, n: number): string {
	return String(s).padEnd(n)
}

export type Sizes = { heap: number; indexes: number; toast: number; total: number }

/** On-disk bytes for a table, summing leaf partitions when it is partitioned. */
export async function sizeOf(sql: Sql, table: string): Promise<Sizes> {
	if (PARTITIONED.has(table)) {
		const [r] = await sql<{ total: string; heap: string; idx: string; leaves: string }[]>`
			select
				coalesce(sum(pg_total_relation_size(inhrelid)),0)::text as total,
				coalesce(sum(pg_relation_size(inhrelid)),0)::text as heap,
				coalesce(sum(pg_indexes_size(inhrelid)),0)::text as idx,
				count(*)::text as leaves
			from pg_inherits where inhparent = ${table}::regclass`
		if (r === undefined) throw new Error(`size query returned no row for ${table}`)
		if (Number(r.leaves) !== 16) {
			throw new Error(`expected 16 leaf partitions for ${table}, found ${r.leaves}`)
		}
		const total = Number(r.total)
		const heap = Number(r.heap)
		const indexes = Number(r.idx)
		return { heap, indexes, toast: total - heap - indexes, total }
	}
	const [r] = await sql<{ total: string; heap: string; idx: string }[]>`
		select pg_total_relation_size(${table}::regclass)::text as total,
			pg_relation_size(${table}::regclass)::text as heap,
			pg_indexes_size(${table}::regclass)::text as idx`
	if (r === undefined) throw new Error(`size query returned no row for ${table}`)
	const total = Number(r.total)
	const heap = Number(r.heap)
	const indexes = Number(r.idx)
	return { heap, indexes, toast: total - heap - indexes, total }
}

export async function sizesAll(sql: Sql): Promise<Record<string, Sizes>> {
	const out: Record<string, Sizes> = {}
	for (const t of TABLES) out[t] = await sizeOf(sql, t)
	return out
}

export type Stat = {
	relname: string
	live: number
	dead: number
	ins: number
	upd: number
	del: number
	hot: number
	autovac: number
	vac: number
	autoanalyze: number
	lastAutovacuum: string | null
}

/**
 * Per-relation activity/dead-tuple stats for THIS schema only. Postgres reports
 * these per physical relation, so a partitioned table shows up as its 16 leaves;
 * `aggregate` rolls them back up by prefix.
 */
export async function stats(sql: Sql, schema: string): Promise<Stat[]> {
	const rows = await sql<
		{
			relname: string
			n_live_tup: string
			n_dead_tup: string
			n_tup_ins: string
			n_tup_upd: string
			n_tup_del: string
			n_tup_hot_upd: string
			autovacuum_count: string
			vacuum_count: string
			autoanalyze_count: string
			last_autovacuum: Date | null
		}[]
	>`
		select relname, n_live_tup, n_dead_tup, n_tup_ins, n_tup_upd, n_tup_del,
			n_tup_hot_upd, autovacuum_count, vacuum_count, autoanalyze_count, last_autovacuum
		from pg_stat_user_tables where schemaname = ${schema} order by relname`
	return rows.map((r) => ({
		autoanalyze: Number(r.autoanalyze_count),
		autovac: Number(r.autovacuum_count),
		dead: Number(r.n_dead_tup),
		del: Number(r.n_tup_del),
		hot: Number(r.n_tup_hot_upd),
		ins: Number(r.n_tup_ins),
		lastAutovacuum: r.last_autovacuum ? r.last_autovacuum.toISOString() : null,
		live: Number(r.n_live_tup),
		relname: r.relname,
		upd: Number(r.n_tup_upd),
		vac: Number(r.vacuum_count),
	}))
}

/** Roll leaf-partition stats up to their logical table (`git_object_p3` → `git_object`). */
export function aggregate(rows: Stat[]): Record<string, Stat> {
	const out: Record<string, Stat> = {}
	for (const r of rows) {
		const base = r.relname.replace(/_p\d+$/, "")
		const cur = out[base]
		if (!cur) {
			out[base] = { ...r, relname: base }
			continue
		}
		cur.live += r.live
		cur.dead += r.dead
		cur.ins += r.ins
		cur.upd += r.upd
		cur.del += r.del
		cur.hot += r.hot
		cur.autovac += r.autovac
		cur.vac += r.vac
		cur.autoanalyze += r.autoanalyze
		if (
			r.lastAutovacuum &&
			(!cur.lastAutovacuum || r.lastAutovacuum > cur.lastAutovacuum)
		) {
			cur.lastAutovacuum = r.lastAutovacuum
		}
	}
	return out
}

/**
 * The vacuum horizon, and who is holding it.
 *
 * A snapshot's xmin is computed cluster-wide, so ONE long-running transaction —
 * in any database of the instance, including pggit's own GC sweep — pins
 * `data_oldest_nonremovable` for every table everywhere: VACUUM then runs, reports
 * "dead but not yet removable", and reclaims nothing. Any bloat measurement that
 * does not report this cannot tell "the tuning never fired" from "nothing could be
 * reclaimed", so every harness here prints it.
 */
export type Horizon = {
	/** how many XIDs behind the current snapshot's xmin lags */
	ageXids: number
	/** the longest-running client transaction, in seconds */
	oldestXactSeconds: number
	/** pid/db/seconds/query of transactions older than 5s */
	blockers: { pid: number; db: string; seconds: number; query: string }[]
}

export async function horizon(sql: Sql): Promise<Horizon> {
	const [h] = await sql<{ age: string | null; oldest: string | null }[]>`
		select (select max(age(backend_xmin))::text from pg_stat_activity where backend_xmin is not null) as age,
			(select max(extract(epoch from (now() - xact_start)))::text from pg_stat_activity
				where backend_type = 'client backend' and xact_start is not null) as oldest`
	const blockers = await sql<{ pid: number; db: string; secs: string; q: string }[]>`
		select pid, coalesce(datname, '-') as db,
			extract(epoch from (now() - xact_start))::text as secs, left(query, 70) as q
		from pg_stat_activity
		where backend_type = 'client backend' and xact_start is not null
			and now() - xact_start > interval '5 seconds'
		order by xact_start`
	if (h === undefined) throw new Error("vacuum-horizon query returned no row")
	const ageXids = Number(h.age ?? 0)
	const oldestXactSeconds = Number(h.oldest ?? 0)
	if (
		!Number.isFinite(ageXids) ||
		ageXids < 0 ||
		!Number.isFinite(oldestXactSeconds) ||
		oldestXactSeconds < 0
	) {
		throw new Error(`vacuum-horizon query returned invalid ages: ${JSON.stringify(h)}`)
	}
	return {
		ageXids,
		blockers: blockers.map((b) => {
			const seconds = Number(b.secs)
			if (!Number.isFinite(seconds) || seconds < 0) {
				throw new Error(`vacuum-horizon blocker ${b.pid} has invalid age ${b.secs}`)
			}
			return {
				db: b.db,
				pid: b.pid,
				query: b.q.replace(/\s+/g, " ").slice(0, 70),
				seconds,
			}
		}),
		oldestXactSeconds,
	}
}

/**
 * `VACUUM (VERBOSE)` a relation on a private connection with notices captured,
 * returning what the server actually said. The line that settles every bloat
 * argument is "N are dead but not yet removable".
 */
export async function vacuumVerbose(
	baseUrl: string,
	schema: string,
	relation: string,
): Promise<{ removed: number; notRemovable: number; remain: number; lines: string[] }> {
	const lines: string[] = []
	const conn = postgresFactory(baseUrl, {
		connection: { search_path: schema },
		max: 1,
		onnotice: (n) => lines.push(`${n.message ?? ""}`),
	})
	try {
		await conn.unsafe(`vacuum (verbose) ${relation}`)
	} finally {
		await conn.end()
	}
	const text = lines.join("\n")
	const m = text.match(
		/tuples: (\d+) removed, (\d+) remain, (\d+) are dead but not yet removable/,
	)
	if (m === null) {
		throw new Error(
			`VACUUM VERBOSE did not report tuple counts for ${relation}:\n${text}`,
		)
	}
	return {
		lines,
		notRemovable: Number(m[3]),
		remain: Number(m[2]),
		removed: Number(m[1]),
	}
}

/**
 * A porsager pool tagged with `application_name`, pointed at `schema`. Tagging is
 * what makes WAL and transaction-duration measurements ATTRIBUTABLE on a shared
 * instance: `pg_current_wal_lsn()` is cluster-wide and counts every other tenant's
 * writes, while `pg_stat_get_backend_wal` can be summed over just these backends.
 */
export function taggedPool(baseUrl: string, schema: string, app: string, max = 4): Sql {
	return postgresFactory(baseUrl, {
		connection: { application_name: app, search_path: schema },
		max,
		onnotice: () => {},
	})
}

/**
 * Force every backend of `sql`'s pool to publish its pending statistics.
 *
 * Postgres accumulates per-backend and per-relation stats locally and flushes
 * them at the END of a command cycle, and never more often than ~1s. An IDLE
 * backend therefore sits on the counters for the work it just did — so reading
 * `pg_stat_user_tables` or `pg_stat_get_backend_wal` right after a burst reports
 * a number from before the burst. Waiting past the interval and then driving one
 * trivial command through every pooled connection is what actually publishes them.
 */
export async function flushStats(sql: Sql, connections = 8): Promise<void> {
	await new Promise((r) => setTimeout(r, 1100))
	await Promise.all(Array.from({ length: connections }, () => sql`select 1`))
	await new Promise((r) => setTimeout(r, 250))
}

/** WAL bytes written by the backends of one `application_name` (PG 18+). */
export async function backendWal(sql: Sql, app: string): Promise<number> {
	const [r] = await sql<{ n: string }[]>`
		select coalesce(sum(w.wal_bytes), 0)::text as n
		from pg_stat_activity a, lateral pg_stat_get_backend_wal(a.pid) w
		where a.application_name = ${app}`
	if (r === undefined) throw new Error("backend WAL query returned no row")
	return Number(r.n)
}

/** WAL bytes generated so far (monotonic; deltas are the useful quantity). */
export async function walBytes(sql: Sql): Promise<number> {
	const [r] = await sql<{ n: string }[]>`
		select (pg_current_wal_lsn() - '0/0'::pg_lsn)::text as n`
	if (r === undefined) throw new Error("WAL position query returned no row")
	return Number(r.n)
}

/** Temp files + temp bytes for this database since stats reset. */
export async function tempStats(sql: Sql): Promise<{ files: number; bytes: number }> {
	const [r] = await sql<{ files: string; bytes: string }[]>`
		select temp_files::text as files, temp_bytes::text as bytes
		from pg_stat_database where datname = current_database()`
	if (r === undefined) throw new Error("temporary-file statistics returned no row")
	return { bytes: Number(r.bytes), files: Number(r.files) }
}

/** Physical size of the shared catalogs the temp-table pattern churns. */
export async function catalogSizes(
	sql: Sql,
): Promise<{ class: number; attribute: number; type: number; depend: number }> {
	const [r] = await sql<{ c: string; a: string; t: string; d: string }[]>`
		select pg_total_relation_size('pg_class')::text as c,
			pg_total_relation_size('pg_attribute')::text as a,
			pg_total_relation_size('pg_type')::text as t,
			pg_total_relation_size('pg_depend')::text as d`
	if (r === undefined) throw new Error("catalog-size query returned no row")
	return {
		attribute: Number(r.a),
		class: Number(r.c),
		depend: Number(r.d),
		type: Number(r.t),
	}
}

/** Raw per-index sizes, one row per physical index relation. */
export async function rawIndexSizes(
	sql: Sql,
	table: string,
): Promise<{ name: string; bytes: number; tuples: number }[]> {
	const rows = await sql<{ name: string; bytes: string; tuples: string }[]>`
		select i.relname as name, pg_relation_size(i.oid)::text as bytes,
			i.reltuples::text as tuples
		from pg_class i
			join pg_index x on x.indexrelid = i.oid
			join pg_class t on t.oid = x.indrelid
			join pg_namespace n on n.oid = t.relnamespace
		where n.nspname = current_schema()
			and (t.relname = ${table} or t.relname like ${`${table}\\_p%`})
		order by 1`
	return rows.map((r) => ({
		bytes: Number(r.bytes),
		name: r.name,
		tuples: Number(r.tuples),
	}))
}

/** `VACUUM (ANALYZE)` a logical table (recurses into partitions). */
export async function vacuumAnalyze(sql: Sql, table: string): Promise<void> {
	await sql.unsafe(`vacuum (analyze) ${table}`)
}

/** `VACUUM FULL` — the compaction floor: what only a rewrite could reclaim. */
export async function vacuumFull(sql: Sql, table: string): Promise<void> {
	await sql.unsafe(`vacuum (full, analyze) ${table}`)
}

// ---------------------------------------------------------------------------
// git-side fixtures
// ---------------------------------------------------------------------------

export function scratchRoot(tag: string): {
	dir: (name: string) => string
	root: string
	cleanup: () => void
} {
	const root = mkdtempSync(join(tmpdir(), `pggit-bloat-${tag}-`))
	return {
		cleanup: () => rmSync(root, { force: true, recursive: true }),
		dir: (name: string) => join(root, name),
		root,
	}
}

export function filler(salt: string, len: number): string {
	let out = ""
	while (out.length < len) {
		out += createHash("sha1").update(`${salt}-${out.length}`).digest("hex")
	}
	return out.slice(0, len)
}

export function runDirName(salt: string, i: number): string {
	const h = createHash("sha1").update(`${salt}-run-${i}`).digest("hex")
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** Total bytes under a directory (git's own on-disk cost). */
export async function duBytes(dir: string): Promise<number> {
	let total = 0
	const walk = async (d: string): Promise<void> => {
		for (const e of await readdir(d, { withFileTypes: true })) {
			const p = join(d, e.name)
			if (e.isDirectory()) await walk(p)
			else if (e.isFile()) total += statSync(p).size
		}
	}
	await walk(dir)
	return total
}

/** Every reachable object in a repo, in one `cat-file --batch`. */
export type Obj = {
	oid: string
	type: "blob" | "commit" | "tag" | "tree"
	content: Buffer
}

export async function reachableObjects(dir: string): Promise<Obj[]> {
	return loadGitObjects(dir, await gitReachableOids(dir))
}

/**
 * Objects reachable from `rev`, minus those reachable from `exclude` if given —
 * i.e. exactly what one push carries. Shared by every harness that ingests a
 * history incrementally rather than all at once.
 */
export async function objectsBetween(
	dir: string,
	rev: string,
	exclude?: string,
): Promise<Obj[]> {
	return loadReachableObjects(dir, [rev, ...(exclude ? [`^${exclude}`] : [])])
}

// ---------------------------------------------------------------------------
// Operator diagnostics — UTILITIES, not harnesses. Neither measures pggit; both
// answer "is this instance in a state where a bloat number means anything?", and
// they are read-only against `pg_stat_activity`. Call them from a scratch script
// or a REPL when a harness reports a pinned horizon.
// ---------------------------------------------------------------------------

/**
 * UTILITY (was `breakage/_bloat_horizon_gate.ts`). True when the cluster vacuum
 * horizon is free; false while a long transaction pins it. Run this BEFORE a bloat
 * harness: under a pinned horizon every reclaim number is a lower bound.
 */
export async function horizonGate(baseUrl = DEFAULT_PG_URL): Promise<boolean> {
	const pg = postgresFactory(baseUrl, { max: 1, onnotice: () => {} })
	try {
		const h = await horizon(pg)
		console.log(
			`horizon lag ${h.ageXids} xids, oldest open client xact ${h.oldestXactSeconds.toFixed(0)}s, ` +
				`${h.blockers.length} blocker(s)`,
		)
		return h.ageXids <= 5000
	} finally {
		await pg.end()
	}
}

/**
 * UTILITY (was `breakage/_bloat_who_holds_xmin.ts`). Identify the cluster-wide
 * xmin holder — which pid, in which database, running what, for how long.
 * Read-only.
 */
export async function whoHoldsXmin(baseUrl = DEFAULT_PG_URL): Promise<void> {
	const pg = postgresFactory(baseUrl, { max: 1, onnotice: () => {} })
	try {
		const rows = await pg<
			{
				pid: number
				datname: string | null
				usename: string | null
				app: string | null
				state: string | null
				xmin: string | null
				xid: string | null
				xact_age: string | null
				state_age: string | null
				q: string | null
			}[]
		>`
			select pid, datname, usename, application_name as app, state,
				backend_xmin::text as xmin, backend_xid::text as xid,
				(now() - xact_start)::text as xact_age,
				(now() - state_change)::text as state_age,
				left(query, 80) as q
			from pg_stat_activity
			where backend_type = 'client backend'
			order by xact_start nulls last, pid`
		for (const r of rows) {
			console.log(
				`pid=${String(r.pid).padEnd(6)} db=${(r.datname ?? "-").padEnd(26)} state=${(r.state ?? "-").padEnd(20)} ` +
					`xmin=${(r.xmin ?? "-").padEnd(8)} xid=${(r.xid ?? "-").padEnd(8)} xact=${(r.xact_age ?? "-").padEnd(18)} ` +
					`app=${(r.app ?? "-").slice(0, 20)}`,
			)
			if (r.xact_age && !r.xact_age.startsWith("00:00:0")) {
				console.log(`        q: ${r.q}`)
			}
		}

		const [h] = await pg<
			{
				snap: string
				oldest: string | null
				slots: string
				prep: string
				frozen: string
			}[]
		>`
			select pg_snapshot_xmin(pg_current_snapshot())::text as snap,
				(select min(age(backend_xmin))::text from pg_stat_activity where backend_xmin is not null) as oldest,
				(select count(*)::text from pg_replication_slots) as slots,
				(select count(*)::text from pg_prepared_xacts) as prep,
				(select max(age(datfrozenxid))::text from pg_database) as frozen`
		if (!h) throw new Error("xmin-holder summary query returned no row")
		console.log(
			"\nsnapshot xmin:",
			h.snap,
			"| min backend_xmin age:",
			h.oldest,
			"| slots:",
			h.slots,
			"| prepared:",
			h.prep,
			"| max datfrozenxid age:",
			h.frozen,
		)

		const maxAge = await pg<
			{ pid: number; datname: string | null; age: string; state: string | null }[]
		>`
			select pid, datname, age(backend_xmin)::text as age, state from pg_stat_activity
			where backend_xmin is not null order by age(backend_xmin) desc limit 5`
		console.log("\nlargest backend_xmin ages:", maxAge)
	} finally {
		await pg.end()
	}
}

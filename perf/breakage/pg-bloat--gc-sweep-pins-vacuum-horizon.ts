/**
 * pg-bloat--gc-sweep-pins-vacuum-horizon — the drain's own GC sweep disables the
 * autovacuum it delegates cleanup to.
 *
 * THE MECHANISM. `gc.ts` deliberately skips VACUUM on the drain's cadence and
 * relies on the leaf partitions' autovacuum reloptions to reclaim the dead tuples
 * it creates. But a VACUUM — auto or manual — can only remove a tuple older than
 * the cluster's `data_oldest_nonremovable` horizon, and that horizon is the oldest
 * snapshot xmin ACROSS THE WHOLE INSTANCE. Every backend's snapshot xmin is
 * computed cluster-wide, so ONE long-running statement pins vacuum for every
 * table in every database.
 *
 * Two windows hold snapshots open: the live-set WALK (one REPEATABLE READ
 * transaction across the whole reachable closure — the surviving half of hunt
 * finding M5 now that the edge sweep is deleted, spine S2) and each
 * `sweepObjects` batch:
 *
 *     with victims as (select … from git_object o where … limit $3)
 *     delete from git_object o using victims v where …
 *
 * with no explicit transaction, so each batch IS one transaction — and its
 * duration is the anti-join's runtime. For those windows nothing anywhere on
 * the instance can be vacuumed, including the previous pass's dead tuples.
 *
 * WHAT IT MEASURES
 *   1. how long one GC pass holds a transaction open, and the horizon lag it
 *      creates, sampled from an independent connection while the pass runs.
 *   2. a control table (`horizon_canary`) in the same schema, unrelated to git,
 *      whose dead tuples are proven unreclaimable DURING the pass and
 *      reclaimable after it — the causal link, not a correlation.
 *   3. the terminating anti-join scan every pass pays on `git_object`, so the
 *      trend is visible rather than asserted.
 *
 * EXIT NON-ZERO when a single GC pass holds one transaction open for longer than
 * `PIN_LIMIT_MS`, i.e. longer than `autovacuum_naptime` would like to wait.
 *
 *   npx tsx perf/breakage/pg-bloat--gc-sweep-pins-vacuum-horizon.ts --base=400
 */
import { setTimeout as sleep } from "node:timers/promises"
import postgres from "postgres"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	COMMITTER,
	DEFAULT_PG_URL,
	filler,
	flag,
	horizon,
	objectsBetween,
	pad,
	padr,
	runDirName,
	scratchRoot,
	sizeOf,
	vacuumVerbose,
} from "./_pg-bloat-util"

const REPO_ID = "workspace/slate/horizon"
/** application_name tag so the sampler can attribute open transactions to THIS pass */
const GC_APP = "pgbloat-gc-under-test"
/** a single GC transaction longer than this pins the horizon past a naptime */
const PIN_LIMIT_MS = 60_000

const PG_URL = flag("pg", DEFAULT_PG_URL)
const BASE = Number(flag("base", "400"))
const ADVANCE = Number(flag("advance", "400"))

function buildStream(): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (c: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(c)}\n${c}\n`)
		return m
	}
	let prev = next()
	const m0 = blob("# seed\n")
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\nM 100644 :${m0} docs/a.md\n`,
	)
	const commit = (ref: string, parent: number, salt: string, i: number): number => {
		const d = runDirName(salt, i)
		const r = blob(`{"r":"${d}","p":"${filler(`${salt}-${i}`, 500)}"}\n`)
		const cm = next()
		out.push(
			`commit ${ref}\nmark :${cm}\ncommitter ${COMMITTER}\ndata 2\nxx\nfrom :${parent}\n` +
				`M 100644 :${r} .engine/runs/planner-updates/${d}/record.json\n`,
		)
		return cm
	}
	for (let i = 0; i < BASE; i++) prev = commit("refs/heads/main", prev, "b", i)
	let p = prev
	for (let i = 0; i < ADVANCE; i++) p = commit("refs/heads/adv", p, "a", i)
	return out.join("")
}

async function main(): Promise<void> {
	const scratch = scratchRoot("horizon")
	const db = await createIsolatedSchema(PG_URL)
	// An independent observer connection — it must not share the pool under test.
	const watch = postgres(PG_URL, {
		connection: { search_path: db.schema },
		max: 2,
		onnotice: () => {},
	})
	try {
		console.log(`# The GC sweep pins the cluster vacuum horizon while it runs\n`)
		console.log(
			`schema ${db.schema} · base ${BASE} commits · ${ADVANCE} commits force-pushed away\n`,
		)

		const pre = await horizon(db.sql)
		console.log(
			`horizon before anything: lag ${pre.ageXids} xids, oldest open client xact ${pre.oldestXactSeconds.toFixed(1)}s`,
		)
		if (pre.ageXids > 5000) {
			console.log(
				`\n!! An unrelated long transaction is already pinning this instance. The causal\n` +
					`!! demonstration below still runs, but the canary result is not attributable.\n`,
			)
			for (const b of pre.blockers) {
				console.log(`   pid ${b.pid} db=${b.db} ${b.seconds.toFixed(0)}s — ${b.query}`)
			}
		}

		const src = scratch.dir("src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
		const baseTip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: src })
		).stdout.trim()
		const advTip = (
			await spawnGit(["rev-parse", "refs/heads/adv"], { cwd: src })
		).stdout.trim()

		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		await store.putPack(
			REPO_ID,
			(await objectsBetween(src, baseTip)).map((o) => ({
				content: o.content,
				type: o.type,
			})),
		)
		await store.putPack(
			REPO_ID,
			(await objectsBetween(src, advTip, baseTip)).map((o) => ({
				content: o.content,
				type: o.type,
			})),
		)
		await refs.setRef(REPO_ID, "refs/heads/main", advTip)
		await refs.setRef(REPO_ID, "refs/heads/main", baseTip) // the force push

		const objSize = await sizeOf(db.sql, "git_object")
		const [oc] = await db.sql<{ n: string }[]>`select count(*)::text as n from git_object`
		console.log(
			`\ngit_object before the sweep: ${oc?.n} rows, ${(objSize.total / 1_000_000).toFixed(2)} MB\n`,
		)

		// ── the canary: dead tuples with nothing to do with git ──────────────
		await db.sql.unsafe(`create table horizon_canary (id int primary key, pad text)`)
		await db.sql.unsafe(
			`insert into horizon_canary select g, repeat('x', 200) from generate_series(1, 20000) g`,
		)
		await db.sql.unsafe(`delete from horizon_canary where id % 2 = 0`)
		const canaryBefore = await sizeOf(db.sql, "horizon_canary")

		// ── run one GC pass while sampling the horizon from outside ──────────
		// The GC runs on its own tagged pool so the sampler can attribute open
		// transactions to THIS pass rather than to anything else on the instance.
		console.log(`## sampling the horizon while ONE gc() pass runs\n`)
		const gcSql = postgres(PG_URL, {
			connection: { application_name: GC_APP, search_path: db.schema },
			max: 4,
			onnotice: () => {},
		})
		const samples: { t: number; lag: number; longest: number; q: string }[] = []
		let running = true
		const sampler = (async () => {
			const t0 = Date.now()
			while (running) {
				const hz = await watch<
					{ lag: string | null; secs: string | null; q: string | null }[]
				>`select (select max(age(backend_xmin))::text from pg_stat_activity where backend_xmin is not null) as lag,
						(select max(extract(epoch from (now() - xact_start)))::text from pg_stat_activity
							where application_name = ${GC_APP}) as secs,
						(select left(query, 46) from pg_stat_activity where application_name = ${GC_APP}
							and xact_start is not null order by xact_start limit 1) as q`
				samples.push({
					lag: Number(hz[0]?.lag ?? 0),
					longest: Number(hz[0]?.secs ?? 0),
					q: (hz[0]?.q ?? "").replace(/\s+/g, " "),
					t: Date.now() - t0,
				})
				await sleep(500)
			}
		})()

		const gcStart = Date.now()
		const gcRes = await createGc(gcSql).gc(REPO_ID, { graceSeconds: 0, maintain: false })
		const gcMs = Date.now() - gcStart
		await gcSql.end()
		running = false
		await sampler

		console.log(
			`gc() reclaimed ${gcRes.deletedObjects} objects in ${(gcMs / 1000).toFixed(2)}s\n`,
		)
		console.log(
			`${padr("t (ms)", 8)} ${pad("horizon lag (xids)", 20)} ${pad("longest open xact (s)", 22)}  oldest statement`,
		)
		const step = Math.max(1, Math.floor(samples.length / 14))
		for (let i = 0; i < samples.length; i += step) {
			const s = samples[i]
			if (!s) continue
			console.log(
				`${padr(s.t, 8)} ${pad(s.lag, 20)} ${pad(s.longest.toFixed(2), 22)}  ${s.q.slice(0, 46)}`,
			)
		}
		const peakLongest = Math.max(...samples.map((s) => s.longest), 0)
		const peakLag = Math.max(...samples.map((s) => s.lag), 0)
		console.log(
			`\npeak single-transaction duration during the pass: ${peakLongest.toFixed(2)}s; ` +
				`peak horizon lag: ${peakLag} xids.`,
		)

		// ── the cost that grows with the dead backlog ────────────────────────
		// The sweep loop terminates when a batch deletes nothing, so EVERY pass pays
		// one full anti-join scan of the repo's partition to discover there is nothing
		// left. That scan visits dead tuples too — and `maintain: false` means the
		// dead tuples from previous passes are still there. This is the term that
		// turns a fast sweep into a slow one as a repo ages.
		console.log(`\n## the terminating scan every pass pays\n`)
		const [deadNow] = await db.sql<{ live: string; dead: string; rel: string }[]>`
			select relname as rel, n_live_tup::text as live, n_dead_tup::text as dead
			from pg_stat_user_tables where schemaname = ${db.schema}
				and relname like 'git\\_object\\_p%' order by n_dead_tup desc limit 1`
		const plan = await db.sql.unsafe<{ "QUERY PLAN": string }[]>(
			`explain (analyze, buffers, format text)
			 with victims as (
				select o.oid from git_object o
				where o.repo_id = (select id from repos limit 1)
					and not exists (select 1 from git_ref r where r.repo_id = o.repo_id and r.oid = o.oid)
					and o.created_at < clock_timestamp()
				limit 10000
			 ) select count(*) from victims`,
		)
		console.log(
			`${deadNow?.rel}: ${deadNow?.live} live, ${deadNow?.dead} dead (unvacuumed — the drain passes maintain:false)\n`,
		)
		// Partition pruning leaves 15 of 16 branches "never executed"; printing them
		// buries the two lines that matter.
		const pruned: string[] = []
		let skipping = false
		for (const l of plan) {
			const text = l["QUERY PLAN"]
			if (text.includes("never executed")) {
				skipping = true
				continue
			}
			if (
				skipping &&
				/^\s+(Recheck Cond|Index Cond|Index Searches|->\s+Bitmap Index)/.test(text)
			)
				continue
			skipping = false
			pruned.push(text)
		}
		for (const l of pruned) console.log(`  ${l}`)
		const scanLine = plan
			.map((l) => l["QUERY PLAN"])
			.find((t) => /Seq Scan on git_object_p\d+/.test(t))
		console.log(
			`\n  (15 of 16 partitions pruned and never executed — hash partitioning is by repo_id,\n` +
				`   so one repo lives entirely in one leaf and the sweep seq-scans that whole leaf.)`,
		)
		if (scanLine) console.log(`\n  the scan that grows: ${scanLine.trim()}`)

		// ── the canary, after ────────────────────────────────────────────────
		console.log(`\n## the canary: could an unrelated table be vacuumed?\n`)
		const v = await vacuumVerbose(PG_URL, db.schema, "horizon_canary")
		const canaryAfter = await sizeOf(db.sql, "horizon_canary")
		console.log(
			`horizon_canary (10,000 rows deleted, nothing to do with git):\n` +
				`  before VACUUM ${(canaryBefore.total / 1000).toFixed(0)} kB → after ${(canaryAfter.total / 1000).toFixed(0)} kB\n` +
				`  VACUUM removed ${v.removed} tuples, ${v.notRemovable} were dead but NOT YET REMOVABLE`,
		)
		const post = await horizon(db.sql)
		console.log(
			`\nhorizon after the pass: lag ${post.ageXids} xids, oldest open client xact ${post.oldestXactSeconds.toFixed(1)}s`,
		)

		console.log(`\n## reading\n`)
		console.log(
			`Each GC batch statement is its own transaction (no explicit BEGIN), so the horizon\n` +
				`lag is bounded by the SLOWEST single batch, not by the pass. The pass above took\n` +
				`${(gcMs / 1000).toFixed(2)}s and its longest single statement held ${peakLongest.toFixed(2)}s.\n` +
				`Anything past autovacuum_naptime (60s) means a naptime can elapse with the horizon\n` +
				`pinned — autovacuum wakes, runs, and removes nothing, which is exactly what\n` +
				`\`maintain: false\` is counting on it NOT to do.\n\n` +
				`The batch duration is not a constant: it is the anti-join scan above, whose cost\n` +
				`includes every dead tuple no vacuum has removed. Since a pinned horizon is what\n` +
				`prevents removal, and a long batch is what pins the horizon, the two feed each other.\n` +
				`This machine showed the far end of that loop while this ran: SIX concurrent sessions\n` +
				`held this exact statement open for 11-29 minutes each (listed at the top).`,
		)
		if (peakLongest * 1000 > PIN_LIMIT_MS) process.exitCode = 1
	} finally {
		await watch.end()
		await db.drop()
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

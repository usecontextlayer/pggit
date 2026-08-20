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
 * Two windows hold snapshots open: the live plan's `originClosure` walk (one
 * REPEATABLE READ transaction across the reachable closure, spine S2/S6) and each
 * `sweepObjects` batch against the pass-local `gc_live` TEMP table:
 *
 *     with victims as (select … from git_object o where not exists
 *       (select 1 from gc_live l where l.oid = o.oid) … limit $3)
 *     delete from git_object o using victims v where …
 *
 * with no explicit transaction, so each batch IS one transaction — and its
 * duration is the anti-join's runtime. For those windows nothing anywhere on
 * the instance can be vacuumed, including the previous pass's dead tuples.
 *
 * WHAT IT MEASURES
 *   1. how long one GC pass holds a transaction open, and the horizon lag it
 *      creates, sampled from an independent connection while the pass runs.
 *
 * EXIT NON-ZERO when a single GC pass holds one transaction open for longer than
 * `PIN_LIMIT_MS`, i.e. longer than `autovacuum_naptime` would like to wait.
 *
 *   npx tsx perf/breakage/pg-bloat--gc-sweep-pins-vacuum-horizon.ts --base=400
 */
import { setTimeout as sleep } from "node:timers/promises"
import postgres from "postgres"
import { z } from "zod"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { assertCanonicalStoreFixture, revParse } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { parseArgs, pgUrlArg, positiveIntegerArg } from "../args"
import {
	COMMITTER,
	filler,
	horizon,
	objectsBetween,
	pad,
	padr,
	runDirName,
	scratchRoot,
	sizeOf,
} from "./_pg-bloat-util"

const REPO_ID = "workspace/slate/horizon"
/** application_name tag so the sampler can attribute open transactions to THIS pass */
const GC_APP = "pgbloat-gc-under-test"
/** a single GC transaction longer than this pins the horizon past a naptime */
const PIN_LIMIT_MS = 60_000

const {
	advance: ADVANCE,
	base: BASE,
	pg: PG_URL,
} = parseArgs(
	z
		.object({
			advance: positiveIntegerArg.default(400),
			base: positiveIntegerArg.default(400),
			pg: pgUrlArg,
		})
		.strict(),
)

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
			throw new Error(
				`vacuum horizon is already pinned by ${pre.ageXids} xids; this run would not be attributable`,
			)
		}

		const src = scratch.dir("src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
		const baseTip = await revParse(src, "refs/heads/main")
		const advTip = await revParse(src, "refs/heads/adv")

		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const baseObjects = await objectsBetween(src, baseTip)
		const advanceObjects = await objectsBetween(src, advTip, baseTip)
		if (baseObjects.length === 0 || advanceObjects.length === 0) {
			throw new Error("GC fixture did not produce nonempty base and advance object sets")
		}
		await store.putPack(
			REPO_ID,
			baseObjects.map((o) => ({
				content: o.content,
				type: o.type,
			})),
		)
		await store.putPack(
			REPO_ID,
			advanceObjects.map((o) => ({
				content: o.content,
				type: o.type,
			})),
		)
		await refs.setRef(REPO_ID, "refs/heads/main", advTip)
		await refs.setSymref(REPO_ID, "HEAD", "refs/heads/main")
		await refs.setRef(REPO_ID, "refs/heads/main", baseTip) // the force push

		const objSize = await sizeOf(db.sql, "git_object")
		const [oc] = await db.sql<{ n: string }[]>`select count(*)::text as n from git_object`
		const expectedBeforeObjects = [...baseObjects, ...advanceObjects]
		if (!oc || Number(oc.n) !== expectedBeforeObjects.length || objSize.total <= 0) {
			throw new Error(
				`pre-GC fixture census mismatch: rows=${oc?.n ?? "missing"}/${expectedBeforeObjects.length}, bytes=${objSize.total}`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "unchecked" },
			objects: expectedBeforeObjects,
			refs: [
				{ kind: "direct", name: "refs/heads/main", oid: baseTip },
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			],
		})
		console.log(
			`\ngit_object before the sweep: ${oc.n} rows, ${(objSize.total / 1_000_000).toFixed(2)} MB\n`,
		)

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
				const [sample] = hz
				if (!sample) throw new Error("GC horizon sampler returned no row")
				const lag = Number(sample.lag ?? 0)
				const longest = Number(sample.secs ?? 0)
				if (
					!Number.isFinite(lag) ||
					lag < 0 ||
					!Number.isFinite(longest) ||
					longest < 0
				) {
					throw new Error(
						`GC horizon sampler returned invalid ages: ${JSON.stringify(sample)}`,
					)
				}
				samples.push({
					lag,
					longest,
					q: (sample.q ?? "").replace(/\s+/g, " "),
					t: Date.now() - t0,
				})
				await sleep(500)
			}
		})()

		const gcStart = Date.now()
		let gcMs = 0
		let gcRes: Awaited<ReturnType<ReturnType<typeof createGc>["gc"]>>
		try {
			gcRes = await createGc(gcSql).gc(REPO_ID, { graceSeconds: 0, maintain: false })
			gcMs = Date.now() - gcStart
		} finally {
			running = false
			await sampler
			await gcSql.end()
		}
		if (gcRes.deletedObjects !== advanceObjects.length) {
			throw new Error(
				`GC deleted ${gcRes.deletedObjects}/${advanceObjects.length} orphaned objects`,
			)
		}
		const [remaining] = await db.sql<{ n: string; tip: string }[]>`
			select count(*)::text as n,
				(select encode(oid, 'hex') from git_ref where name = 'refs/heads/main') as tip
			from git_object`
		if (
			!remaining ||
			Number(remaining.n) !== baseObjects.length ||
			remaining.tip !== baseTip
		) {
			throw new Error(
				`post-GC state mismatch: ${JSON.stringify(remaining)}, expected ${baseObjects.length}/${baseTip}`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "unchecked" },
			objects: baseObjects,
			refs: [
				{ kind: "direct", name: "refs/heads/main", oid: baseTip },
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			],
		})

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
		const observedGcQuery = samples.some((sample) =>
			/gc_live|git_(object|ref|commit|tag)/.test(sample.q),
		)
		if (samples.length === 0 || gcMs <= 0 || peakLongest <= 0 || !observedGcQuery) {
			throw new Error(
				`GC transaction sampler missed the measured work: samples=${samples.length}, wall=${gcMs}, longest=${peakLongest}, observedQuery=${observedGcQuery}`,
			)
		}
		console.log(
			`\npeak single-transaction duration during the pass: ${peakLongest.toFixed(2)}s; ` +
				`peak horizon lag: ${peakLag} xids.`,
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
				`The measured hold belongs to this harness's tagged GC connection; the run refuses\n` +
				`to score when an unrelated transaction already pins the horizon.`,
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

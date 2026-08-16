/**
 * pg-bloat--copy-staging-catalog-churn — what the COPY staging pattern costs the
 * SHARED system catalogs.
 *
 * Every bulk insert in pggit goes through `copyInsert`, and every `copyInsert`
 * call executes `create temp table copy_stg_<target> on commit drop as select …`.
 * Creating a relation writes rows into `pg_class`, `pg_type` (a composite type and
 * its array type), `pg_attribute` (one per column), `pg_depend` and friends —
 * plus a TOAST relation and its index when any column is toastable, which
 * `content`/`data` always are. `ON COMMIT DROP` then deletes all of them. Net row
 * count zero; dead tuples and WAL, not zero.
 *
 * Those catalogs belong to the DATABASE, not to pggit's schema. So this churn is
 * charged to every other schema in the same database, and it is vacuumed under the
 * DEFAULT autovacuum policy — precisely the policy pggit overrides on its own
 * tables because it judged the default inadequate for its churn.
 *
 * The call volume is structural, not incidental: one `putPack` is 2 staging tables
 * (objects + edges); one `repo_file` rebuild is 1; one repack pass is one per
 * `WRITE_BATCH` = 1000 encodings; one GC pass is one per `LIVE_LOAD_BATCH` =
 * 10,000 live OIDs.
 *
 * MEASUREMENT DISCIPLINE. Catalog row counts and catalog file sizes on a shared
 * instance move for reasons that have nothing to do with pggit (any other session
 * creating a schema writes hundreds of `pg_class` rows). So the per-flush cost
 * here is measured as WAL charged to a TAGGED backend, against a control loop of
 * identical shape that creates no table — the difference is attributable.
 *
 * EXIT NON-ZERO when the staging hop accounts for more than `SHARE_LIMIT` of the
 * workload's WAL. A per-flush byte count on its own is not a defect criterion —
 * what matters is whether the bookkeeping is a material fraction of the work.
 *
 *   npx tsx perf/breakage/pg-bloat--copy-staging-catalog-churn.ts --commits=600
 */
import { syncRefSnapshot } from "@/repo-view/rebuild"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	backendWal,
	COMMITTER,
	catalogSizes,
	DEFAULT_PG_URL,
	filler,
	flag,
	flushStats,
	kb,
	mb,
	objectsBetween,
	pad,
	padr,
	runDirName,
	scratchRoot,
	taggedPool,
	tempStats,
} from "./_pg-bloat-util"

/** share of a workload's WAL that the staging bookkeeping may take before it is a defect */
const SHARE_LIMIT = 0.05
const STG_APP = "pgbloat-staging-under-test"
const PUSH_APP = "pgbloat-staging-push"
/** iterations in the isolated per-flush cost loop */
const LOOP = 200

const PG_URL = flag("pg", DEFAULT_PG_URL)
const COMMITS = Number(flag("commits", "600"))
const PUSH_BATCH = Number(flag("batch", "10"))
const REPO_ID = "workspace/slate/staging"

function buildStream(): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (c: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(c)}\n${c}\n`)
		return m
	}
	const seeded: string[] = []
	for (let i = 0; i < 40; i++) {
		const m = blob(`# doc ${i}\n${filler(`d${i}`, 500)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	for (let i = 0; i < COMMITS; i++) {
		const dir = runDirName("stg", i)
		const record = blob(`{"run":"${dir}","p":"${filler(`rec-${i}`, 600)}"}\n`)
		const cm = next()
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata 2\nxx\nfrom :${prev}\n` +
				`M 100644 :${record} .engine/runs/planner-updates/${dir}/record.json\n`,
		)
		prev = cm
	}
	return out.join("")
}

async function main(): Promise<void> {
	const scratch = scratchRoot("stg")
	const db = await createIsolatedSchema(PG_URL)
	const stg = taggedPool(PG_URL, db.schema, STG_APP, 1)
	const app = taggedPool(PG_URL, db.schema, PUSH_APP)
	try {
		console.log(`# COPY-staging catalog churn (one temp table per bulk flush)\n`)
		console.log(`schema ${db.schema}\n`)

		// ── 1. the per-staging-table cost, isolated against a control ───────
		console.log(`## 1. one staging table, measured against a control of the same shape\n`)

		// Control: LOOP transactions that do everything except create the table.
		await flushStats(stg, 2)
		const ctrl0 = await backendWal(db.sql, STG_APP)
		for (let i = 0; i < LOOP; i++) {
			await stg.begin(async (tx) => {
				await tx.unsafe(`select 1`)
			})
		}
		await flushStats(stg, 2)
		const ctrlWal = (await backendWal(db.sql, STG_APP)) - ctrl0

		// The real thing: exactly copy-insert.ts's statement, no rows copied, so
		// what is measured is the staging hop alone and not the payload.
		const stg0 = await backendWal(db.sql, STG_APP)
		for (let i = 0; i < LOOP; i++) {
			await stg.begin(async (tx) => {
				await tx.unsafe(
					`create temp table copy_stg_git_object on commit drop as ` +
						`select repo_id, oid, type, size, content from git_object with no data`,
				)
			})
		}
		await flushStats(stg, 2)
		const stgWal = (await backendWal(db.sql, STG_APP)) - stg0

		// The catalog rows a staging table holds while it lives.
		const inTx = await stg.begin(async (tx) => {
			await tx.unsafe(
				`create temp table copy_stg_probe on commit drop as ` +
					`select repo_id, oid, type, size, content from git_object with no data`,
			)
			return await tx<{ rels: string; atts: string }[]>`
				select (select count(*) from pg_class where relnamespace =
						(select oid from pg_namespace where nspname like 'pg_temp%' and oid = (select relnamespace from pg_class where relname = 'copy_stg_probe')))::text as rels,
					(select count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid
						where c.relname = 'copy_stg_probe')::text as atts`
		})

		const perFlush = (stgWal - ctrlWal) / LOOP
		console.log(`${padr("loop", 42)} ${pad("WAL bytes", 12)} ${pad("per iteration", 14)}`)
		console.log(
			`${padr(`control: BEGIN; select 1; COMMIT × ${LOOP}`, 42)} ${pad(ctrlWal, 12)} ${pad((ctrlWal / LOOP).toFixed(0), 14)}`,
		)
		console.log(
			`${padr(`staging: copy-insert's CREATE TEMP × ${LOOP}`, 42)} ${pad(stgWal, 12)} ${pad((stgWal / LOOP).toFixed(0), 14)}`,
		)
		console.log(
			`${padr("attributable to the staging hop", 42)} ${pad(stgWal - ctrlWal, 12)} ${pad(perFlush.toFixed(0), 14)}`,
		)
		console.log(
			`\nA staging table carries ${inTx[0]?.rels} relations in its temp namespace and ` +
				`${inTx[0]?.atts} pg_attribute rows,\nall created and dropped inside the flush's transaction.\n`,
		)

		// ── 2. how many flushes a realistic workload performs ───────────────
		const src = scratch.dir("src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
		const commits = (
			await spawnGit(["rev-list", "--reverse", "refs/heads/main"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
			.filter(Boolean)

		const store = createObjectStore(app)
		const refs = createRefStore(app)
		const snapshots = createRepoFileProjection(app)
		const deps = { objects: store, snapshots }

		console.log(`## 2. flush volume of a realistic push/repack workload\n`)
		const catBefore = await catalogSizes(db.sql)
		const tmpBefore = await tempStats(db.sql)
		await flushStats(app)
		const pushWal0 = await backendWal(db.sql, PUSH_APP)

		let flushes = 0
		let prev = commits[0] as string
		await store.putPack(
			REPO_ID,
			(await objectsBetween(src, prev)).map((o) => ({
				content: o.content,
				type: o.type,
			})),
		)
		flushes += 2
		await refs.setRef(REPO_ID, "refs/heads/main", prev)
		await syncRefSnapshot(deps, REPO_ID, "refs/heads/main", prev)
		flushes += 1

		for (let i = 1; i < commits.length; i += PUSH_BATCH) {
			const tip = commits[Math.min(i + PUSH_BATCH - 1, commits.length - 1)] as string
			await store.putPack(
				REPO_ID,
				(await objectsBetween(src, tip, prev)).map((o) => ({
					content: o.content,
					type: o.type,
				})),
			)
			flushes += 2
			await refs.setRef(REPO_ID, "refs/heads/main", tip)
			await syncRefSnapshot(deps, REPO_ID, "refs/heads/main", tip)
			flushes += 1
			prev = tip
		}
		const repackRes = await createRepack(app).repack(REPO_ID)
		const repackFlushes = Math.ceil((repackRes.wholes + repackRes.deltas) / 1000)
		flushes += repackFlushes

		await flushStats(app)
		const pushWal = (await backendWal(db.sql, PUSH_APP)) - pushWal0
		const catAfter = await catalogSizes(db.sql)
		const tmpAfter = await tempStats(db.sql)
		const pushes = Math.ceil((commits.length - 1) / PUSH_BATCH) + 1

		console.log(
			`${pushes} pushes (${COMMITS} commits in batches of ${PUSH_BATCH}) + 1 repack ` +
				`(${repackRes.wholes + repackRes.deltas} encodings, ${repackFlushes} write batches)\n` +
				`  → ${flushes} staging tables created and dropped\n`,
		)
		console.log(`${padr("quantity", 46)} ${pad("value", 14)}`)
		console.log(
			`${padr("staging tables per push (objects+edges+repo_file)", 46)} ${pad(3, 14)}`,
		)
		console.log(`${padr("staging tables total", 46)} ${pad(flushes, 14)}`)
		console.log(
			`${padr("WAL attributable to staging (est.)", 46)} ${pad(`${kb(perFlush * flushes)} kB`, 14)}`,
		)
		console.log(
			`${padr("WAL for the whole workload (measured)", 46)} ${pad(`${mb(pushWal)} MB`, 14)}`,
		)
		console.log(
			`${padr("staging share of the workload's WAL", 46)} ${pad(`${(((perFlush * flushes) / Math.max(pushWal, 1)) * 100).toFixed(2)}%`, 14)}`,
		)
		console.log(
			`\ntemp files spilled DATABASE-WIDE in the same window: ${tmpAfter.files - tmpBefore.files} ` +
				`(${mb(tmpAfter.bytes - tmpBefore.bytes)} MB).\n` +
				`pg_stat_database is per-database, not per-session, so on a shared instance this is NOT\n` +
				`attributable to pggit. Reported because it is the only temp-spill signal available.`,
		)
		console.log(
			`\ncatalog file growth over the same window: pg_class ${kb(catAfter.class - catBefore.class)} kB, ` +
				`pg_attribute ${kb(catAfter.attribute - catBefore.attribute)} kB, ` +
				`pg_type ${kb(catAfter.type - catBefore.type)} kB, pg_depend ${kb(catAfter.depend - catBefore.depend)} kB.\n` +
				`NOT attributable on a shared instance — any other session creating a schema writes\n` +
				`hundreds of pg_class rows. Quoted only to show the catalogs are a contended resource.`,
		)
		console.log(
			`\nreading: at ${perFlush.toFixed(0)} bytes of WAL per staging table this is a real but SMALL\n` +
				`cost against a push that writes megabytes — it is a "document it" item, not a defect,\n` +
				`until flush counts rise (a backfill repack of a 5k-commit repo is ~14 flushes, a GC pass\n` +
				`over a 100k-object repo is ~10). The part worth watching is not WAL but that the rows\n` +
				`land in DATABASE-WIDE catalogs running the default autovacuum policy.`,
		)
		if ((perFlush * flushes) / Math.max(pushWal, 1) > SHARE_LIMIT) process.exitCode = 1
	} finally {
		await stg.end()
		await app.end()
		await db.drop()
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

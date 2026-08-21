/**
 * pg-bloat/force-push-churn — what the candidate GC→repack maintenance sequence
 * costs under repeated force-push churn.
 *
 * THE CLAIM UNDER TEST. `gc.ts` skips VACUUM/REINDEX on the drain's hot cadence
 * ("autovacuum reclaims the GC churn instead"), and 0005/0008 tune every leaf
 * partition for that: `autovacuum_vacuum_scale_factor = 0.02` with
 * `autovacuum_vacuum_threshold = 1000`. Those two numbers are the ONLY defence
 * the hot path has. They are evaluated PER PHYSICAL RELATION. Hash partitioning
 * is by `repo_id`, so one repo's churn lands in one occupied leaf; that leaf's
 * threshold, not a fictitious D/16 spread, is the relevant defense.
 *
 * THE WORKLOAD. Each round is one force-push cycle, the exact shape pggit's
 * motivating tenant produces: advance `refs/heads/main` by ADVANCE commits (real
 * objects ingested through the real store), rewrite the ref through the internal
 * platform API to the previous tip (the smart-HTTP wire denies rewinds), then run
 * `gc(graceSeconds: 0, maintain: false)` followed by `repack()`. The production GC
 * drain already chooses `maintain: false`; repack integration remains deferred, so
 * this harness invokes the intended engine-side sequence directly.
 *
 * WHAT IT PRINTS
 *   - per round: total/heap/toast/index bytes for all seven measured tables, dead tuples,
 *     and autovacuum_count for each.
 *   - the autovacuum eligibility arithmetic per leaf partition: dead vs
 *     threshold + scale_factor * live.
 *   - a settle window after the last round (autovacuum naptime is 60 s) so
 *     "autovacuum never fired" cannot be confused with "autovacuum had not run
 *     yet".
 *   - three sizes for every table: as the sequence leaves it, after a manual
 *     `VACUUM (ANALYZE)` (what `maintain: false` declines to run), and after
 *     `VACUUM FULL` (the compaction floor — what ONLY a rewrite reclaims).
 *
 * EXIT NON-ZERO when a table whose LIVE ROW COUNT is unchanged from the base push
 * occupies more than `BLOAT_THRESHOLD`× what it occupied then. A pinned vacuum
 * horizon makes that residue unattributable, so the harness aborts rather than
 * score any bloat ratio observed while reclamation was blocked.
 *
 *   npx tsx perf/probes/pg-bloat/force-push-churn.ts --rounds=40 --settle=180
 */
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs, pgUrlArg, positiveIntegerArg, positiveNumberArg } from "@perf/args"
import { vacuumVerbose } from "@perf/probes/_vacuum-evidence"
import {
	aggregate,
	horizon,
	mb,
	objectsBetween,
	pad,
	padr,
	rawIndexSizes,
	requiredCount,
	type Sizes,
	type Stat,
	scratchRoot,
	sizesAll,
	stats,
	TABLES,
	vacuumAnalyze,
	vacuumFull,
	walBytes,
} from "@perf/probes/pg-bloat/_util"
import { z } from "zod"
import { createRepoFileProjection } from "@/repo-file/projection"
import { syncRefProjection } from "@/repo-file/sync-ref"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import {
	deterministicFiller,
	FAST_IMPORT_COMMITTER,
	uuidFromSeed,
} from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	repackEligibleObjects,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO_ID = "workspace/slate/churn"

const {
	advance: ADVANCE,
	base: BASE,
	pg: PG_URL,
	rounds: ROUNDS,
	settle: SETTLE_S,
} = parseArgs(
	z
		.object({
			advance: positiveIntegerArg.default(20),
			base: positiveIntegerArg.default(200),
			pg: pgUrlArg,
			rounds: positiveIntegerArg.default(40),
			settle: positiveNumberArg.default(180),
		})
		.strict(),
)
/** Growth over the base push, at identical live content, that counts as bloat. */
const BLOAT_THRESHOLD = 2.0
const HASH_LEAVES = 16

function requiredSize(sizes: Record<string, Sizes>, table: string, phase: string): Sizes {
	const value = sizes[table]
	if (!value || value.total <= 0) {
		throw new Error(`${phase}: missing or empty physical size for ${table}`)
	}
	return value
}

function requiredStat(
	statsByTable: Record<string, Stat>,
	table: string,
	phase: string,
): Stat {
	const value = statsByTable[table]
	if (!value) throw new Error(`${phase}: statistics omitted ${table}`)
	return value
}

/**
 * One base history plus ROUNDS throwaway branches off its tip. Every branch's
 * objects are distinct, so each round ingests genuinely new rows that the rewind
 * turns into genuinely new garbage — never a re-push of the same OIDs.
 */
function buildStream(): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (content: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return m
	}
	const seeded: string[] = []
	for (let i = 0; i < 24; i++) {
		const m = blob(`# doc ${i}\n\n${deterministicFiller(`doc-${i}-v0`, 1400)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	const commitOn = (ref: string, parent: number, salt: string, i: number): number => {
		const dir = uuidFromSeed(`${salt}-run-${i}`)
		const record = blob(
			`{"run":"${dir}","payload":"${deterministicFiller(`${salt}-rec-${i}`, 900)}"}\n`,
		)
		const stderr = blob(`${deterministicFiller(`${salt}-err-${i}`, 300)}\n`)
		const cm = next()
		const msg = `${salt} ${i}`
		out.push(
			`commit ${ref}\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${parent}\n` +
				`M 100644 :${record} .engine/runs/planner-updates/${dir}/record.json\n` +
				`M 100644 :${stderr} .engine/runs/planner-updates/${dir}/stderr\n`,
		)
		return cm
	}
	for (let i = 0; i < BASE; i++) prev = commitOn("refs/heads/main", prev, "base", i)
	const baseTip = prev
	for (let r = 0; r < ROUNDS; r++) {
		let p = baseTip
		for (let i = 0; i < ADVANCE; i++) {
			p = commitOn(`refs/heads/round${r}`, p, `r${r}`, i)
		}
	}
	return out.join("")
}

function sizeLine(name: string, s: Sizes): string {
	return `${padr(name, 19)} ${pad(mb(s.heap), 8)} ${pad(mb(s.toast), 8)} ${pad(mb(s.indexes), 8)} ${pad(mb(s.total), 9)}`
}

async function main(): Promise<void> {
	const scratch = scratchRoot("churn")
	const db = await createIsolatedSchema(PG_URL)
	try {
		console.log(`# Force-push churn economics under the candidate GC→repack sequence\n`)
		console.log(
			`schema ${db.schema} · base ${BASE} commits · ${ROUNDS} rounds × advance ${ADVANCE} then rewind\n`,
		)
		const hz0 = await horizon(db.sql)
		console.log(
			`vacuum horizon at start: lag ${hz0.ageXids} xids, oldest open client xact ` +
				`${hz0.oldestXactSeconds.toFixed(1)}s${hz0.blockers.length > 0 ? ` (${hz0.blockers.length} over 5s)` : ""}\n`,
		)
		if (hz0.ageXids > 5000) {
			throw new Error(
				`vacuum horizon is already pinned by ${hz0.ageXids} xids; bloat would not be attributable`,
			)
		}

		const src = scratch.dir("src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
		const baseTip = await revParse(src, "refs/heads/main")

		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const projection = createRepoFileProjection(db.sql)
		const gc = createGc(db.sql)
		const repack = createRepack(db.sql)
		const deps = { objects: store, projection }

		// Seed the base history exactly as a first push would, then repack it —
		// the steady state the candidate maintenance sequence is meant to preserve.
		const baseObjects = await objectsBetween(src, "refs/heads/main")
		if (baseObjects.length === 0) throw new Error("base fixture produced no objects")
		const eligibleBaseObjects = repackEligibleObjects(baseObjects)
		await store.putPack(
			REPO_ID,
			baseObjects.map((o) => ({ content: o.content, type: o.type })),
		)
		await refs.setRef(REPO_ID, "refs/heads/main", baseTip)
		await refs.setSymref(REPO_ID, "HEAD", "refs/heads/main")
		await syncRefProjection(deps, REPO_ID, "refs/heads/main", baseTip)
		const seedRepack = await repack.repack(REPO_ID)
		if (seedRepack.wholes + seedRepack.deltas !== eligibleBaseObjects.length) {
			throw new Error(
				`base repack covered ${seedRepack.wholes + seedRepack.deltas}/${eligibleBaseObjects.length} eligible objects`,
			)
		}
		const seedSizes = await sizesAll(db.sql)
		for (const t of TABLES) requiredSize(seedSizes, t, "base")
		const seedCounts = new Map<string, number>()
		for (const t of TABLES) {
			const [c] = await db.sql.unsafe<{ n: string }[]>(
				`select count(*)::text as n from ${t}`,
			)
			if (!c) throw new Error(`missing base row count for ${t}`)
			seedCounts.set(t, Number(c.n))
		}
		const expectedCounts: Record<(typeof TABLES)[number], number> = {
			git_commit: baseObjects.filter((object) => object.type === "commit").length,
			git_object: baseObjects.length,
			git_pack_encoding: eligibleBaseObjects.length,
			git_ref: 2,
			git_tag: baseObjects.filter((object) => object.type === "tag").length,
			repo_file: (
				await spawnGit(["ls-tree", "-r", "--name-only", baseTip], { cwd: src })
			).stdout
				.trim()
				.split("\n")
				.filter(Boolean).length,
			repos: 1,
		}
		for (const table of TABLES) {
			const actual = requiredCount(seedCounts, table, "base")
			if (actual !== expectedCounts[table]) {
				throw new Error(
					`base ${table} census ${actual}/${expectedCounts[table]} does not match canonical fixture`,
				)
			}
		}
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "exact", objects: eligibleBaseObjects },
			objects: baseObjects,
			refs: [
				{ kind: "direct", name: "refs/heads/main", oid: baseTip },
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			],
		})
		console.log(
			`base seeded: ${baseObjects.length} objects, repack ${seedRepack.wholes} wholes + ${seedRepack.deltas} deltas\n`,
		)

		console.log(`## per-round trajectory\n`)
		console.log(
			`${padr("round", 6)} ${pad("obj MB", 8)} ${pad("commit MB", 9)} ${pad("enc MB", 8)} ${pad("file MB", 8)} ${pad("ref KB", 7)} ` +
				`${pad("Σ MB", 8)} ${pad("dead", 8)} ${pad("autovac", 8)} ${pad("gc-del", 8)} ${pad("WAL MB", 8)} ${pad("hz lag", 8)}`,
		)

		let wal0 = await walBytes(db.sql)
		const rounds: {
			r: number
			sizes: Record<string, Sizes>
			dead: number
			autovac: number
		}[] = []
		for (let r = 0; r < ROUNDS; r++) {
			const tip = await revParse(src, `refs/heads/round${r}`)
			const objs = await objectsBetween(src, `refs/heads/round${r}`, "refs/heads/main")
			if (objs.length === 0)
				throw new Error(`round ${r}: fixture produced no new objects`)
			await store.putPack(
				REPO_ID,
				objs.map((o) => ({ content: o.content, type: o.type })),
			)
			// advance (push), then rewind (force push) — the ref-move pair the
			// projection and GC both react to.
			await refs.setRef(REPO_ID, "refs/heads/main", tip)
			await syncRefProjection(deps, REPO_ID, "refs/heads/main", tip)
			await refs.setRef(REPO_ID, "refs/heads/main", baseTip)
			await syncRefProjection(deps, REPO_ID, "refs/heads/main", baseTip)

			const gcRes = await gc.gc(REPO_ID, { graceSeconds: 0, maintain: false })
			if (gcRes.deletedObjects !== objs.length) {
				throw new Error(
					`round ${r}: GC deleted ${gcRes.deletedObjects}/${objs.length} newly orphaned objects`,
				)
			}
			const repacked = await repack.repack(REPO_ID)
			if (repacked.wholes + repacked.deltas !== 0) {
				throw new Error(`round ${r}: repack unexpectedly wrote reachable encodings`)
			}

			const sizes = await sizesAll(db.sql)
			for (const t of TABLES) requiredSize(sizes, t, `round ${r}`)
			const agg = aggregate(await stats(db.sql, db.schema))
			const dead = TABLES.reduce((n, t) => n + requiredStat(agg, t, `round ${r}`).dead, 0)
			const autovac = TABLES.reduce(
				(n, t) => n + requiredStat(agg, t, `round ${r}`).autovac,
				0,
			)
			const total = TABLES.reduce(
				(n, t) => n + requiredSize(sizes, t, `round ${r}`).total,
				0,
			)
			const wal = await walBytes(db.sql)
			if (wal <= wal0)
				throw new Error(`round ${r}: WAL counter did not record churn work`)
			const hz = await horizon(db.sql)
			if (hz.ageXids > 5000) {
				throw new Error(
					`round ${r}: vacuum horizon became pinned by ${hz.ageXids} xids; refusing to score bloat`,
				)
			}
			rounds.push({ autovac, dead, r, sizes })
			if (r < 3 || (r + 1) % 5 === 0 || r === ROUNDS - 1) {
				console.log(
					`${padr(r, 6)} ${pad(mb(requiredSize(sizes, "git_object", `round ${r}`).total), 8)} ${pad(mb(requiredSize(sizes, "git_commit", `round ${r}`).total), 9)} ` +
						`${pad(mb(requiredSize(sizes, "git_pack_encoding", `round ${r}`).total), 8)} ${pad(mb(requiredSize(sizes, "repo_file", `round ${r}`).total), 8)} ` +
						`${pad(((requiredSize(sizes, "git_ref", `round ${r}`).total / 1000) | 0).toFixed(0), 7)} ${pad(mb(total), 8)} ${pad(dead, 8)} ` +
						`${pad(autovac, 8)} ${pad(gcRes.deletedObjects, 8)} ` +
						`${pad(mb(wal - wal0), 8)} ${pad(hz.ageXids, 8)}`,
				)
			}
			wal0 = wal
		}

		// ── autovacuum eligibility arithmetic ────────────────────────────────
		console.log(`\n## autovacuum eligibility, per leaf partition (the tuned defence)\n`)
		console.log(
			`NOTE: hash partitioning is BY repo_id, so a single repo's rows all land in ONE\n` +
				`leaf. The other 15 are empty; only the occupied leaf's counters matter.\n`,
		)
		const relopts = await db.sql<{ relname: string; reloptions: string[] | null }[]>`
			select c.relname, c.reloptions
			from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = ${db.schema} and c.relkind = 'r'
				and (c.relname like 'git\\_object\\_p%' or c.relname like 'git\\_commit\\_p%'
					or c.relname like 'git\\_tag\\_p%'
					or c.relname like 'git\\_pack\\_encoding\\_p%' or c.relname like 'repo\\_file\\_p%'
					or c.relname in ('git_ref','repos'))
			order by 1`
		const optOf = (relname: string, key: string): number => {
			const row = relopts.find((o) => o.relname === relname)
			const hit = row?.reloptions?.find((o) => o.startsWith(`${key}=`))
			if (!hit) throw new Error(`${relname}: required ${key} relation option is missing`)
			const value = Number(hit.slice(key.length + 1))
			if (!Number.isFinite(value)) {
				throw new Error(`${relname}: ${key} relation option is invalid: ${hit}`)
			}
			return value
		}
		const raw = await stats(db.sql, db.schema)
		console.log(
			`${padr("relation", 24)} ${pad("live", 8)} ${pad("dead", 8)} ${pad("threshold", 10)} ${pad("scale", 7)} ` +
				`${pad("fires at", 10)} ${pad("autovac", 8)}  eligible?`,
		)
		const perTable = new Map<
			string,
			{ need: number; dead: number; eligible: boolean; leaves: number }
		>()
		for (const s of raw.filter((x) => !x.relname.startsWith("copy_stg"))) {
			const thr = optOf(s.relname, "autovacuum_vacuum_threshold")
			const scale = optOf(s.relname, "autovacuum_vacuum_scale_factor")
			const need = thr + scale * s.live
			const base = s.relname.replace(/_p\d+$/, "")
			const cur = perTable.get(base) ?? {
				dead: 0,
				eligible: false,
				leaves: 0,
				need: 0,
			}
			cur.need += need
			cur.dead += s.dead
			cur.eligible ||= s.dead >= need
			cur.leaves++
			perTable.set(base, cur)
			// Only the occupied leaf (and the unpartitioned tables) carry any signal.
			if (s.dead > 0 || s.live > 0 || !/_p\d+$/.test(s.relname)) {
				console.log(
					`${padr(s.relname, 24)} ${pad(s.live, 8)} ${pad(s.dead, 8)} ${pad(thr, 10)} ${pad(scale, 7)} ` +
						`${pad(need.toFixed(0), 10)} ${pad(s.autovac, 8)}  ${s.dead >= need ? "YES" : "no"}`,
				)
			}
		}
		const occupiedRows = await db.sql<
			{ logical: string; occupied: string; rows: string }[]
		>`
			with relation_rows as (
				select 'git_object' as logical, tableoid, count(*) as rows from git_object group by tableoid
				union all select 'git_commit', tableoid, count(*) from git_commit group by tableoid
				union all select 'git_tag', tableoid, count(*) from git_tag group by tableoid
				union all select 'git_pack_encoding', tableoid, count(*) from git_pack_encoding group by tableoid
				union all select 'repo_file', tableoid, count(*) from repo_file group by tableoid
			), logical(logical) as (
				values ('git_object'), ('git_commit'), ('git_tag'), ('git_pack_encoding'), ('repo_file')
			)
			select l.logical, count(r.tableoid)::text as occupied,
				coalesce(sum(r.rows), 0)::text as rows
			from logical l left join relation_rows r using (logical)
			group by l.logical`
		for (const table of TABLES) {
			const summary = perTable.get(table)
			const expectedLeaves = table === "git_ref" || table === "repos" ? 1 : HASH_LEAVES
			if (!summary || summary.leaves !== expectedLeaves) {
				throw new Error(
					`${table}: relation coverage leaves=${summary?.leaves ?? "missing"}/${expectedLeaves}`,
				)
			}
			if (table !== "git_ref" && table !== "repos") {
				const occupied = occupiedRows.find((row) => row.logical === table)
				if (!occupied) throw new Error(`${table}: occupied-leaf census omitted table`)
				const expectedRows = expectedCounts[table]
				if (
					Number(occupied.occupied) !== (expectedRows === 0 ? 0 : 1) ||
					Number(occupied.rows) !== expectedRows
				) {
					throw new Error(
						`${table}: occupied-leaf census ${JSON.stringify(occupied)} does not prove ${expectedRows} rows in one hash leaf`,
					)
				}
			}
		}
		// ── settle window: give autovacuum every chance ──────────────────────
		console.log(`\n## settle window — ${SETTLE_S}s of idle (autovacuum_naptime is 60s)\n`)
		const t0 = Date.now()
		const settleMs = SETTLE_S * 1000
		for (;;) {
			const remainingMs = settleMs - (Date.now() - t0)
			if (remainingMs <= 0) break
			await sleep(Math.min(30_000, remainingMs))
			const agg = aggregate(await stats(db.sql, db.schema))
			const dead = TABLES.reduce((n, t) => n + requiredStat(agg, t, "settle").dead, 0)
			const av = TABLES.reduce((n, t) => n + requiredStat(agg, t, "settle").autovac, 0)
			const hz = await horizon(db.sql)
			if (hz.ageXids > 5000) {
				throw new Error(
					`settle window: vacuum horizon became pinned by ${hz.ageXids} xids; refusing to score bloat`,
				)
			}
			console.log(
				`  t+${pad(((Date.now() - t0) / 1000).toFixed(0), 4)}s  dead=${pad(dead, 7)}  autovacuum_count=${pad(av, 4)}` +
					`  horizon lag=${pad(hz.ageXids, 7)} xids, oldest open xact=${hz.oldestXactSeconds.toFixed(1)}s`,
			)
		}

		// ── can vacuum reclaim at all? the server's own words ────────────────
		console.log(`\n## VACUUM VERBOSE on the occupied leaf — what the server says\n`)
		const hzNow = await horizon(db.sql)
		console.log(
			`horizon lag ${hzNow.ageXids} xids; ${hzNow.blockers.length} client transaction(s) older than 5s:`,
		)
		for (const b of hzNow.blockers) {
			console.log(`  pid ${b.pid} db=${b.db} ${b.seconds.toFixed(0)}s — ${b.query}`)
		}
		if (hzNow.ageXids > 5000) {
			throw new Error(
				`vacuum horizon is pinned by ${hzNow.ageXids} xids after settling; refusing to score bloat`,
			)
		}
		const occupied = (await stats(db.sql, db.schema))
			.filter((s) => /^git_object_p\d+$/.test(s.relname) && s.dead > 0)
			.sort((a, b) => b.dead - a.dead)[0]
		if (occupied) {
			const v = await vacuumVerbose(PG_URL, db.schema, occupied.relname)
			console.log(
				`\n${occupied.relname}: VACUUM removed ${v.removed} tuples, ${v.remain} remain, ` +
					`${v.notRemovable} are dead but NOT YET REMOVABLE.`,
			)
			console.log(
				v.notRemovable > v.removed
					? `  >> the horizon, not the tuning, is what stopped this reclaim. Any bloat number\n` +
							`  >> measured under a pinned horizon says nothing about the tuning.`
					: `  >> vacuum reclaimed cleanly; the horizon was free.`,
			)
			if (v.notRemovable > 0) {
				throw new Error(
					`VACUUM found ${v.notRemovable} dead tuples that the horizon made unremovable; refusing to score bloat`,
				)
			}
		}

		console.log(
			`\n${padr("logical table", 24)} ${pad("leaves", 7)} ${pad("dead total", 11)} ${pad("summed floor", 13)}  note`,
		)
		for (const [name, v] of perTable) {
			console.log(
				`${padr(name, 24)} ${pad(v.leaves, 7)} ${pad(v.dead, 11)} ${pad(v.need.toFixed(0), 13)}  ` +
					`${v.eligible ? "some leaf eligible" : "no leaf eligible"}`,
			)
		}

		// ── the three sizes ──────────────────────────────────────────────────
		const asLeft = await sizesAll(db.sql)
		for (const t of TABLES) requiredSize(asLeft, t, "as-left")
		const statsLeft = aggregate(await stats(db.sql, db.schema))
		for (const t of TABLES) await vacuumAnalyze(db.sql, t)
		const afterVacuum = await sizesAll(db.sql)
		for (const t of TABLES) requiredSize(afterVacuum, t, "after VACUUM")
		for (const t of TABLES) await vacuumFull(db.sql, t)
		const afterFull = await sizesAll(db.sql)
		for (const t of TABLES) requiredSize(afterFull, t, "after VACUUM FULL")

		// ── index bloat, specifically ────────────────────────────────────────
		// btree VACUUM marks pages reusable but never returns them, and never
		// re-densifies a page. So an index is the component that a plain VACUUM
		// cannot fix and only REINDEX (or VACUUM FULL) can — the exact maintenance
		// `maintain: false` declines to run.
		const idxCommitLeft = await rawIndexSizes(db.sql, "git_commit")
		const idxObjLeft = await rawIndexSizes(db.sql, "git_object")
		const idxEncLeft = await rawIndexSizes(db.sql, "git_pack_encoding")

		// Row counts, so "same reachable content" is a measured fact, not a claim.
		const counts = new Map<string, number>()
		for (const t of TABLES) {
			const [c] = await db.sql.unsafe<{ n: string }[]>(
				`select count(*)::text as n from ${t}`,
			)
			if (!c) throw new Error(`missing final row count for ${t}`)
			counts.set(t, Number(c.n))
		}
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "exact", objects: eligibleBaseObjects },
			objects: baseObjects,
			refs: [
				{ kind: "direct", name: "refs/heads/main", oid: baseTip },
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			],
		})

		console.log(
			`\n## what the candidate sequence leaves behind vs what vacuum can reclaim\n`,
		)
		console.log(
			`the BASE column is the same reachable content, freshly pushed — every round since\n` +
				`added and then reclaimed ${ADVANCE} commits, so the live row counts are identical to it.\n`,
		)
		console.log(
			`${padr("table", 19)} ${pad("rows now", 9)} ${pad("rows base", 10)} ${pad("base MB", 9)} ${pad("as-left MB", 11)} ` +
				`${pad("VACUUM MB", 11)} ${pad("VAC FULL MB", 12)} ${pad("vs base ×", 10)} ${pad("dead", 8)} ${pad("autovac", 8)}`,
		)
		let failures = 0
		for (const t of TABLES) {
			const base = requiredSize(seedSizes, t, "base").total
			const left = requiredSize(asLeft, t, "as-left").total
			const vac = requiredSize(afterVacuum, t, "after VACUUM").total
			const full = requiredSize(afterFull, t, "after VACUUM FULL").total
			const st = requiredStat(statsLeft, t, "as-left")
			const currentCount = requiredCount(counts, t, "final")
			const baseCount = requiredCount(seedCounts, t, "base")
			const sameContent = currentCount === baseCount
			const vsBase = left / base
			console.log(
				`${padr(t, 19)} ${pad(currentCount, 9)} ${pad(baseCount, 10)} ${pad(mb(base), 9)} ${pad(mb(left), 11)} ` +
					`${pad(mb(vac), 11)} ${pad(mb(full), 12)} ${pad(vsBase.toFixed(2), 10)} ` +
					`${pad(st.dead, 8)} ${pad(st.autovac, 8)}`,
			)
			if (!sameContent) {
				throw new Error(
					`${t} live rows changed across zero-net-content churn: ${baseCount} -> ${currentCount}`,
				)
			}
			if (vsBase > BLOAT_THRESHOLD) failures++
		}

		// ── index-only view: what VACUUM cannot fix ──────────────────────────
		console.log(`\n## index bloat — the component plain VACUUM cannot reclaim\n`)
		const idxAfter = [
			...(await rawIndexSizes(db.sql, "git_commit")),
			...(await rawIndexSizes(db.sql, "git_object")),
			...(await rawIndexSizes(db.sql, "git_pack_encoding")),
		]
		const idxBefore = [...idxCommitLeft, ...idxObjLeft, ...idxEncLeft]
		console.log(
			`${padr("index", 34)} ${pad("as-left kB", 12)} ${pad("VAC FULL kB", 12)} ${pad("bloat ×", 9)} ${pad("live rows", 10)}`,
		)
		for (const b of idxBefore) {
			if (b.bytes < 100_000) continue
			const a = idxAfter.find((x) => x.name === b.name)
			if (!a || a.bytes <= 0) throw new Error(`rebuilt index census omitted ${b.name}`)
			console.log(
				`${padr(b.name, 34)} ${pad((b.bytes / 1000).toFixed(0), 12)} ${pad((a.bytes / 1000).toFixed(0), 12)} ` +
					`${pad((b.bytes / a.bytes).toFixed(2), 9)} ${pad(a.tuples.toFixed(0), 10)}`,
			)
		}
		const idxLeftTotal = idxBefore.reduce((n, i) => n + i.bytes, 0)
		const idxFullTotal = idxAfter.reduce((n, i) => n + i.bytes, 0)
		if (idxLeftTotal <= 0 || idxFullTotal <= 0) {
			throw new Error("index size census returned an empty denominator")
		}
		console.log(
			`\nindexes total: ${mb(idxLeftTotal)} MB as the sequence leaves them, ${mb(idxFullTotal)} MB rebuilt ` +
				`= ${(idxLeftTotal / idxFullTotal).toFixed(2)}× bloat.`,
		)
		console.log(
			`the candidate sequence runs no REINDEX, and plain VACUUM never re-densifies a btree page, so\n` +
				`only this rebuild recovers whatever density the churn cost.`,
		)

		console.log(`\n## component breakdown\n\nbase push (the reference state):\n`)
		console.log(
			`${padr("table", 19)} ${pad("heap MB", 8)} ${pad("toast MB", 8)} ${pad("index MB", 8)} ${pad("total MB", 9)}`,
		)
		for (const t of TABLES) console.log(sizeLine(t, requiredSize(seedSizes, t, "base")))
		console.log(`\nas the candidate sequence leaves it after ${ROUNDS} rounds:\n`)
		for (const t of TABLES) console.log(sizeLine(t, requiredSize(asLeft, t, "as-left")))
		console.log(`\nafter VACUUM FULL (the rewrite floor):\n`)
		for (const t of TABLES) {
			console.log(sizeLine(t, requiredSize(afterFull, t, "after VACUUM FULL")))
		}

		const seedTotal = TABLES.reduce(
			(n, t) => n + requiredSize(seedSizes, t, "base").total,
			0,
		)
		const leftTotal = TABLES.reduce(
			(n, t) => n + requiredSize(asLeft, t, "as-left").total,
			0,
		)
		const fullTotal = TABLES.reduce(
			(n, t) => n + requiredSize(afterFull, t, "after VACUUM FULL").total,
			0,
		)
		console.log(
			`\nrepo total: ${mb(seedTotal)} MB after the base push → ${mb(leftTotal)} MB after ` +
				`${ROUNDS} force-push cycles that added ZERO reachable content → ${mb(fullTotal)} MB compacted.`,
		)
		console.log(
			`\nEvery round pushed ${ADVANCE} commits and rewound them: the reachable set is ` +
				`byte-identical to the base push (git_object rows ${requiredCount(counts, "git_object", "final")}, same as the base),\n` +
				`so ${mb(leftTotal - seedTotal)} MB of the ${mb(leftTotal)} MB is churn residue ` +
				`— ${(leftTotal / seedTotal).toFixed(2)}× the content it holds.`,
		)
		if (failures > 0) process.exitCode = 1
	} finally {
		await db.drop()
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

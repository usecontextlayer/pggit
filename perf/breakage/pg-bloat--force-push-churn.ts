/**
 * pg-bloat--force-push-churn — what the GC drain's `maintain: false` actually
 * costs, measured over repeated force-push churn.
 *
 * THE CLAIM UNDER TEST. `gc.ts` skips VACUUM/REINDEX on the drain's hot cadence
 * ("autovacuum reclaims the GC churn instead"), and 0005/0008 tune every leaf
 * partition for that: `autovacuum_vacuum_scale_factor = 0.02` with
 * `autovacuum_vacuum_threshold = 1000`. Those two numbers are the ONLY defence
 * the hot path has. But they are evaluated PER PHYSICAL RELATION, and every one
 * of the three big tables is HASH-partitioned into 16 leaves — so a GC burst of
 * D dead rows is scattered ~D/16 per leaf, and the ABSOLUTE floor of 1000 becomes
 * an effective repo-wide floor of ~16,000 dead rows before any partition is
 * eligible.
 *
 * THE WORKLOAD. Each round is one force-push cycle, the exact shape pggit's
 * motivating tenant produces: advance `refs/heads/main` by ADVANCE commits (real
 * objects ingested through the real store), rewind the ref to the previous tip
 * (the force push), then run the drain's own calls — `gc(graceSeconds: 0,
 * maintain: false)` followed by `repack()`.
 *
 * WHAT IT PRINTS
 *   - per round: total/heap/toast/index bytes for all five tables, dead tuples,
 *     and autovacuum_count for each.
 *   - the autovacuum eligibility arithmetic per leaf partition: dead vs
 *     threshold + scale_factor * live.
 *   - a settle window after the last round (autovacuum naptime is 60 s) so
 *     "autovacuum never fired" cannot be confused with "autovacuum had not run
 *     yet".
 *   - three sizes for every table: as the drain leaves it, after a manual
 *     `VACUUM (ANALYZE)` (what the drain declines to run), and after
 *     `VACUUM FULL` (the compaction floor — what ONLY a rewrite reclaims).
 *
 * EXIT NON-ZERO when a table whose LIVE ROW COUNT is unchanged from the base push
 * occupies more than `BLOAT_THRESHOLD`× what it occupied then. That criterion is
 * chosen because it survives a pinned horizon: it compares two states holding
 * identical content, so it is a statement about residue and never about whether
 * some vacuum happened to be able to run. (The VACUUM / VACUUM FULL columns are
 * still printed — they are how you tell WHY the residue is there.)
 *
 *   npx tsx perf/breakage/pg-bloat--force-push-churn.ts --rounds=40 --settle=180
 */
import { setTimeout as sleep } from "node:timers/promises"
import { syncRefSnapshot } from "@/repo-view/rebuild"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	aggregate,
	COMMITTER,
	DEFAULT_PG_URL,
	filler,
	flag,
	horizon,
	mb,
	objectsBetween,
	pad,
	padr,
	rawIndexSizes,
	runDirName,
	type Sizes,
	scratchRoot,
	sizesAll,
	stats,
	TABLES,
	vacuumAnalyze,
	vacuumFull,
	vacuumVerbose,
	walBytes,
} from "./_pg-bloat-util"

const REPO_ID = "workspace/slate/churn"

const PG_URL = flag("pg", DEFAULT_PG_URL)
const ROUNDS = Number(flag("rounds", "40"))
const ADVANCE = Number(flag("advance", "20"))
const BASE = Number(flag("base", "200"))
const SETTLE_S = Number(flag("settle", "180"))
/** Growth over the base push, at identical live content, that counts as bloat. */
const BLOAT_THRESHOLD = 2.0

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
		const m = blob(`# doc ${i}\n\n${filler(`doc-${i}-v0`, 1400)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	const commitOn = (ref: string, parent: number, salt: string, i: number): number => {
		const dir = runDirName(salt, i)
		const record = blob(
			`{"run":"${dir}","payload":"${filler(`${salt}-rec-${i}`, 900)}"}\n`,
		)
		const stderr = blob(`${filler(`${salt}-err-${i}`, 300)}\n`)
		const cm = next()
		const msg = `${salt} ${i}`
		out.push(
			`commit ${ref}\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${parent}\n` +
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
		console.log(`# Force-push churn economics under the drain's \`maintain: false\`\n`)
		console.log(
			`schema ${db.schema} · base ${BASE} commits · ${ROUNDS} rounds × advance ${ADVANCE} then rewind\n`,
		)
		const hz0 = await horizon(db.sql)
		console.log(
			`vacuum horizon at start: lag ${hz0.ageXids} xids, oldest open client xact ` +
				`${hz0.oldestXactSeconds.toFixed(1)}s${hz0.blockers.length > 0 ? ` (${hz0.blockers.length} over 5s)` : ""}\n`,
		)
		let horizonPinned = hz0.ageXids > 5000

		const src = scratch.dir("src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
		const baseTip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: src })
		).stdout.trim()

		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const snapshots = createRepoFileProjection(db.sql)
		const gc = createGc(db.sql)
		const repack = createRepack(db.sql)
		const deps = { objects: store, snapshots }

		// Seed the base history exactly as a first push would, then repack it —
		// the steady state the drain is supposed to maintain from here on.
		const baseObjects = await objectsBetween(src, "refs/heads/main")
		await store.putPack(
			REPO_ID,
			baseObjects.map((o) => ({ content: o.content, type: o.type })),
		)
		await refs.setRef(REPO_ID, "refs/heads/main", baseTip)
		await syncRefSnapshot(deps, REPO_ID, "refs/heads/main", baseTip)
		const seedRepack = await repack.repack(REPO_ID)
		const seedSizes = await sizesAll(db.sql)
		const seedCounts: Record<string, number> = {}
		for (const t of TABLES) {
			const [c] = await db.sql.unsafe<{ n: string }[]>(
				`select count(*)::text as n from ${t}`,
			)
			seedCounts[t] = Number(c?.n ?? 0)
		}
		console.log(
			`base seeded: ${baseObjects.length} objects, repack ${seedRepack.wholes} wholes + ${seedRepack.deltas} deltas\n`,
		)

		console.log(`## per-round trajectory\n`)
		console.log(
			`${padr("round", 6)} ${pad("obj MB", 8)} ${pad("edge MB", 8)} ${pad("enc MB", 8)} ${pad("file MB", 8)} ${pad("ref KB", 7)} ` +
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
			const tip = (
				await spawnGit(["rev-parse", `refs/heads/round${r}`], { cwd: src })
			).stdout.trim()
			const objs = await objectsBetween(src, `refs/heads/round${r}`, "refs/heads/main")
			await store.putPack(
				REPO_ID,
				objs.map((o) => ({ content: o.content, type: o.type })),
			)
			// advance (push), then rewind (force push) — the ref-move pair the
			// projection and GC both react to.
			await refs.setRef(REPO_ID, "refs/heads/main", tip)
			await syncRefSnapshot(deps, REPO_ID, "refs/heads/main", tip)
			await refs.setRef(REPO_ID, "refs/heads/main", baseTip)
			await syncRefSnapshot(deps, REPO_ID, "refs/heads/main", baseTip)

			const gcRes = await gc.gc(REPO_ID, { graceSeconds: 0, maintain: false })
			await repack.repack(REPO_ID)

			const sizes = await sizesAll(db.sql)
			const agg = aggregate(await stats(db.sql, db.schema))
			const dead = TABLES.reduce((n, t) => n + (agg[t]?.dead ?? 0), 0)
			const autovac = TABLES.reduce((n, t) => n + (agg[t]?.autovac ?? 0), 0)
			const total = TABLES.reduce((n, t) => n + (sizes[t]?.total ?? 0), 0)
			const wal = await walBytes(db.sql)
			const hz = await horizon(db.sql)
			if (hz.ageXids > 5000) horizonPinned = true
			rounds.push({ autovac, dead, r, sizes })
			if (r < 3 || (r + 1) % 5 === 0 || r === ROUNDS - 1) {
				console.log(
					`${padr(r, 6)} ${pad(mb(sizes.git_object?.total ?? 0), 8)} ${pad(mb(sizes.git_commit?.total ?? 0), 8)} ` +
						`${pad(mb(sizes.git_pack_encoding?.total ?? 0), 8)} ${pad(mb(sizes.repo_file?.total ?? 0), 8)} ` +
						`${pad((((sizes.git_ref?.total ?? 0) / 1000) | 0).toFixed(0), 7)} ${pad(mb(total), 8)} ${pad(dead, 8)} ` +
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
				and (c.relname like 'git\\_object\\_p%' or c.relname like 'git\\_edge\\_p%'
					or c.relname like 'git\\_pack\\_encoding\\_p%' or c.relname like 'repo\\_file\\_p%'
					or c.relname in ('git_ref','repos'))
			order by 1`
		const optOf = (relname: string, key: string): number | null => {
			const row = relopts.find((o) => o.relname === relname)
			const hit = row?.reloptions?.find((o) => o.startsWith(`${key}=`))
			return hit ? Number(hit.split("=")[1]) : null
		}
		const raw = await stats(db.sql, db.schema)
		console.log(
			`${padr("relation", 24)} ${pad("live", 8)} ${pad("dead", 8)} ${pad("threshold", 10)} ${pad("scale", 7)} ` +
				`${pad("fires at", 10)} ${pad("autovac", 8)}  eligible?`,
		)
		const perTable = new Map<string, { need: number; dead: number; leaves: number }>()
		for (const s of raw.filter((x) => !x.relname.startsWith("copy_stg"))) {
			const thr = optOf(s.relname, "autovacuum_vacuum_threshold") ?? 50
			const scale = optOf(s.relname, "autovacuum_vacuum_scale_factor") ?? 0.2
			const need = thr + scale * s.live
			const base = s.relname.replace(/_p\d+$/, "")
			const cur = perTable.get(base) ?? { dead: 0, leaves: 0, need: 0 }
			cur.need += need
			cur.dead += s.dead
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
		// ── settle window: give autovacuum every chance ──────────────────────
		console.log(`\n## settle window — ${SETTLE_S}s of idle (autovacuum_naptime is 60s)\n`)
		const t0 = Date.now()
		for (let waited = 0; waited < SETTLE_S; waited += 30) {
			await sleep(30_000)
			const agg = aggregate(await stats(db.sql, db.schema))
			const dead = TABLES.reduce((n, t) => n + (agg[t]?.dead ?? 0), 0)
			const av = TABLES.reduce((n, t) => n + (agg[t]?.autovac ?? 0), 0)
			const hz = await horizon(db.sql)
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
		}

		console.log(
			`\n${padr("logical table", 24)} ${pad("leaves", 7)} ${pad("dead total", 11)} ${pad("summed floor", 13)}  note`,
		)
		for (const [name, v] of perTable) {
			console.log(
				`${padr(name, 24)} ${pad(v.leaves, 7)} ${pad(v.dead, 11)} ${pad(v.need.toFixed(0), 13)}  ` +
					`${v.dead >= v.need ? "some leaf eligible" : "no leaf eligible"}`,
			)
		}

		// ── the three sizes ──────────────────────────────────────────────────
		const asLeft = await sizesAll(db.sql)
		const statsLeft = aggregate(await stats(db.sql, db.schema))
		for (const t of TABLES) await vacuumAnalyze(db.sql, t)
		const afterVacuum = await sizesAll(db.sql)
		for (const t of TABLES) await vacuumFull(db.sql, t)
		const afterFull = await sizesAll(db.sql)

		// ── index bloat, specifically ────────────────────────────────────────
		// btree VACUUM marks pages reusable but never returns them, and never
		// re-densifies a page. So an index is the component that a plain VACUUM
		// cannot fix and only REINDEX (or VACUUM FULL) can — the exact maintenance
		// the drain declines to run.
		const idxCommitLeft = await rawIndexSizes(db.sql, "git_commit")
		const idxObjLeft = await rawIndexSizes(db.sql, "git_object")
		const idxEncLeft = await rawIndexSizes(db.sql, "git_pack_encoding")

		// Row counts, so "same reachable content" is a measured fact, not a claim.
		const counts: Record<string, number> = {}
		for (const t of TABLES) {
			const [c] = await db.sql.unsafe<{ n: string }[]>(
				`select count(*)::text as n from ${t}`,
			)
			counts[t] = Number(c?.n ?? 0)
		}

		console.log(`\n## what the drain leaves behind vs what vacuum can reclaim\n`)
		console.log(
			`the BASE column is the same reachable content, freshly pushed — every round since\n` +
				`added and then reclaimed 20 commits, so the live row counts are identical to it.\n`,
		)
		console.log(
			`${padr("table", 19)} ${pad("rows now", 9)} ${pad("rows base", 10)} ${pad("base MB", 9)} ${pad("as-left MB", 11)} ` +
				`${pad("VACUUM MB", 11)} ${pad("VAC FULL MB", 12)} ${pad("vs base ×", 10)} ${pad("dead", 8)} ${pad("autovac", 8)}`,
		)
		let failures = 0
		for (const t of TABLES) {
			const base = seedSizes[t]?.total ?? 0
			const left = asLeft[t]?.total ?? 0
			const vac = afterVacuum[t]?.total ?? 0
			const full = afterFull[t]?.total ?? 0
			const st = statsLeft[t]
			const sameContent = (counts[t] ?? 0) === (seedCounts[t] ?? -1)
			const vsBase = left / (base || 1)
			console.log(
				`${padr(t, 19)} ${pad(counts[t] ?? 0, 9)} ${pad(seedCounts[t] ?? 0, 10)} ${pad(mb(base), 9)} ${pad(mb(left), 11)} ` +
					`${pad(mb(vac), 11)} ${pad(mb(full), 12)} ${pad(vsBase.toFixed(2), 10)} ` +
					`${pad(st?.dead ?? 0, 8)} ${pad(st?.autovac ?? 0, 8)}`,
			)
			if (sameContent && vsBase > BLOAT_THRESHOLD) failures++
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
			console.log(
				`${padr(b.name, 34)} ${pad((b.bytes / 1000).toFixed(0), 12)} ${pad(((a?.bytes ?? 0) / 1000).toFixed(0), 12)} ` +
					`${pad((b.bytes / Math.max(a?.bytes ?? 1, 1)).toFixed(2), 9)} ${pad((a?.tuples ?? 0).toFixed(0), 10)}`,
			)
		}
		const idxLeftTotal = idxBefore.reduce((n, i) => n + i.bytes, 0)
		const idxFullTotal = idxAfter.reduce((n, i) => n + i.bytes, 0)
		console.log(
			`\nindexes total: ${mb(idxLeftTotal)} MB as the drain leaves them, ${mb(idxFullTotal)} MB rebuilt ` +
				`= ${(idxLeftTotal / Math.max(idxFullTotal, 1)).toFixed(2)}× bloat.`,
		)
		console.log(
			horizonPinned
				? `A ratio near 1.00 here is NOT a clean bill: under a pinned horizon VACUUM FULL must\n` +
						`copy the unremovable dead tuples too, so the "rebuilt" index is not a floor. The\n` +
						`comparison only means something when the horizon is free.`
				: `the drain runs no REINDEX, and plain VACUUM never re-densifies a btree page, so\n` +
						`only this rebuild recovers whatever density the churn cost.`,
		)

		console.log(`\n## component breakdown\n\nbase push (the reference state):\n`)
		console.log(
			`${padr("table", 19)} ${pad("heap MB", 8)} ${pad("toast MB", 8)} ${pad("index MB", 8)} ${pad("total MB", 9)}`,
		)
		for (const t of TABLES) console.log(sizeLine(t, seedSizes[t] as Sizes))
		console.log(`\nas the drain leaves it after ${ROUNDS} rounds:\n`)
		for (const t of TABLES) console.log(sizeLine(t, asLeft[t] as Sizes))
		console.log(`\nafter VACUUM FULL (the rewrite floor):\n`)
		for (const t of TABLES) console.log(sizeLine(t, afterFull[t] as Sizes))

		const seedTotal = TABLES.reduce((n, t) => n + (seedSizes[t]?.total ?? 0), 0)
		const leftTotal = TABLES.reduce((n, t) => n + (asLeft[t]?.total ?? 0), 0)
		const fullTotal = TABLES.reduce((n, t) => n + (afterFull[t]?.total ?? 0), 0)
		console.log(
			`\nrepo total: ${mb(seedTotal)} MB after the base push → ${mb(leftTotal)} MB after ` +
				`${ROUNDS} force-push cycles that added ZERO reachable content → ${mb(fullTotal)} MB compacted.`,
		)
		console.log(
			`\nEvery round pushed ${ADVANCE} commits and rewound them: the reachable set is ` +
				`byte-identical to the base push (git_object rows ${counts.git_object}, same as the base),\n` +
				`so ${mb(leftTotal - (seedSizes.git_object ? seedTotal : 0))} MB of the ${mb(leftTotal)} MB is churn residue ` +
				`— ${(leftTotal / seedTotal).toFixed(2)}× the content it holds.`,
		)
		if (horizonPinned) {
			console.log(
				`\n!! HORIZON WAS PINNED during this run (>5000 xids of lag). The trajectory above is\n` +
					`!! valid, but it measures "vacuum could not reclaim", NOT "the tuning never fired".\n` +
					`!! Re-run when no long transaction is open to separate the two.`,
			)
		}
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

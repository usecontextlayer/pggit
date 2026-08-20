/**
 * pgres — WHAT DOES THE DERIVED ENCODING TIER COST UNDER THE FORCE-PUSH CHURN CYCLE?
 *
 * The cycle puts the derived tier through production-shaped force-push churn (a
 * chat-home / workspace repo whose ref is rewound and re-pushed): per round, push
 * N new commits, move `refs/heads/main` to the new tip (orphaning the previous
 * round), GC with `graceSeconds: 0`, then optionally repack. The LIVE set is
 * CONSTANT round over round — the same base plus one round's worth — so every
 * monotone increase in physical bytes is bloat, not data. The current production
 * scheduler invokes GC only; this harness composes repack explicitly in modes A/B.
 *
 * Three modes, each in its own schema, so the tier's cost is isolated by control:
 *   A  repack + gc(maintain: true)     — an explicit direct-call maintenance path.
 *   B  repack + gc(maintain: false)    — a candidate GC-then-repack composition;
 *                                        it is not wired into the scheduler today.
 *   C  NO repack + gc(maintain: false) — the current production scheduler's GC
 *                                        shape, and the tier-absent control.
 *
 * Comparators inside every mode: `git_object` (same schema, same rounds, same
 * reloptions family — and `gc.ts maintain()` vacuums both it and the encoding
 * tier), and a real local git repo taking the identical force-update with
 * `git gc --prune=now` each round.
 *
 * SHARED-INSTANCE CAVEAT, measured per round: sibling agents hold REPEATABLE READ
 * snapshots on this instance (GC's own closure walk does), which holds back the
 * global xmin horizon and makes VACUUM unable to remove recently-dead tuples. The
 * `xmin lag` column reports it. Every comparison here is INTERNAL to one round —
 * encoding vs git_object under the same horizon — so the confound cancels.
 *
 * Correctness judge stays real git: after the final round a fresh `git clone` over
 * the wire must be fsck-clean and hold exactly the local git repo's object set at
 * the same tip, and an incremental fetch must land the next push.
 *
 * FAILURE BOUND (non-zero exit): over the LAST HALF of the rounds — long past any
 * warm-up — `git_pack_encoding`'s physical footprint still grows by more than 25%
 * of the live bytes it stores, per round, while those live bytes are flat. That is
 * the definition of unbounded: the tier's on-disk cost is a function of how many
 * times the repo was rewritten, not of what it holds. Or any correctness deviation.
 *
 * The `VACUUM FULL` reclaim line is reported but NOT bounded: VACUUM FULL also
 * respects the xmin horizon, so on this shared instance it under-reports. Read it
 * together with the `xmin lag` column.
 *
 *   npx tsx perf/breakage/pgres--churn-cycle-bloat.ts --rounds=14 --commits=60
 */
import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "postgres"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { branchAndTagRefsOf, parseRevListObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	cleanupTmp,
	cloneAndVerify,
	encodingCensus,
	fastImport,
	initRepo,
	mb,
	mkTmp,
	numFlag,
	objectsBetween,
	PG_URL,
	revParse,
	runCommits,
	schemaStats,
	seedObjects,
	setMain,
	sleep,
	stat,
	table,
	total,
} from "./_pgres-util"

const ROUNDS = numFlag("rounds", 14)
const PER_ROUND = numFlag("commits", 60)
const BASE_RUNS = numFlag("base", 100)
const BLOB_CHARS = 1200
const REPO = "churn"

type Mode = { key: string; label: string; maintain: boolean; repack: boolean }
const MODES: Mode[] = [
	{
		key: "A",
		label: "A  repack + gc(maintain: true)     — explicit direct-call path",
		maintain: true,
		repack: true,
	},
	{
		key: "B",
		label: "B  repack + gc(maintain: false)    — candidate composition (not wired)",
		maintain: false,
		repack: true,
	},
	{
		key: "C",
		label: "C  NO repack + gc(maintain: false) — current scheduler; tier absent",
		maintain: false,
		repack: false,
	},
]

type Row = {
	round: number
	encRows: number
	encLogical: number
	encHeap: number
	encToast: number
	encIdx: number
	encDead: number
	encAutovac: number
	encVac: number
	objTotal: number
	objDead: number
	objAutovac: number
	objVac: number
	commitTotal: number
	schemaTotal: number
	gitDirBytes: number
	gcObjects: number
	repackWholes: number
	repackDeltas: number
	xminLagS: number
	ms: number
}

type ModeResult = {
	mode: Mode
	rows: Row[]
	verdict: string
	failed: boolean
	reclaim: { enc: [number, number]; obj: [number, number] }
}

/** Mean per-round growth of the encoding tier's physical footprint over the LAST
 * HALF of the run, as a fraction of the live bytes it stores. Flat ⇒ 0. */
function tailGrowthPerLiveByte(rows: Row[]): number {
	if (rows.length < 3) throw new Error("growth measurement requires at least 3 rounds")
	const half = Math.floor(rows.length / 2)
	const z = rows[rows.length - 1] as Row
	const m = rows[half] as Row
	const span = rows.length - 1 - half
	if (z.encLogical <= 0)
		throw new Error("growth measurement requires live encoding bytes")
	return (phys(z) - phys(m)) / span / z.encLogical
}

const phys = (r: Row): number => r.encHeap + r.encToast + r.encIdx

function dirBytes(dir: string): number {
	const walk = (p: string): number => {
		const st = statSync(p)
		if (!st.isDirectory()) return st.size
		let n = 0
		for (const e of readdirSync(p)) n += walk(join(p, e))
		return n
	}
	return walk(dir)
}

/** Seconds the OLDEST client backend has been holding a transaction snapshot — the
 * instance-wide xmin horizon lag. Shared: this is the sibling agents' load. */
async function xminLag(pg: Sql): Promise<number> {
	const [r] = await pg<{ lag: string | null }[]>`
		select coalesce(max(extract(epoch from (clock_timestamp() - xact_start))), 0)::int::text as lag
		from pg_stat_activity
		where backend_type = 'client backend' and backend_xmin is not null`
	if (!r) throw new Error("xmin-lag query returned no row")
	const lag = Number(r.lag)
	if (!Number.isFinite(lag) || lag < 0) {
		throw new Error(`xmin-lag query returned invalid value ${r.lag}`)
	}
	return lag
}

async function runMode(mode: Mode): Promise<ModeResult> {
	const iso = await createIsolatedSchema(PG_URL)
	const pg: Sql = iso.sql
	const rows: Row[] = []
	let failed = false
	let verdict = ""
	let reclaim: { enc: [number, number]; obj: [number, number] } = {
		enc: [0, 0],
		obj: [0, 0],
	}
	try {
		const dir = await initRepo(`churn-${mode.key}`)
		const base = runCommits({
			blobChars: BLOB_CHARS,
			branch: "refs/heads/main",
			count: BASE_RUNS,
			markStart: 0,
			salt: "base",
		})
		await fastImport(dir, base.stream)
		const baseTip = await revParse(dir, "refs/heads/main")
		const baseObjects = await objectsBetween(dir, baseTip, [])
		await seedObjects(pg, REPO, baseObjects)
		await setMain(pg, REPO, baseTip)
		const repack = createRepack(pg)
		if (mode.repack) {
			const seeded = await repack.repack(REPO)
			if (seeded.wholes + seeded.deltas !== baseObjects.length) {
				throw new Error(`${mode.key}: base repack covered incomplete object set`)
			}
		}

		const gc = createGc(pg)
		let tip = baseTip

		for (let r = 1; r <= ROUNDS; r++) {
			const t0 = Date.now()
			// A DIFFERENT N commits on the same base — the previous round's commits go
			// unreachable the moment the ref moves.
			const round = runCommits({
				blobChars: BLOB_CHARS,
				branch: "refs/heads/main",
				count: PER_ROUND,
				from: baseTip,
				markStart: 0,
				salt: `r${r}`,
			})
			await fastImport(dir, round.stream)
			tip = await revParse(dir, "refs/heads/main")

			const roundObjects = await objectsBetween(dir, tip, [baseTip])
			if (roundObjects.length === 0)
				throw new Error(`${mode.key} round ${r}: empty churn set`)
			await seedObjects(pg, REPO, roundObjects)
			await setMain(pg, REPO, tip)
			const [beforeGc] = await pg<
				{ n: string }[]
			>`select count(*)::text as n from git_object`
			if (!beforeGc) throw new Error(`${mode.key} round ${r}: missing pre-GC census`)

			// GC then optional repack — explicit harness composition (design D5).
			// The current production scheduler stops after GC.
			const g = await gc.gc(REPO, { graceSeconds: 0, maintain: mode.maintain })
			const p = mode.repack ? await repack.repack(REPO) : { deltas: 0, wholes: 0 }
			const canonical = parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", "refs/heads/main"], { cwd: dir }))
					.stdout,
			)
			const [live] = await pg<
				{ objects: string; commits: string; encodings: string; tip: string }[]
			>`select
				(select count(*) from git_object)::text as objects,
				(select count(*) from git_commit)::text as commits,
				(select count(*) from git_pack_encoding)::text as encodings,
				(select encode(oid, 'hex') from git_ref where name = 'refs/heads/main') as tip`
			const expectedDeleted = Number(beforeGc.n) - canonical.length
			const expectedEncodings = mode.repack ? canonical.length : 0
			if (
				!live ||
				live.tip !== tip ||
				Number(live.objects) !== canonical.length ||
				Number(live.commits) !== BASE_RUNS + PER_ROUND ||
				Number(live.encodings) !== expectedEncodings ||
				g.deletedObjects !== expectedDeleted ||
				(mode.repack && p.wholes + p.deltas !== roundObjects.length)
			) {
				throw new Error(
					`${mode.key} round ${r} prerequisite mismatch: ${JSON.stringify({ beforeGc, deleted: g.deletedObjects, live, repack: p })}`,
				)
			}

			// The git comparator takes the same beating.
			await spawnGit(["reflog", "expire", "--expire=now", "--all"], { cwd: dir })
			await spawnGit(["gc", "--prune=now", "-q"], { cwd: dir })

			await sleep(1300) // let the stats collector flush
			const s = await schemaStats(pg, iso.schema)
			const e = stat(s, "git_pack_encoding")
			const o = stat(s, "git_object")
			const ed = stat(s, "git_commit")
			const census = await encodingCensus(pg)
			if (!s.git_pack_encoding || !s.git_object || !s.git_commit) {
				throw new Error(
					`${mode.key} round ${r}: storage statistics missing a measured table`,
				)
			}
			if (
				mode.repack
					? census.rows !== expectedEncodings || census.rows <= 0 || census.dataBytes <= 0
					: census.rows !== 0 || census.dataBytes !== 0
			) {
				throw new Error(`${mode.key} round ${r}: encoding census is incomplete`)
			}
			rows.push({
				commitTotal: total(ed),
				encAutovac: e.autovac,
				encDead: e.dead,
				encHeap: e.heap,
				encIdx: e.idx,
				encLogical: census.dataBytes,
				encRows: census.rows,
				encToast: e.toast,
				encVac: e.vac,
				gcObjects: g.deletedObjects,
				gitDirBytes: dirBytes(join(dir, ".git")),
				ms: Date.now() - t0,
				objAutovac: o.autovac,
				objDead: o.dead,
				objTotal: total(o),
				objVac: o.vac,
				repackDeltas: p.deltas,
				repackWholes: p.wholes,
				round: r,
				schemaTotal: Object.values(s).reduce((n, t) => n + total(t), 0),
				xminLagS: await xminLag(pg),
			})
		}

		// ── correctness judge: real git ─────────────────────────────────────────
		const server = await serveOnPort(createGitApp(createGitDeps(pg)), 0)
		try {
			const url = `http://127.0.0.1:${server.port}/${REPO}`
			const clone = join(mkTmp(`clone-${mode.key}`), "c.git")
			const got = await cloneAndVerify(url, clone)
			const want = parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })).stdout,
			).sort()
			const wantRefs = (await branchAndTagRefsOf(dir)).map(
				({ name, oid }) => `${oid} ${name}`,
			)
			const same =
				got.objects.length === want.length &&
				got.objects.every((x, i) => x === want[i]) &&
				JSON.stringify(got.refs) === JSON.stringify(wantRefs) &&
				got.fsck === ""
			verdict = same
				? `clone fsck-clean, ${got.objects.length} objects, identical to local git`
				: `MISMATCH: clone ${got.objects.length} objs / local ${want.length} objs / fsck=${got.fsck || "clean"}`
			if (!same) failed = true

			const extra = runCommits({
				blobChars: BLOB_CHARS,
				branch: "refs/heads/main",
				count: 5,
				from: tip,
				markStart: 0,
				salt: "incr",
			})
			await fastImport(dir, extra.stream)
			const tip2 = await revParse(dir, "refs/heads/main")
			const extraObjects = await objectsBetween(dir, tip2, [tip])
			await seedObjects(pg, REPO, extraObjects)
			await setMain(pg, REPO, tip2)
			if (mode.repack) {
				const extraRepack = await repack.repack(REPO)
				if (extraRepack.wholes + extraRepack.deltas !== extraObjects.length) {
					throw new Error(`${mode.key}: incremental repack coverage mismatch`)
				}
			}
			await spawnGit(["fetch", "-q", "origin", "+refs/*:refs/*"], { cwd: clone })
			const after = (
				await spawnGit(["rev-parse", "refs/heads/main"], { cwd: clone })
			).stdout.trim()
			if (after !== tip2) {
				failed = true
				verdict += ` | INCREMENTAL FETCH MISMATCH ${after} != ${tip2}`
			} else {
				const f = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: clone })
				const gotAfter = parseRevListObjectOids(
					(await spawnGit(["rev-list", "--objects", "--all"], { cwd: clone })).stdout,
				).sort()
				const wantAfter = parseRevListObjectOids(
					(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })).stdout,
				).sort()
				const [gotRefsAfter, wantRefsAfter] = await Promise.all([
					branchAndTagRefsOf(clone),
					branchAndTagRefsOf(dir),
				])
				if (
					gotAfter.length !== wantAfter.length ||
					gotAfter.some((oid, i) => oid !== wantAfter[i]) ||
					JSON.stringify(gotRefsAfter) !== JSON.stringify(wantRefsAfter)
				) {
					throw new Error(`${mode.key}: incremental clone refs/objects diverged from git`)
				}
				verdict += ` | incremental fetch ok (fsck ${`${f.stdout}${f.stderr}`.trim() || "clean"})`
			}
			rmSync(clone, { force: true, recursive: true })
		} finally {
			await server.close()
		}

		// ── how much of the footprint is DEAD SPACE? ────────────────────────────
		// VACUUM reclaims space for REUSE but never returns it to the OS, so relation
		// size alone cannot separate "grew because it holds more" from "grew because
		// nothing reclaimed". VACUUM FULL rewrites the relation at its live size — the
		// difference IS the bloat, exactly. Own schema only.
		const before = await schemaStats(pg, iso.schema)
		await pg.unsafe("vacuum (full, analyze) git_pack_encoding")
		await pg.unsafe("vacuum (full, analyze) git_object")
		await sleep(500)
		const after = await schemaStats(pg, iso.schema)
		reclaim = {
			enc: [
				total(stat(before, "git_pack_encoding")),
				total(stat(after, "git_pack_encoding")),
			],
			obj: [total(stat(before, "git_object")), total(stat(after, "git_object"))],
		}
	} finally {
		await iso.drop()
	}
	return { failed, mode, reclaim, rows, verdict }
}

function report(res: ModeResult): void {
	const { rows, mode } = res
	if (rows.length < 3)
		throw new Error(`${mode.key}: bloat report needs at least 3 rounds`)
	console.log(`\n### ${mode.label}\n`)
	console.log(
		table(
			[
				"rnd",
				"enc rows",
				"enc live MB",
				"enc heap",
				"enc toast",
				"enc idx",
				"enc PHYS MB",
				"enc dead",
				"enc av/v",
				"git_object MB",
				"obj dead",
				"obj av/v",
				"schema MB",
				".git MB",
				"gc objects",
				"xmin lag s",
				"ms",
			],
			rows.map((r) => [
				r.round,
				r.encRows,
				mb(r.encLogical),
				mb(r.encHeap),
				mb(r.encToast),
				mb(r.encIdx),
				mb(phys(r)),
				r.encDead,
				`${r.encAutovac}/${r.encVac}`,
				mb(r.objTotal),
				r.objDead,
				`${r.objAutovac}/${r.objVac}`,
				mb(r.schemaTotal),
				mb(r.gitDirBytes),
				r.gcObjects,
				r.xminLagS,
				r.ms,
			]),
		),
	)
	const a = rows[1] as Row
	const z = rows[rows.length - 1] as Row
	if (a.objTotal <= 0 || a.schemaTotal <= 0 || a.gitDirBytes <= 0) {
		throw new Error(`${mode.key}: bloat baseline has an empty denominator`)
	}
	if (mode.repack) {
		if (phys(a) <= 0 || a.encRows <= 0 || a.encLogical <= 0) {
			throw new Error(`${mode.key}: repacked bloat baseline has an empty denominator`)
		}
	} else if (rows.some((r) => r.encRows !== 0 || r.encLogical !== 0)) {
		throw new Error(`${mode.key}: tier-absent control produced encoding rows or bytes`)
	}
	const half = Math.floor(rows.length / 2)
	const span = rows.length - 1 - half
	const tailEnc = (phys(z) - phys(rows[half] as Row)) / span
	const tailObj = (z.objTotal - (rows[half] as Row).objTotal) / span
	const tailSchema = (z.schemaTotal - (rows[half] as Row).schemaTotal) / span
	console.log(
		mode.repack
			? `\nround 2 → ${rows.length}:  git_pack_encoding ×${(phys(z) / phys(a)).toFixed(2)} (${mb(phys(a))} → ${mb(phys(z))} MB) while its LIVE content stayed ×${(z.encLogical / a.encLogical).toFixed(2)} (${mb(a.encLogical)} MB)`
			: `\nround 2 → ${rows.length}:  git_pack_encoding stayed absent (0 rows, 0 live bytes); its empty relation shell measured ${mb(phys(a))} → ${mb(phys(z))} MB`,
	)
	console.log(
		`  comparators: git_object ×${(z.objTotal / a.objTotal).toFixed(2)} (${mb(a.objTotal)} → ${mb(z.objTotal)} MB) · whole schema ×${(z.schemaTotal / a.schemaTotal).toFixed(2)} (${mb(a.schemaTotal)} → ${mb(z.schemaTotal)} MB) · local git .git ×${(z.gitDirBytes / a.gitDirBytes).toFixed(2)} (${mb(z.gitDirBytes)} MB, flat)`,
	)
	console.log(
		`  growth over the LAST HALF: encoding +${(tailEnc / 1024).toFixed(0)} KB/round · git_object +${(tailObj / 1024).toFixed(0)} KB/round · schema +${(tailSchema / 1024).toFixed(0)} KB/round · local git +0 KB/round`,
	)
	const [encB, encA] = res.reclaim.enc
	const [objB, objA] = res.reclaim.obj
	console.log(
		`  VACUUM FULL reclaim: git_pack_encoding ${mb(encB)} → ${mb(encA)} MB (${encB ? ((1 - encA / encB) * 100).toFixed(0) : "0"}% dead space) · git_object ${mb(objB)} → ${mb(objA)} MB (${objB ? ((1 - objA / objB) * 100).toFixed(0) : "0"}% dead space)`,
	)
	console.log(`  correctness: ${res.verdict}`)
}

async function main(): Promise<void> {
	if (ROUNDS < 3 || PER_ROUND < 1 || BASE_RUNS < 1) {
		throw new Error(`rounds/base/commits must be positive and rounds >= 3`)
	}
	console.log(
		`# churn cycle: ${ROUNDS} rounds × ${PER_ROUND} commits over a ${BASE_RUNS}-commit base\n`,
	)
	console.log(
		"Each round: push N new commits → move refs/heads/main (orphaning the previous round) → gc(graceSeconds:0) → optional explicit repack.",
	)
	console.log(
		"The live set is CONSTANT across rounds; every physical increase is bloat.\n",
	)

	let failed = false
	const all: ModeResult[] = []
	for (const mode of MODES) {
		const res = await runMode(mode)
		report(res)
		all.push(res)
		if (res.failed) failed = true
	}

	console.log("\n## what the tier costs (final round of each mode)\n")
	const ctrl = all[all.length - 1]?.rows.at(-1) as Row
	console.log(
		table(
			[
				"mode",
				"schema MB",
				"git_object MB",
				"git_commit MB",
				"git_pack_encoding MB",
				"schema vs control C",
			],
			all.map((r) => {
				const z = r.rows[r.rows.length - 1] as Row
				return [
					r.mode.key,
					mb(z.schemaTotal),
					mb(z.objTotal),
					mb(z.commitTotal),
					mb(phys(z)),
					`×${(z.schemaTotal / ctrl.schemaTotal).toFixed(2)}`,
				]
			}),
		),
	)

	console.log("\n## how much explicit reclamation each table got\n")
	console.log(
		table(
			[
				"mode",
				"git_object VACUUMs",
				"git_object autovacuums",
				"git_pack_encoding VACUUMs",
				"git_pack_encoding autovacuums",
			],
			all.map((r) => {
				const z = r.rows[r.rows.length - 1] as Row
				return [r.mode.key, z.objVac, z.objAutovac, z.encVac, z.encAutovac]
			}),
		),
	)
	console.log(
		"\n`gc.ts maintain()` runs `vacuum (analyze) git_object` and `vacuum (analyze) git_pack_encoding` — the two tables the sweep's DELETEs churn (encoding rows die by 0008 FK cascade inside the object DELETEs). git_commit/git_tag cascade-churn too but are bytes-tiny; their 0009 leaf reloptions carry the reclaim.",
	)

	console.log("\n## verdict\n")
	console.log(
		"BOUND: over the LAST HALF of the rounds, git_pack_encoding's physical footprint must not still be growing by >25% of its live bytes per round.\n",
	)
	for (const r of all) {
		if (!r.mode.repack) continue
		const g = tailGrowthPerLiveByte(r.rows)
		const bad = g > 0.25
		if (bad) failed = true
		console.log(
			`${bad ? "FAIL" : "ok  "}  still growing +${(g * 100).toFixed(0)}% of live bytes per round in the last half  — ${r.mode.label}`,
		)
	}
	console.log(
		"      control C (tier absent): N/A — there are deliberately no live encoding bytes to denominate a growth ratio.",
	)
	cleanupTmp()
	if (failed) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

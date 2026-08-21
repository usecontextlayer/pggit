/**
 * pg-bloat/repo-file-projection — the steady-state cost of the incremental
 * branch projection.
 *
 * `repo_file` is the per-branch-tip `path → (mode, blob_oid)` index that IS
 * pggit's public read surface. The first snapshot uses the full-rebuild COPY;
 * subsequent monotone ref advances diff the persisted basis and update only
 * changed paths. A one-file push must therefore produce one row update while the
 * live projection remains exactly equal to canonical git.
 *
 * That decision has two measurable consequences this harness quantifies:
 *
 *   1. **Write amplification stays O(change).** The measured insert/delete/update
 *      counters must show exactly one update per one-file push.
 *   2. **Physical churn stays bounded.** The occupied hash leaf may accumulate
 *      dead update versions, so the on-disk ratio against the base snapshot
 *      remains a useful autovacuum/bloat gate.
 *
 * WHAT IT PRINTS: per push, the projection's on-disk size split heap/index, its
 * live row count, dead tuples, tuples inserted/deleted/updated/HOT-updated, and
 * autovacuum passes; then the steady-state size against the VACUUM FULL floor.
 *
 * EXIT NON-ZERO when the projection's on-disk size exceeds `BLOAT_LIMIT`× what it
 * occupied after the base push, at an UNCHANGED live row count. The harness aborts
 * before scoring if it observes a pinned vacuum horizon: identical live content
 * does not make unreclaimable dead versions an attributable bloat measurement.
 *
 *   npx tsx perf/probes/pg-bloat/repo-file-projection.ts --files=4000 --pushes=60
 */

import { parseArgs, pgUrlArg, positiveIntegerArg } from "@perf/args"
import { vacuumVerbose } from "@perf/probes/_vacuum-evidence"
import {
	aggregate,
	backendWal,
	flushStats,
	horizon,
	kb,
	mb,
	objectsBetween,
	pad,
	padr,
	scratchRoot,
	sizeOf,
	stats,
	taggedPool,
	vacuumAnalyze,
	vacuumFull,
} from "@perf/probes/pg-bloat/_util"
import { z } from "zod"
import { createRepoFileProjection } from "@/repo-file/projection"
import { syncRefProjection } from "@/repo-file/sync-ref"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { deterministicFiller, FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** tag so WAL and dead-tuple cost are attributable on a shared instance */
const PUSH_APP = "pgbloat-projection-under-test"

const REPO_ID = "workspace/slate/projection"
const BLOAT_LIMIT = 2.0

const {
	files: FILES,
	pg: PG_URL,
	pushes: PUSHES,
} = parseArgs(
	z
		.object({
			files: positiveIntegerArg.default(4000),
			pg: pgUrlArg,
			pushes: positiveIntegerArg.default(60),
		})
		.strict(),
)

function baseStream(): string {
	const out: string[] = []
	let mark = 0
	const lines: string[] = []
	for (let i = 0; i < FILES; i++) {
		const content = `# f${i}\n${deterministicFiller(`f${i}-v0`, 300)}\n`
		const m = ++mark
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		lines.push(`M 100644 :${m} src/d${i % 40}/f${i}.md`)
	}
	const cm = ++mark
	out.push(
		`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nbase\n${lines.join("\n")}\n`,
	)
	return out.join("")
}

function touchStream(gen: number): string {
	const i = gen % FILES
	const content = `# f${i}\n${deterministicFiller(`f${i}-v${gen}`, 300)}\n`
	return (
		`blob\nmark :1\ndata ${Buffer.byteLength(content)}\n${content}\n` +
		`commit refs/heads/main\nmark :2\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 5\ntouch\nfrom refs/heads/main^0\n` +
		`M 100644 :1 src/d${i % 40}/f${i}.md\n`
	)
}

async function main(): Promise<void> {
	const scratch = scratchRoot("proj")
	const db = await createIsolatedSchema(PG_URL)
	const app = taggedPool(PG_URL, db.schema, PUSH_APP)
	try {
		console.log(`# \`repo_file\` incremental projection: O(change) writes per push\n`)
		console.log(`schema ${db.schema} · ${FILES}-file tree · ${PUSHES} one-file pushes\n`)

		const hz0 = await horizon(db.sql)
		console.log(
			`vacuum horizon at start: lag ${hz0.ageXids} xids, oldest open client xact ${hz0.oldestXactSeconds.toFixed(0)}s\n`,
		)
		if (hz0.ageXids > 5000) {
			throw new Error(
				`vacuum horizon is already pinned by ${hz0.ageXids} xids; bloat would not be attributable`,
			)
		}

		const src = scratch.dir("src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: baseStream() })

		const store = createObjectStore(app)
		const refs = createRefStore(app)
		const projection = createRepoFileProjection(app)
		const deps = { objects: store, projection }

		let tip = await revParse(src, "refs/heads/main")
		const baseObjs = await objectsBetween(src, tip)
		if (baseObjs.length === 0)
			throw new Error("base projection fixture produced no objects")
		await store.putPack(
			REPO_ID,
			baseObjs.map((o) => ({ content: o.content, type: o.type })),
		)
		await refs.setRef(REPO_ID, "refs/heads/main", tip)
		await refs.setSymref(REPO_ID, "HEAD", "refs/heads/main")
		await syncRefProjection(deps, REPO_ID, "refs/heads/main", tip)
		const [baseCount] = await db.sql<{ n: string }[]>`
			select count(*)::text as n from repo_file`
		if (!baseCount || Number(baseCount.n) !== FILES) {
			throw new Error(`base projection has ${baseCount?.n ?? "no count"}/${FILES} rows`)
		}
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "unchecked" },
			objects: baseObjs,
			refs: await canonicalStoreRefsOf(src),
		})

		const seedSize = await sizeOf(db.sql, "repo_file")
		if (seedSize.total <= 0) throw new Error("base projection has no physical size")
		console.log(
			`after the base push: repo_file ${mb(seedSize.total)} MB ` +
				`(heap ${kb(seedSize.heap)} kB, index ${kb(seedSize.indexes)} kB, toast ${kb(seedSize.toast)} kB) ` +
				`for ${FILES} live rows\n`,
		)

		console.log(`## per-push trajectory\n`)
		console.log(
			`${padr("push", 6)} ${pad("heap kB", 9)} ${pad("index kB", 9)} ${pad("total kB", 9)} ${pad("live", 7)} ` +
				`${pad("dead", 7)} ${pad("ins", 8)} ${pad("del", 8)} ${pad("upd", 6)} ${pad("HOT", 6)} ` +
				`${pad("autovac", 8)} ${pad("ownWAL kB/push", 15)} ${pad("hz lag", 8)}`,
		)

		await flushStats(app)
		const baseAgg = aggregate(await stats(db.sql, db.schema)).repo_file
		if (!baseAgg) throw new Error("repo_file stats missing after base projection")
		let prevWal = await backendWal(db.sql, PUSH_APP)
		let lastSample = -1
		let lastIns = baseAgg.ins
		let lastDel = baseAgg.del
		let lastUpd = baseAgg.upd
		let lastHot = baseAgg.hot
		const walPerPush: number[] = []
		for (let p = 0; p < PUSHES; p++) {
			await spawnGit(["fast-import", "--quiet"], { cwd: src, input: touchStream(p + 1) })
			const newTip = await revParse(src, "refs/heads/main")
			const objs = await objectsBetween(src, newTip, tip)
			if (objs.length === 0)
				throw new Error(`push ${p}: canonical fixture produced no objects`)
			await store.putPack(
				REPO_ID,
				objs.map((o) => ({ content: o.content, type: o.type })),
			)
			await refs.setRef(REPO_ID, "refs/heads/main", newTip)
			await syncRefProjection(deps, REPO_ID, "refs/heads/main", newTip)
			tip = newTip

			if (p < 3 || (p + 1) % 10 === 0 || p === PUSHES - 1) {
				// Idle backends sit on their counters; drive them through a command cycle.
				await flushStats(app)
				const wal = await backendWal(db.sql, PUSH_APP)
				const span = p - lastSample
				const walDelta = wal - prevWal
				if (span <= 0 || walDelta <= 0) {
					throw new Error(`push ${p}: invalid WAL sample span=${span}, bytes=${walDelta}`)
				}
				walPerPush.push(walDelta)
				const perPush = walDelta / span
				prevWal = wal
				lastSample = p
				const s = await sizeOf(db.sql, "repo_file")
				const agg = aggregate(await stats(db.sql, db.schema)).repo_file
				if (!agg) throw new Error(`push ${p}: repo_file stats missing`)
				const hz = await horizon(db.sql)
				if (hz.ageXids > 5000) {
					throw new Error(
						`push ${p}: vacuum horizon became pinned by ${hz.ageXids} xids; refusing to score bloat`,
					)
				}
				console.log(
					`${padr(p, 6)} ${pad(kb(s.heap), 9)} ${pad(kb(s.indexes), 9)} ${pad(kb(s.total), 9)} ` +
						`${pad(agg.live, 7)} ${pad(agg.dead, 7)} ${pad(agg.ins - lastIns, 8)} ` +
						`${pad(agg.del - lastDel, 8)} ${pad(agg.upd - lastUpd, 6)} ${pad(agg.hot - lastHot, 6)} ` +
						`${pad(agg.autovac, 8)} ${pad(kb(perPush), 15)} ${pad(hz.ageXids, 8)}`,
				)
				lastIns = agg.ins
				lastDel = agg.del
				lastUpd = agg.upd
				lastHot = agg.hot
			}
		}

		const asLeft = await sizeOf(db.sql, "repo_file")
		// The server's own account of whether the dead tuples are removable at all.
		const occupied = (await stats(db.sql, db.schema))
			.filter((s) => /^repo_file_p\d+$/.test(s.relname) && s.dead > 0)
			.sort((a, b) => b.dead - a.dead)[0]
		const verdict = occupied
			? await vacuumVerbose(PG_URL, db.schema, occupied.relname)
			: { notRemovable: 0, remain: 0, removed: 0 }
		if (verdict.notRemovable > 0) {
			throw new Error(
				`VACUUM found ${verdict.notRemovable} repo_file tuples blocked by the horizon; refusing to score bloat`,
			)
		}
		await vacuumAnalyze(db.sql, "repo_file")
		const afterVac = await sizeOf(db.sql, "repo_file")
		await vacuumFull(db.sql, "repo_file")
		const afterFull = await sizeOf(db.sql, "repo_file")
		for (const [phase, size] of [
			["as-left", asLeft],
			["after VACUUM", afterVac],
			["after VACUUM FULL", afterFull],
		] as const) {
			if (size.total <= 0) throw new Error(`${phase}: repo_file has no physical size`)
		}
		const agg = aggregate(await stats(db.sql, db.schema)).repo_file
		if (!agg) throw new Error("repo_file stats missing at final census")
		const [projectionHead] = await db.sql<{ oid: string; n: string }[]>`
			select encode(h.commit_oid, 'hex') as oid,
				(select count(*) from repo_file f where f.repo_id = h.repo_id and f.ref_name = h.ref_name)::text as n
			from repo_file_head h where h.ref_name = 'refs/heads/main'`
		if (
			!projectionHead ||
			projectionHead.oid !== tip ||
			Number(projectionHead.n) !== FILES
		) {
			throw new Error(
				`projection head/rows mismatch: ${JSON.stringify(projectionHead)}, expected ${tip}/${FILES}`,
			)
		}
		const canonicalFiles = (
			await spawnGit(
				["ls-tree", "-r", "--format=%(objectmode) %(objectname) %(path)", tip],
				{
					cwd: src,
				},
			)
		).stdout.trim()
		const projectedFiles = (
			await db.sql<{ line: string }[]>`
				select mode || ' ' || encode(blob_oid, 'hex') || ' ' || path as line
				from repo_file order by path`
		)
			.map((row) => row.line)
			.join("\n")
		if (projectedFiles !== canonicalFiles) {
			throw new Error("repo_file rows diverged from canonical git ls-tree")
		}
		const expectedFinalObjects = await objectsBetween(src, tip)
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "unchecked" },
			objects: expectedFinalObjects,
			refs: await canonicalStoreRefsOf(src),
		})

		console.log(`\n## steady state after ${PUSHES} pushes\n`)
		console.log(
			`${padr("state", 22)} ${pad("heap kB", 9)} ${pad("index kB", 9)} ${pad("toast kB", 9)} ${pad("total kB", 9)}`,
		)
		for (const [name, s] of [
			["base push", seedSize],
			["as the push workload leaves it", asLeft],
			["after VACUUM", afterVac],
			["after VACUUM FULL", afterFull],
		] as const) {
			console.log(
				`${padr(name, 22)} ${pad(kb(s.heap), 9)} ${pad(kb(s.indexes), 9)} ${pad(kb(s.toast), 9)} ${pad(kb(s.total), 9)}`,
			)
		}

		const totalIns = agg.ins - baseAgg.ins
		const totalDel = agg.del - baseAgg.del
		const totalUpd = agg.upd - baseAgg.upd
		if (totalIns !== 0 || totalDel !== 0 || totalUpd !== PUSHES) {
			throw new Error(
				`incremental projection wrote inserts=${totalIns}, deletes=${totalDel}, updates=${totalUpd}; expected 0/0/${PUSHES}`,
			)
		}
		const walTotal = walPerPush.reduce((a, b) => a + b, 0)
		if (walPerPush.length === 0 || walTotal <= 0) {
			throw new Error("projection WAL measurement recorded no work")
		}
		console.log(
			`\ntuples written across ${PUSHES} one-file pushes: ${totalIns} inserted, ${totalDel} deleted, ` +
				`${totalUpd} updated (${agg.hot - baseAgg.hot} HOT).`,
		)
		console.log(
			`per push that changed exactly ONE file: ${(totalUpd / PUSHES).toFixed(0)} row updated; ` +
				`amplification ${(totalUpd / PUSHES).toFixed(0)}× the changed file count.`,
		)
		console.log(
			`WAL: ${mb(walTotal)} MB over ${PUSHES} pushes = ${kb(walTotal / PUSHES)} kB per one-file push ` +
				`(the tree has ${FILES} files ≈ ${kb(FILES * 70)} kB of projection rows).`,
		)
		console.log(
			`\nHOT updates during measured pushes: ${agg.hot - baseAgg.hot}. The changed columns are unindexed, ` +
				`so updates are HOT-eligible when the occupied heap page has room; fillfactor remains 100 by the spine decision.`,
		)
		const hzEnd = await horizon(db.sql)
		console.log(
			`horizon at the end: lag ${hzEnd.ageXids} xids, oldest open client xact ${hzEnd.oldestXactSeconds.toFixed(0)}s`,
		)
		if (hzEnd.ageXids > 5000) {
			throw new Error(
				`vacuum horizon ended pinned by ${hzEnd.ageXids} xids; refusing to score bloat`,
			)
		}
		const ratio = asLeft.total / seedSize.total
		console.log(
			`\nsteady-state bloat: ${kb(asLeft.total)} kB on disk for the SAME ${agg.live} live rows ` +
				`the base push held in ${kb(seedSize.total)} kB = ${ratio.toFixed(2)}×\n` +
				`(compaction floor ${kb(afterFull.total)} kB; autovacuum ran ${agg.autovac} times over ${PUSHES} pushes).`,
		)
		if (occupied) {
			console.log(
				`\nVACUUM VERBOSE on ${occupied.relname}: removed ${verdict.removed}, ` +
					`${verdict.notRemovable} dead but NOT YET REMOVABLE.`,
			)
		}
		if (ratio > BLOAT_LIMIT) process.exitCode = 1
	} finally {
		await app.end()
		await db.drop()
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

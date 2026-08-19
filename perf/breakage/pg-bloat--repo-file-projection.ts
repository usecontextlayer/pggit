/**
 * pg-bloat--repo-file-projection — the cost of rebuilding the whole branch
 * snapshot on every push.
 *
 * `repo_file` is the per-branch-tip `path → (mode, blob_oid)` index that IS
 * pggit's public read surface. the full-rebuild path replaces it wholesale:
 * `delete from repo_file where repo_id = … and ref_name = …` followed by a COPY
 * of the ENTIRE new file list. So a push that changes one byte of one file
 * rewrites N rows for an N-file tree — and 0002's leaf reloptions say this is
 * deliberate ("delete-branch-then-insert … not a HOT-eligible in-place UPDATE",
 * hence no fillfactor reserve and an aggressive dead-tuple threshold).
 *
 * That decision has two measurable consequences this harness quantifies:
 *
 *   1. **Write amplification is O(tree), not O(change), forever.** Every push
 *      writes 2N tuples (N dead + N new). `n_tup_hot_upd` is structurally 0 —
 *      there are no UPDATEs at all, so the HOT machinery the churn-tuned tables
 *      rely on is not merely unused, it is unreachable.
 *   2. **Autovacuum thrash.** With `autovacuum_vacuum_threshold = 50` and
 *      `scale_factor = 0.0` on each of 16 leaves, N/16 dead rows per leaf per
 *      push means a tree of more than ~800 files makes EVERY push immediately
 *      eligible on EVERY partition. This is the only table in the schema whose
 *      autovacuum genuinely keeps up — and the price is a vacuum storm.
 *
 * WHAT IT PRINTS: per push, the projection's on-disk size split heap/index, its
 * live row count, dead tuples, tuples inserted/deleted/updated/HOT-updated, and
 * autovacuum passes; then the steady-state size against the VACUUM FULL floor.
 *
 * EXIT NON-ZERO when the projection's on-disk size exceeds `BLOAT_LIMIT`× what it
 * occupied after the base push, at an UNCHANGED live row count. That comparison is
 * between two states holding identical content, so unlike a VACUUM-FULL ratio it
 * stays meaningful when an unrelated long transaction has pinned the cluster's
 * vacuum horizon — a condition this instance is in most of the time.
 *
 *   npx tsx perf/breakage/pg-bloat--repo-file-projection.ts --files=4000 --pushes=60
 */
import { syncRefSnapshot } from "@/repo-view/rebuild"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	aggregate,
	backendWal,
	COMMITTER,
	DEFAULT_PG_URL,
	filler,
	flag,
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
	vacuumVerbose,
} from "./_pg-bloat-util"

/** tag so WAL and dead-tuple cost are attributable on a shared instance */
const PUSH_APP = "pgbloat-projection-under-test"

const REPO_ID = "workspace/slate/projection"
const BLOAT_LIMIT = 2.0

const PG_URL = flag("pg", DEFAULT_PG_URL)
const FILES = Number(flag("files", "4000"))
const PUSHES = Number(flag("pushes", "60"))

function baseStream(): string {
	const out: string[] = []
	let mark = 0
	const lines: string[] = []
	for (let i = 0; i < FILES; i++) {
		const content = `# f${i}\n${filler(`f${i}-v0`, 300)}\n`
		const m = ++mark
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		lines.push(`M 100644 :${m} src/d${i % 40}/f${i}.md`)
	}
	const cm = ++mark
	out.push(
		`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata 4\nbase\n${lines.join("\n")}\n`,
	)
	return out.join("")
}

function touchStream(gen: number): string {
	const i = gen % FILES
	const content = `# f${i}\n${filler(`f${i}-v${gen}`, 300)}\n`
	return (
		`blob\nmark :1\ndata ${Buffer.byteLength(content)}\n${content}\n` +
		`commit refs/heads/main\nmark :2\ncommitter ${COMMITTER}\ndata 5\ntouch\nfrom refs/heads/main^0\n` +
		`M 100644 :1 src/d${i % 40}/f${i}.md\n`
	)
}

async function main(): Promise<void> {
	const scratch = scratchRoot("proj")
	const db = await createIsolatedSchema(PG_URL)
	const app = taggedPool(PG_URL, db.schema, PUSH_APP)
	try {
		console.log(`# \`repo_file\` projection churn: O(tree) writes per O(1) push\n`)
		console.log(`schema ${db.schema} · ${FILES}-file tree · ${PUSHES} one-file pushes\n`)

		const hz0 = await horizon(db.sql)
		console.log(
			`vacuum horizon at start: lag ${hz0.ageXids} xids, oldest open client xact ${hz0.oldestXactSeconds.toFixed(0)}s\n`,
		)
		let horizonPinned = hz0.ageXids > 5000

		const src = scratch.dir("src")
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: baseStream() })

		const store = createObjectStore(app)
		const refs = createRefStore(app)
		const snapshots = createRepoFileProjection(app)
		const deps = { objects: store, snapshots }

		let tip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: src })
		).stdout.trim()
		const baseObjs = await objectsBetween(src, tip)
		await store.putPack(
			REPO_ID,
			baseObjs.map((o) => ({ content: o.content, type: o.type })),
		)
		await refs.setRef(REPO_ID, "refs/heads/main", tip)
		await syncRefSnapshot(deps, REPO_ID, "refs/heads/main", tip)

		const seedSize = await sizeOf(db.sql, "repo_file")
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
		let prevWal = await backendWal(db.sql, PUSH_APP)
		let lastSample = -1
		let lastIns = 0
		let lastDel = 0
		const walPerPush: number[] = []
		for (let p = 0; p < PUSHES; p++) {
			await spawnGit(["fast-import", "--quiet"], { cwd: src, input: touchStream(p + 1) })
			const newTip = (
				await spawnGit(["rev-parse", "refs/heads/main"], { cwd: src })
			).stdout.trim()
			const objs = await objectsBetween(src, newTip, tip)
			await store.putPack(
				REPO_ID,
				objs.map((o) => ({ content: o.content, type: o.type })),
			)
			await refs.setRef(REPO_ID, "refs/heads/main", newTip)
			await syncRefSnapshot(deps, REPO_ID, "refs/heads/main", newTip)
			tip = newTip

			if (p < 3 || (p + 1) % 10 === 0 || p === PUSHES - 1) {
				// Idle backends sit on their counters; drive them through a command cycle.
				await flushStats(app)
				const wal = await backendWal(db.sql, PUSH_APP)
				const span = p - lastSample
				walPerPush.push(wal - prevWal)
				const perPush = (wal - prevWal) / Math.max(span, 1)
				prevWal = wal
				lastSample = p
				const s = await sizeOf(db.sql, "repo_file")
				const agg = aggregate(await stats(db.sql, db.schema)).repo_file
				const hz = await horizon(db.sql)
				if (hz.ageXids > 5000) horizonPinned = true
				console.log(
					`${padr(p, 6)} ${pad(kb(s.heap), 9)} ${pad(kb(s.indexes), 9)} ${pad(kb(s.total), 9)} ` +
						`${pad(agg?.live ?? 0, 7)} ${pad(agg?.dead ?? 0, 7)} ${pad((agg?.ins ?? 0) - lastIns, 8)} ` +
						`${pad((agg?.del ?? 0) - lastDel, 8)} ${pad(agg?.upd ?? 0, 6)} ${pad(agg?.hot ?? 0, 6)} ` +
						`${pad(agg?.autovac ?? 0, 8)} ${pad(kb(perPush), 15)} ${pad(hz.ageXids, 8)}`,
				)
				lastIns = agg?.ins ?? 0
				lastDel = agg?.del ?? 0
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
		await vacuumAnalyze(db.sql, "repo_file")
		const afterVac = await sizeOf(db.sql, "repo_file")
		await vacuumFull(db.sql, "repo_file")
		const afterFull = await sizeOf(db.sql, "repo_file")
		const agg = aggregate(await stats(db.sql, db.schema)).repo_file

		console.log(`\n## steady state after ${PUSHES} pushes\n`)
		console.log(
			`${padr("state", 22)} ${pad("heap kB", 9)} ${pad("index kB", 9)} ${pad("toast kB", 9)} ${pad("total kB", 9)}`,
		)
		for (const [name, s] of [
			["base push", seedSize],
			["as the drain leaves it", asLeft],
			["after VACUUM", afterVac],
			["after VACUUM FULL", afterFull],
		] as const) {
			console.log(
				`${padr(name, 22)} ${pad(kb(s.heap), 9)} ${pad(kb(s.indexes), 9)} ${pad(kb(s.toast), 9)} ${pad(kb(s.total), 9)}`,
			)
		}

		const totalIns = agg?.ins ?? 0
		const totalDel = agg?.del ?? 0
		const walTotal = walPerPush.reduce((a, b) => a + b, 0)
		console.log(
			`\ntuples written across ${PUSHES} one-file pushes: ${totalIns} inserted, ${totalDel} deleted, ` +
				`${agg?.upd ?? 0} updated (${agg?.hot ?? 0} HOT).`,
		)
		console.log(
			`per push that changed exactly ONE file: ${(totalIns / (PUSHES + 1)).toFixed(0)} rows inserted + ` +
				`${(totalDel / PUSHES).toFixed(0)} deleted = ${((totalIns + totalDel) / PUSHES).toFixed(0)} tuple writes, ` +
				`amplification ${((totalIns + totalDel) / PUSHES).toFixed(0)}× the changed file count.`,
		)
		console.log(
			`WAL: ${mb(walTotal)} MB over ${PUSHES} pushes = ${kb(walTotal / PUSHES)} kB per one-file push ` +
				`(the tree has ${FILES} files ≈ ${kb(FILES * 70)} kB of projection rows).`,
		)
		console.log(
			`\nHOT updates: ${agg?.hot ?? 0}. The projection performs NO updates at all, so the ` +
				`fillfactor/HOT machinery cannot apply to it — 0002's "no fillfactor reserve" is correct,\n` +
				`and the entire defence is the dead-tuple threshold plus how fast autovacuum can run.`,
		)
		const ratio = seedSize.total > 0 ? asLeft.total / seedSize.total : 1
		console.log(
			`\nsteady-state bloat: ${kb(asLeft.total)} kB on disk for the SAME ${agg?.live ?? 0} live rows ` +
				`the base push held in ${kb(seedSize.total)} kB = ${ratio.toFixed(2)}×\n` +
				`(compaction floor ${kb(afterFull.total)} kB; autovacuum ran ${agg?.autovac ?? 0} times over ${PUSHES} pushes).`,
		)
		if (occupied) {
			console.log(
				`\nVACUUM VERBOSE on ${occupied.relname}: removed ${verdict.removed}, ` +
					`${verdict.notRemovable} dead but NOT YET REMOVABLE.`,
			)
		}
		const hzEnd = await horizon(db.sql)
		console.log(
			`horizon at the end: lag ${hzEnd.ageXids} xids, oldest open client xact ${hzEnd.oldestXactSeconds.toFixed(0)}s`,
		)
		if (horizonPinned) {
			console.log(
				`\n!! HORIZON WAS PINNED during this run. The write-amplification numbers (ins/del/HOT/\n` +
					`!! ownWAL) are unaffected and stand; the on-disk BLOAT trajectory measures\n` +
					`!! "nothing was removable", not "the tuning failed to fire". Re-run when clear.`,
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

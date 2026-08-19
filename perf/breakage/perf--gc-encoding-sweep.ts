/**
 * PROBE: what does the encoding tier's PRESENCE add to a zero-garbage gc pass?
 *
 * HISTORY (2026-08-16): this originally priced `sweepEncodings` (concern C2), a
 * delete-with-anti-join whose victim scan touched every encoding row on every
 * pass. D14 deleted that sweep — the 0008 FK cascades do the tier's bookkeeping
 * inside the object DELETEs — so the measured difference should now be ~zero,
 * and this probe survives as the REGRESSION GUARD for that: the bound firing
 * again means per-pass tier work crept back into `gc()`.
 *
 * Isolated black-box: the SAME repo, the SAME reachable graph, gc'd before the
 * encoding tier exists and again after a full repack. The difference is the
 * tier's standing cost on a pass.
 *
 *   npx tsx perf/breakage/perf--gc-encoding-sweep.ts [--sizes=250,500,1000,2000]
 */
import { rmSync } from "node:fs"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema } from "@/testing/pg"
import { cleanupTmp, flag, PG_URL, secs, seedRepo, table } from "./_perf-util"

const SIZES = flag("sizes", "250,500,1000,2000").split(",").map(Number)
const REPEATS = 5
/** Added share of a zero-garbage pass at which this is called broken. */
const OVERHEAD_LIMIT = 0.25

/** Best of N — the statistic that survives a loaded machine; a median moves with
 * whatever else the box is doing, and this probe subtracts two timings. */
const best = (xs: number[]): number => Math.min(...xs)

type Row = { n: number; objects: number; encodings: number; pre: number; post: number }

async function measure(n: number): Promise<Row> {
	const src = await createAppendOnlyRepo({ docs: 8, runs: n })
	try {
		const db = await createIsolatedSchema(PG_URL)
		try {
			const seeded = await seedRepo(db.sql, "probe/gc", src)
			const gc = createGc(db.sql)
			const pass = async (): Promise<number> => {
				const t0 = Date.now()
				const r = await gc.gc("probe/gc", { graceSeconds: 0, maintain: false })
				const ms = Date.now() - t0
				if (r.deletedObjects !== 0) {
					throw new Error(`expected zero garbage, got ${r.deletedObjects}`)
				}
				return ms
			}
			const pre: number[] = []
			for (let i = 0; i < REPEATS; i++) pre.push(await pass())
			const repacked = await createRepack(db.sql).repack("probe/gc")
			const post: number[] = []
			for (let i = 0; i < REPEATS; i++) post.push(await pass())
			return {
				encodings: repacked.wholes + repacked.deltas,
				n,
				objects: seeded.objects,
				post: best(post),
				pre: best(pre),
			}
		} finally {
			await db.drop()
		}
	} finally {
		rmSync(src, { force: true, recursive: true })
	}
}

async function main(): Promise<void> {
	const rows: Row[] = []
	for (const n of SIZES) rows.push(await measure(n))

	console.log("# gc pass cost, zero garbage — before vs after the encoding tier exists\n")
	console.log(
		table(
			[
				"commits",
				"objects",
				"encoding rows",
				"gc ms (no encodings, best of 5)",
				"gc ms (full tier, best of 5)",
				"added ms",
				"added %",
			],
			rows.map((r) => [
				r.n + 1,
				r.objects,
				r.encodings,
				r.pre,
				r.post,
				r.post - r.pre,
				`${(((r.post - r.pre) / r.pre) * 100).toFixed(0)}%`,
			]),
		),
	)

	const exps: (string | number)[][] = []
	for (let i = 1; i < rows.length; i++) {
		const a = rows[i - 1] as Row
		const b = rows[i] as Row
		const k = Math.log2(b.n / a.n)
		exps.push([
			`${a.n}→${b.n}`,
			(Math.log2(Math.max(b.post - b.pre, 1) / Math.max(a.post - a.pre, 1)) / k).toFixed(
				2,
			),
			(Math.log2(b.pre / a.pre) / k).toFixed(2),
		])
	}
	console.log("\n## growth exponent in repo size\n")
	console.log(table(["step", "sweep overhead exp", "baseline gc exp"], exps))

	const worst = Math.max(...rows.map((r) => (r.post - r.pre) / r.pre))
	console.log(
		`\nFAIL CONDITION: the tier's presence adds > ${(OVERHEAD_LIMIT * 100).toFixed(0)}% to a zero-garbage gc pass (regression guard — the sweep itself is gone, D14).`,
	)
	console.log(`observed worst: ${(worst * 100).toFixed(0)}%`)
	if (worst > OVERHEAD_LIMIT) process.exitCode = 1
	console.log(`(largest pass: ${secs((rows[rows.length - 1] as Row).post)}s)`)
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

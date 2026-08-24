/**
 * PROBE: what does the encoding tier's PRESENCE add to a zero-garbage gc pass?
 *
 * Encoding rows are removed by foreign-key cascades during object deletion, so
 * the tier's presence should add approximately no work to a pass that deletes
 * nothing. The bound catches any per-pass tier work added to `gc()`.
 *
 * Isolated black-box: the SAME repo, the SAME reachable graph, gc'd before the
 * encoding tier exists and again after a full repack. The difference is the
 * tier's standing cost on a pass.
 *
 *   npx tsx perf/probes/perf/gc-encoding-sweep.ts [--sizes=250,500,1000,2000]
 */
import { rmSync } from "node:fs"
import { increasingIntegerListArg, parseArgs, pgUrlArg } from "@perf/args"
import { table } from "@perf/probes/_table"
import { cleanupTmp, secs, seedRepo } from "@perf/probes/perf/_util"
import { z } from "zod"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	loadAllReachableObjects,
	repackEligibleObjects,
	requiredAt,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"

const { pg: PG_URL, sizes: SIZES } = parseArgs(
	z
		.object({
			pg: pgUrlArg,
			sizes: increasingIntegerListArg([250, 500, 1000, 2000]),
		})
		.strict(),
)
const REPEATS = 5
/** Added share of a zero-garbage pass at which this is called broken. */
const OVERHEAD_LIMIT = 0.25

/** The minimum reduces contention contamination before subtracting independent timings. */
const best = (xs: number[]): number => Math.min(...xs)

type Row = { n: number; objects: number; encodings: number; pre: number; post: number }

async function measure(n: number): Promise<Row> {
	const src = await createAppendOnlyRepo({ docs: 8, runs: n })
	try {
		const db = await createIsolatedSchema(PG_URL)
		try {
			const objects = await loadAllReachableObjects(src)
			const seeded = await seedRepo(db.sql, "probe/gc", src, objects)
			const gc = createGc(db.sql)
			const pass = async (expectedEpoch: "rebuilt" | "unchanged"): Promise<number> => {
				const t0 = Date.now()
				const r = await gc.gc("probe/gc", { graceSeconds: 0, maintain: false })
				const ms = Date.now() - t0
				if (r.deletedObjects !== 0 || r.epoch !== expectedEpoch) {
					throw new Error(
						`expected zero garbage and epoch ${expectedEpoch}, got deleted=${r.deletedObjects}, epoch=${r.epoch}`,
					)
				}
				if (ms <= 0) throw new Error("GC timer recorded a nonpositive latency")
				return ms
			}
			const pre = [await pass("rebuilt")]
			for (let i = 1; i < REPEATS; i++) pre.push(await pass("unchanged"))
			const repacked = await createRepack(db.sql).repack("probe/gc")
			const encodings = repacked.wholes + repacked.deltas
			if (encodings !== seeded.eligibleObjects) {
				throw new Error(
					`repack covered ${encodings}/${seeded.eligibleObjects} eligible objects`,
				)
			}
			const [count] = await db.sql<{ n: string }[]>`
				select count(*)::text as n from git_pack_encoding`
			if (!count || Number(count.n) !== seeded.eligibleObjects) {
				throw new Error(
					`encoding tier has ${count?.n ?? "no count"} rows, expected ${seeded.eligibleObjects}`,
				)
			}
			await assertCanonicalStoreFixture(db.sql, "probe/gc", {
				encodings: { kind: "exact", objects: repackEligibleObjects(objects) },
				objects,
				refs: await canonicalStoreRefsOf(src),
			})
			const post: number[] = []
			for (let i = 0; i < REPEATS; i++) post.push(await pass("unchanged"))
			await assertCanonicalStoreFixture(db.sql, "probe/gc", {
				encodings: { kind: "exact", objects: repackEligibleObjects(objects) },
				objects,
				refs: await canonicalStoreRefsOf(src),
			})
			return {
				encodings,
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
		const a = requiredAt(rows, i - 1, "previous GC encoding-sweep measurement")
		const b = requiredAt(rows, i, "current GC encoding-sweep measurement")
		const k = Math.log2(b.n / a.n)
		const aAdded = a.post - a.pre
		const bAdded = b.post - b.pre
		exps.push([
			`${a.n}→${b.n}`,
			aAdded > 0 && bAdded > 0
				? (Math.log2(bAdded / aAdded) / k).toFixed(2)
				: "n/a (nonpositive added cost)",
			(Math.log2(b.pre / a.pre) / k).toFixed(2),
		])
	}
	console.log("\n## growth exponent in repo size\n")
	console.log(table(["step", "sweep overhead exp", "baseline gc exp"], exps))

	const worst = Math.max(...rows.map((r) => (r.post - r.pre) / r.pre))
	console.log(
		`\nFAIL CONDITION: the tier's presence adds > ${(OVERHEAD_LIMIT * 100).toFixed(0)}% to a zero-garbage gc pass.`,
	)
	console.log(`observed worst: ${(worst * 100).toFixed(0)}%`)
	if (worst > OVERHEAD_LIMIT) process.exitCode = 1
	const largest = requiredAt(
		rows,
		rows.length - 1,
		"largest GC encoding-sweep measurement",
	)
	console.log(`(largest pass: ${secs(largest.post)}s)`)
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

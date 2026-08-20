/**
 * PROBE: how does `createRepack().repack()` scale in history length on the shape
 * the whole delta-pack design exists for — a flat, append-only directory that
 * gains one run-uuid subdir per commit (CodeCreators' `komal`)?
 *
 * The shape's tree bytes are inherently QUADRATIC in commit count, so absolute
 * time must grow ~N². The question is whether pggit grows FASTER than the data,
 * and how its wall compares to real `git repack -adf` doing the equivalent job on
 * the identical object set. Peak process RSS is sampled through the pass
 * (design concern C1: the content cache is unbounded).
 *
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--repack-history-scaling.ts [--sizes=250,500,1000,2000]
 */
import { rmSync } from "node:fs"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema } from "@/testing/pg"
import {
	cleanupTmp,
	gitRepack,
	increasingIntegerListFlag,
	mb,
	PG_URL,
	reachableObjects,
	secs,
	seedRepo,
	table,
	withPeakRss,
} from "./_perf-util"

const SIZES = increasingIntegerListFlag("sizes", [250, 500, 1000, 2000])

/** Ratio at which pggit's repack is declared divergent from git's. */
const WALL_RATIO_LIMIT = 10
/** Growth of that ratio per doubling above which the curve is super-linear vs git. */
const DIVERGENCE_LIMIT = 1.4

type Row = {
	n: number
	objects: number
	treeMb: number
	pggitMs: number
	pggitRss: number
	gitMs: number
	gitRss: number
	gitPack: number
	deltas: number
	wholes: number
}

async function measure(n: number): Promise<Row> {
	const dir = await createAppendOnlyRepo({ docs: 8, runs: n })
	try {
		const objects = await reachableObjects(dir)
		const treeBytes = objects
			.filter((o) => o.type === "tree")
			.reduce((a, o) => a + o.content.length, 0)
		if (objects.length === 0 || treeBytes === 0) {
			throw new Error(
				`fixture is empty: objects=${objects.length}, treeBytes=${treeBytes}`,
			)
		}
		const git = await gitRepack(dir, `scale-git-${n}`)
		if (git.packBytes <= 0 || git.peakRss <= 0 || git.ms <= 0) {
			throw new Error("git repack metrics missing")
		}
		const db = await createIsolatedSchema(PG_URL)
		try {
			await seedRepo(db.sql, "probe/scale", dir, objects)
			const repack = createRepack(db.sql)
			const r = await withPeakRss(() => repack.repack("probe/scale"))
			if (
				r.ms <= 0 ||
				r.peakRss <= r.baseRss ||
				r.value.wholes + r.value.deltas !== objects.length ||
				r.value.deltas === 0
			) {
				throw new Error(
					`repack produced ${r.value.wholes} wholes + ${r.value.deltas} deltas for ${objects.length} objects`,
				)
			}
			return {
				deltas: r.value.deltas,
				gitMs: git.ms,
				gitPack: git.packBytes,
				gitRss: git.peakRss,
				n,
				objects: objects.length,
				pggitMs: r.ms,
				pggitRss: r.peakRss - r.baseRss,
				treeMb: treeBytes,
				wholes: r.value.wholes,
			}
		} finally {
			await db.drop()
		}
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

async function main(): Promise<void> {
	const rows: Row[] = []
	for (const n of SIZES) rows.push(await measure(n))

	console.log("# repack scaling in history length (append-only flat dir)\n")
	console.log(
		table(
			[
				"commits",
				"objects",
				"tree MB",
				"pggit repack s",
				"pggit ΔRSS MB",
				"git repack s",
				"git peak RSS MB",
				"git pack MB",
				"pggit/git",
				"encodings",
			],
			rows.map((r) => [
				r.n + 1,
				r.objects,
				mb(r.treeMb),
				secs(r.pggitMs),
				mb(r.pggitRss),
				secs(r.gitMs),
				mb(r.gitRss),
				mb(r.gitPack),
				`${(r.pggitMs / r.gitMs).toFixed(1)}×`,
				`${r.wholes}w+${r.deltas}d`,
			]),
		),
	)

	console.log("\n## scaling exponents (log2 of the ratio between successive doublings)\n")
	const exps: (string | number)[][] = []
	for (let i = 1; i < rows.length; i++) {
		const a = rows[i - 1] as Row
		const b = rows[i] as Row
		const k = Math.log2(b.n / a.n)
		exps.push([
			`${a.n}→${b.n}`,
			(Math.log2(b.pggitMs / a.pggitMs) / k).toFixed(2),
			(Math.log2(b.gitMs / a.gitMs) / k).toFixed(2),
			(Math.log2(b.treeMb / a.treeMb) / k).toFixed(2),
			(Math.log2(b.pggitRss / a.pggitRss) / k).toFixed(2),
			(b.pggitMs / b.gitMs / (a.pggitMs / a.gitMs)).toFixed(2),
		])
	}
	console.log(
		table(
			[
				"step",
				"pggit time exp",
				"git time exp",
				"tree bytes exp",
				"pggit RSS exp",
				"ratio growth",
			],
			exps,
		),
	)

	const last = rows[rows.length - 1] as Row
	const ratio = last.pggitMs / last.gitMs
	const worstGrowth = Math.max(...exps.map((e) => Number(e[5])))
	console.log(
		`\nFAIL CONDITION: pggit/git wall ratio > ${WALL_RATIO_LIMIT}× at the largest N,` +
			` or that ratio growing > ${DIVERGENCE_LIMIT}× per doubling.`,
	)
	console.log(
		`observed: ratio ${ratio.toFixed(1)}× at ${last.n + 1} commits, worst ratio growth ${worstGrowth.toFixed(2)}×/doubling`,
	)
	if (ratio > WALL_RATIO_LIMIT || worstGrowth > DIVERGENCE_LIMIT) process.exitCode = 1
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

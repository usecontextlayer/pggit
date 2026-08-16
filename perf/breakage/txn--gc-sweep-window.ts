/**
 * PROBE 5 — how WIDE is the window that probe 1's torn state needs?
 *
 * `gc()` sweeps objects -> edges -> encodings. The encoding sweep is the repair
 * that keeps the derived tier consistent, and it is scheduled LAST, behind the
 * edge sweep. This times each sweep so the exposure is a number, not a worry.
 *
 * Probe 1 (`src/e2e/breakage/txn--torn-gc-wedges-repack.test.ts`) shows WHAT a
 * crash between the object sweep and the encoding sweep leaves behind; this shows
 * HOW LIKELY that is — every millisecond before the encoding sweep starts is a
 * millisecond in which a deploy, a dropped connection, an OOM or a statement
 * timeout produces the torn tier. The edge sweep is the slowest on a real repo
 * (1.1M kind-3 rows per the design doc's W5), so it dominates that window.
 *
 * It is a PERF harness, not a vitest test, because its verdict is a TIMING
 * MEASUREMENT — how the pass's milliseconds divide between the three sweeps. Like
 * `perf/delta-probe.ts` it is one-shot and diagnostic: not a gate, no threshold,
 * exits non-zero only if the pass itself throws.
 *
 *   npx tsx perf/breakage/txn--gc-sweep-window.ts
 *   npx tsx perf/breakage/txn--gc-sweep-window.ts --pg=postgres://…
 */
import { rmSync } from "node:fs"
import type { Sql } from "postgres"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { PG_URL, table } from "./_txn-util"

const REPO = "r"
const RUNS = 300
/** Where main is rewound to before the sweep — leaves ~270 commits of garbage. */
const REWIND_TO = 30

/** Time every `unsafe()` statement, bucketed by which sweep issued it. */
function timed(pg: Sql, into: Map<string, number>): Sql {
	return new Proxy(pg, {
		get(target, prop, receiver) {
			if (prop !== "unsafe") return Reflect.get(target, prop, receiver)
			const real = Reflect.get(target, prop, target) as Sql["unsafe"]
			return async (sql: string, ...rest: unknown[]) => {
				const bucket = sql.includes("git_pack_encoding")
					? "encodings"
					: sql.includes("git_edge")
						? "edges"
						: sql.includes("git_object")
							? "objects"
							: "other"
				const t = performance.now()
				try {
					return await (real as (s: string, ...r: unknown[]) => Promise<unknown>).call(
						target,
						sql,
						...rest,
					)
				} finally {
					into.set(bucket, (into.get(bucket) ?? 0) + (performance.now() - t))
				}
			}
		},
	}) as Sql
}

async function main(): Promise<void> {
	const src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
	const commits = await commitsOldestFirst(src)
	const rewindTo = commits[REWIND_TO]
	if (!rewindTo) throw new Error(`fixture too short: no commit #${REWIND_TO}`)
	const db = await createIsolatedSchema(PG_URL)
	try {
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		await seedRepoIntoStore(REPO, src, { objects, refs })
		await createRepack(db.sql).repack(REPO)
		await refs.setRef(REPO, "refs/heads/main", rewindTo)

		console.log(
			`# txn--gc-sweep-window — ${RUNS} runs, main rewound to commit #${REWIND_TO}\n`,
		)
		const perSweep = new Map<string, number>()
		const res = await createGc(timed(db.sql, perSweep)).gc(REPO, {
			graceSeconds: 0,
			maintain: false,
		})
		console.log(
			`reclaimed: ${res.deletedObjects} objects, ${res.deletedEdges} edges, ` +
				`${res.deletedEncodings} encodings\n`,
		)

		const total = [...perSweep.values()].reduce((a, b) => a + b, 0)
		console.log(
			table(
				["sweep", "ms", "share"],
				[...perSweep].map(([sweep, ms]) => [
					sweep,
					ms.toFixed(0),
					`${((ms / total) * 100).toFixed(1)}%`,
				]),
			),
		)

		const exposure = total - (perSweep.get("encodings") ?? 0)
		console.log(
			`\nexposure window = everything BEFORE the encoding sweep = ` +
				`${exposure.toFixed(0)} ms of the ${total.toFixed(0)} ms pass ` +
				`(${((exposure / total) * 100).toFixed(1)}%)`,
		)
	} finally {
		await db.drop()
		rmSync(src, { force: true, recursive: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

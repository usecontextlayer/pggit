/**
 * PROBE 5 — how do a GC pass's milliseconds divide between its sweeps?
 *
 * HISTORY (2026-08-16): this originally timed the window between the object
 * sweep and the ENCODING sweep — the exposure in which a crash left probe 1's
 * torn tier. D14 deleted the encoding sweep (the 0008 FK cascades take the
 * dependent rows inside the object DELETEs), so that window no longer exists and
 * probe 1 now pins its unrepresentability instead. What remains worth timing:
 * the object-vs-edge sweep split — the edge sweep is the slowest on a real repo
 * (1.1M kind-3 rows per the design doc's W5) — and the object sweep's own
 * duration, which now carries the cascade work the encoding sweep used to do.
 *
 * It is a PERF harness, not a vitest test, because its verdict is a TIMING
 * MEASUREMENT — how the pass's milliseconds divide between the sweeps. Like
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
/** Times every `unsafe` statement by the table it names. Must wrap `reserve()`
 * too: the reshaped gc (D12) runs its sweeps on a reserved connection's `unsafe`,
 * not the pool's — a pool-only proxy would leave every bucket empty. */
function timed(pg: Sql, into: Map<string, number>): Sql {
	const wrap = <T extends object>(target: T): T =>
		new Proxy(target, {
			get(t, prop, receiver) {
				if (prop === "reserve") {
					const real = Reflect.get(t, prop, t) as Sql["reserve"]
					return async () => wrap(await real.call(t))
				}
				if (prop !== "unsafe") return Reflect.get(t, prop, receiver)
				const real = Reflect.get(t, prop, t) as Sql["unsafe"]
				return async (sql: string, ...rest: unknown[]) => {
					const bucket = sql.includes("git_pack_encoding")
						? "encodings"
						: sql.includes("git_edge")
							? "edges"
							: sql.includes("git_object")
								? "objects"
								: "other"
					const t0 = performance.now()
					try {
						return await (real as (s: string, ...r: unknown[]) => Promise<unknown>).call(
							t,
							sql,
							...rest,
						)
					} finally {
						into.set(bucket, (into.get(bucket) ?? 0) + (performance.now() - t0))
					}
				}
			},
		})
	return wrap(pg)
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
			`reclaimed: ${res.deletedObjects} objects, ${res.deletedEdges} edges ` +
				`(encodings cascade with the object sweep since 0008)\n`,
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

		// The old "exposure window before the encoding sweep" no longer exists (D14:
		// cascades removed the sweep); what remains worth printing is the split.
		const objectMs = perSweep.get("objects") ?? 0
		console.log(
			`\nobject sweep (now carrying the cascade work) = ${objectMs.toFixed(0)} ms ` +
				`of the ${total.toFixed(0)} ms pass (${total > 0 ? ((objectMs / total) * 100).toFixed(1) : "0"}%)`,
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

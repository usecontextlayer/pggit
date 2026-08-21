/**
 * PROBE 5 — how do a GC pass's measured SQL milliseconds divide between the object sweep and the surrounding pass work?
 *
 * HISTORY (2026-08-16): this originally timed separate object, edge, and encoding sweeps. D14 deleted the encoding sweep in favor of the 0008 FK cascade, and spine S2 deleted `git_edge` and its sweep entirely. The only destructive statement left is the object sweep; its transaction now carries the commit/tag/encoding cascades. This probe measures that current shape instead of preserving retired sweep vocabulary.
 *
 * It is a PERF harness, not a vitest test, because its verdict is a TIMING MEASUREMENT. Like `perf/probes/delta-probe.ts` it is one-shot and diagnostic: not a performance gate, but it fails loudly if the fixture reclaims no objects or the timing wrapper observes no object-sweep statement.
 *
 *   npx tsx perf/probes/txn/gc-sweep-window.ts
 *   npx tsx perf/probes/txn/gc-sweep-window.ts --pg=postgres://…
 */
import { rmSync } from "node:fs"
import { parseArgs, pgUrlArg } from "@perf/args"
import { requiredPositiveMeasurement } from "@perf/collector-evidence"
import { table } from "@perf/probes/_table"
import type { Sql } from "postgres"
import { z } from "zod"
import { createGc } from "@/store/gc"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { commitsOldestFirst, createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	loadGitObjects,
	parseRevListObjectOids,
	repackEligibleObjects,
	requireGitOid,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "r"
const { pg: PG_URL } = parseArgs(z.object({ pg: pgUrlArg }).strict())
const RUNS = 300
/** Where main is rewound to before the sweep — leaves ~270 commits of garbage. */
const REWIND_TO = 30

/** Times every `unsafe` statement by the table it names. Must wrap `reserve()` too: the reshaped GC runs its sweep on a reserved connection's `unsafe`, so a pool-only proxy would leave every bucket empty. */
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
					const bucket = sql.includes("git_object") ? "objects" : "other"
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
		const canonicalObjects = await loadGitObjects(src, await allObjectOids(src))
		await seedRepoIntoStore(REPO, src, { objects, refs })
		const repack = await createRepack(db.sql).repack(REPO)
		if (repack.wholes + repack.deltas === 0 || repack.deltas === 0) {
			throw new Error(
				`gc timing fixture did not establish a delta tier (${repack.wholes} wholes, ${repack.deltas} deltas)`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, REPO, {
			encodings: { kind: "exact", objects: repackEligibleObjects(canonicalObjects) },
			objects: canonicalObjects,
			refs: await canonicalStoreRefsOf(src),
		})
		const sourceOids = new Set(
			parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", "HEAD"], { cwd: src })).stdout,
			),
		)
		const expectedLiveOids = new Set(
			parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", rewindTo], { cwd: src })).stdout,
			),
		)
		const expectedLiveObjects = await loadGitObjects(src, [...expectedLiveOids])
		const [beforeCensus] = await db.sql<{ objects: number }[]>`
			select count(*)::int as objects from git_object`
		if (!beforeCensus || beforeCensus.objects !== sourceOids.size) {
			throw new Error(
				`pre-GC object census ${beforeCensus?.objects ?? "missing"}/${sourceOids.size}`,
			)
		}
		await refs.setRef(REPO, "refs/heads/main", rewindTo)

		console.log(
			`# txn--gc-sweep-window — ${RUNS} runs, main rewound to commit #${REWIND_TO}\n`,
		)
		const perSweep = new Map<string, number>()
		const res = await createGc(timed(db.sql, perSweep)).gc(REPO, {
			graceSeconds: 0,
			maintain: false,
		})
		const expectedDeleted = sourceOids.size - expectedLiveOids.size
		const [afterCensus] = await db.sql<{ objects: number }[]>`
			select count(*)::int as objects from git_object`
		if (
			expectedDeleted <= 0 ||
			res.deletedObjects !== expectedDeleted ||
			!afterCensus ||
			afterCensus.objects !== expectedLiveOids.size
		) {
			throw new Error(
				`gc fixture census mismatch: deleted ${res.deletedObjects}/${expectedDeleted}, live ${afterCensus?.objects ?? "missing"}/${expectedLiveOids.size}`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, REPO, {
			encodings: { kind: "exact", objects: repackEligibleObjects(expectedLiveObjects) },
			objects: expectedLiveObjects,
			refs: [
				{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
				{
					kind: "direct",
					name: "refs/heads/main",
					oid: requireGitOid(rewindTo, "GC sweep rewind tip"),
				},
			],
		})
		console.log(
			`reclaimed: ${res.deletedObjects} objects ` +
				`(encodings + commit/tag rows cascade with the object sweep, 0008/0009)\n`,
		)

		const total = [...perSweep.values()].reduce((a, b) => a + b, 0)
		const objectMs = requiredPositiveMeasurement(perSweep, "objects", "GC SQL timing")
		if (!Number.isFinite(total) || total <= 0)
			throw new Error("GC SQL timing total is invalid")
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

		console.log(
			`\nobject sweep (now carrying the cascade work) = ${objectMs.toFixed(0)} ms ` +
				`of the ${total.toFixed(0)} ms pass (${((objectMs / total) * 100).toFixed(1)}%)`,
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

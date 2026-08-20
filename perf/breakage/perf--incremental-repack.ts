/**
 * PROBE: after the first backfill, what does a repack pass cost when ONE commit
 * has landed?
 *
 * This is the steady-state repack cost. `repack()` reads the inventory, existing
 * encoding tier, and derived commit topology before it can discover that only
 * one tip's objects are new. The question is whether the pass costs O(new work)
 * or O(whole repo).
 *
 * Black-box: seed everything except the last commit's objects, repack (backfill),
 * then seed the last commit's objects and time a SECOND repack. `git repack -adf`
 * on the whole repo is printed beside it for scale. The second pass must also
 * cover exactly the new objects — a pass that silently under-encodes would look
 * fast for the wrong reason, so that count is checked, not just timed.
 *
 *   npx tsx perf/breakage/perf--incremental-repack.ts [--sizes=250,500,1000,2000]
 */
import { rmSync } from "node:fs"
import type { Sql } from "postgres"
import { z } from "zod"
import { createObjectStore } from "@/store/object-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	type GitObjectWithOid,
	gitReachableOids,
	loadGitObjects,
	parseRevListObjectOids,
	repackEligibleObjects,
	requiredAt,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { increasingIntegerListArg, parseArgs, pgUrlArg } from "../args"
import { cleanupTmp, gitRepack, secs, table } from "./_perf-util"

const { pg: PG_URL, sizes: SIZES } = parseArgs(
	z
		.object({
			pg: pgUrlArg,
			sizes: increasingIntegerListArg([250, 500, 1000, 2000]),
		})
		.strict(),
)
/** Growth exponent of the one-commit pass above which it is O(repo), not O(work). */
const EXP_LIMIT = 0.5

type Row = {
	n: number
	objects: number
	newEncodings: number
	backfillMs: number
	incrementalMs: number
	gitMs: number
}

async function seedSubset(
	sql: Sql,
	repoId: string,
	objs: GitObjectWithOid[],
): Promise<void> {
	const store = createObjectStore(sql)
	let batch: GitObjectWithOid[] = []
	let bytes = 0
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return
		await store.putPack(
			repoId,
			batch.map((o) => ({
				content: o.content,
				type: o.type,
			})),
		)
		batch = []
		bytes = 0
	}
	for (const o of objs) {
		batch.push(o)
		bytes += o.content.length
		if (bytes >= 16_000_000 || batch.length >= 20_000) await flush()
	}
	await flush()
}

async function measure(n: number): Promise<Row> {
	const dir = await createAppendOnlyRepo({ docs: 8, runs: n })
	try {
		const all = await loadGitObjects(dir, await gitReachableOids(dir))
		const prior = new Set(
			parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", "HEAD~1"], { cwd: dir })).stdout,
			),
		)
		const base = all.filter((o) => prior.has(o.oid))
		const fresh = all.filter((o) => !prior.has(o.oid))
		const eligibleBase = repackEligibleObjects(base)
		const eligibleFresh = repackEligibleObjects(fresh)
		if (base.length === 0 || fresh.length === 0) {
			throw new Error(
				`fixture split is vacuous: base=${base.length}, fresh=${fresh.length}`,
			)
		}
		const git = await gitRepack(dir, `inc-repack-git-${n}`)

		const db = await createIsolatedSchema(PG_URL)
		try {
			await seedSubset(db.sql, "probe/incrp", base)
			await assertCanonicalStoreFixture(db.sql, "probe/incrp", {
				encodings: { kind: "exact", objects: [] },
				objects: base,
				refs: [],
			})
			const repack = createRepack(db.sql)
			const t0 = Date.now()
			const backfill = await repack.repack("probe/incrp")
			const backfillMs = Date.now() - t0
			if (
				backfill.wholes + backfill.deltas !== eligibleBase.length ||
				backfill.deltas <= 0
			) {
				throw new Error(
					`backfill covered ${backfill.wholes + backfill.deltas}/${eligibleBase.length} eligible base objects with ${backfill.deltas} deltas`,
				)
			}
			await assertCanonicalStoreFixture(db.sql, "probe/incrp", {
				encodings: { kind: "exact", objects: eligibleBase },
				objects: base,
				refs: [],
			})
			await seedSubset(db.sql, "probe/incrp", fresh)
			await assertCanonicalStoreFixture(db.sql, "probe/incrp", {
				encodings: { kind: "exact", objects: eligibleBase },
				objects: all,
				refs: [],
			})
			const t1 = Date.now()
			const r = await repack.repack("probe/incrp")
			const incrementalMs = Date.now() - t1
			if (backfillMs <= 0 || incrementalMs <= 0 || git.ms <= 0) {
				throw new Error("repack timer recorded a nonpositive latency")
			}
			if (r.wholes + r.deltas !== eligibleFresh.length || r.deltas <= 0) {
				throw new Error(
					`expected ${eligibleFresh.length} new eligible encodings including deltas, got ${r.wholes} wholes + ${r.deltas} deltas`,
				)
			}
			await assertCanonicalStoreFixture(db.sql, "probe/incrp", {
				encodings: { kind: "exact", objects: repackEligibleObjects(all) },
				objects: all,
				refs: [],
			})
			return {
				backfillMs,
				gitMs: git.ms,
				incrementalMs,
				n,
				newEncodings: eligibleFresh.length,
				objects: all.length,
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

	console.log("# steady-state repack: ONE new commit on an already-encoded repo\n")
	console.log(
		table(
			[
				"commits",
				"objects in repo",
				"new eligible objects",
				"backfill s",
				"one-commit pass ms",
				"ms per new object",
				"git repack -adf s (whole repo)",
			],
			rows.map((r) => [
				r.n + 1,
				r.objects,
				r.newEncodings,
				secs(r.backfillMs),
				r.incrementalMs,
				(r.incrementalMs / r.newEncodings).toFixed(1),
				secs(r.gitMs),
			]),
		),
	)

	const exps: (string | number)[][] = []
	for (let i = 1; i < rows.length; i++) {
		const a = requiredAt(rows, i - 1, "previous incremental-repack measurement")
		const b = requiredAt(rows, i, "current incremental-repack measurement")
		const k = Math.log2(b.n / a.n)
		exps.push([
			`${a.n}→${b.n}`,
			(Math.log2(b.incrementalMs / a.incrementalMs) / k).toFixed(2),
		])
	}
	console.log("\n## growth of the one-commit pass in repo size (0 = O(new work))\n")
	console.log(table(["step", "exponent"], exps))

	const worst = Math.max(...exps.map((e) => Number(e[1])))
	console.log(
		`\nFAIL CONDITION: the one-commit pass grows with repo size (exponent > ${EXP_LIMIT}).`,
	)
	console.log(`observed worst exponent: ${worst.toFixed(2)}`)
	if (worst > EXP_LIMIT) process.exitCode = 1
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

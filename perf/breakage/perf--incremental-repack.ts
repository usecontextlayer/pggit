/**
 * PROBE: after the first backfill, what does a repack pass cost when ONE commit
 * has landed?
 *
 * This is the steady-state drain cost — the thing that runs on every cadence for
 * every repo, forever. `repack()` re-reads the whole inventory (`pending`), the
 * whole encoding table (`existing`), and every commit OBJECT'S CONTENT
 * (`commitDiffOrder`) before it can discover that only one tree is new. The
 * question is whether the pass costs O(new work) or O(whole repo).
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
import { createObjectStore } from "@/store/object-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	cleanupTmp,
	flag,
	gitRepack,
	type Obj,
	PG_URL,
	reachableObjects,
	secs,
	table,
} from "./_perf-util"

const SIZES = flag("sizes", "250,500,1000,2000").split(",").map(Number)
/** Growth exponent of the one-commit pass above which it is O(repo), not O(work). */
const EXP_LIMIT = 0.5

type Row = {
	n: number
	objects: number
	newObjects: number
	backfillMs: number
	incrementalMs: number
	gitMs: number
}

async function seedSubset(
	// biome-ignore lint/suspicious/noExplicitAny: porsager Sql, structural
	sql: any,
	repoId: string,
	objs: Obj[],
): Promise<void> {
	const store = createObjectStore(sql)
	let batch: Obj[] = []
	let bytes = 0
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return
		await store.putPack(
			repoId,
			batch.map((o) => ({
				content: o.content,
				type: o.type as "blob" | "commit" | "tag" | "tree",
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
		const all = await reachableObjects(dir)
		const prior = new Set(
			(await spawnGit(["rev-list", "--objects", "HEAD~1"], { cwd: dir })).stdout
				.split("\n")
				.map((l) => l.slice(0, 40))
				.filter((o) => /^[0-9a-f]{40}$/.test(o)),
		)
		const base = all.filter((o) => prior.has(o.oid))
		const fresh = all.filter((o) => !prior.has(o.oid))
		const git = await gitRepack(dir, `inc-repack-git-${n}`)

		const db = await createIsolatedSchema(PG_URL)
		try {
			await seedSubset(db.sql, "probe/incrp", base)
			const repack = createRepack(db.sql)
			const t0 = Date.now()
			await repack.repack("probe/incrp")
			const backfillMs = Date.now() - t0
			await seedSubset(db.sql, "probe/incrp", fresh)
			const t1 = Date.now()
			const r = await repack.repack("probe/incrp")
			const incrementalMs = Date.now() - t1
			if (r.wholes + r.deltas !== fresh.length) {
				throw new Error(
					`expected ${fresh.length} new encodings, got ${r.wholes + r.deltas}`,
				)
			}
			return {
				backfillMs,
				gitMs: git.ms,
				incrementalMs,
				n,
				newObjects: fresh.length,
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
				"new objects",
				"backfill s",
				"one-commit pass ms",
				"ms per new object",
				"git repack -adf s (whole repo)",
			],
			rows.map((r) => [
				r.n + 1,
				r.objects,
				r.newObjects,
				secs(r.backfillMs),
				r.incrementalMs,
				(r.incrementalMs / r.newObjects).toFixed(1),
				secs(r.gitMs),
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
			(Math.log2(b.incrementalMs / Math.max(a.incrementalMs, 1)) / k).toFixed(2),
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

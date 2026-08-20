/**
 * PROBE: what does the reachability epoch (spine chunk 5b, S6) actually save a
 * COLD CLONE, in Postgres round-trips and bytes-shaped reads?
 *
 * The same repo is cloned off the wire twice through counting porsager clients:
 * once BEFORE any drain (no epoch — the serve walks `fullClosure`, reading every
 * commit row and every tree's content), once AFTER one gc pass produced the
 * epoch (the serve ORs stored bitmaps — the walk disappears). The driver's
 * public `debug` hook counts queries; nothing inside pggit is touched. Both
 * clones are fsck'd and must transfer the identical object set — a cheap serve
 * that serves the wrong bytes cannot win.
 *
 * Exit 1 when the epoch-served clone does not cut serve-phase queries by at
 * least MIN_QUERY_FACTOR at the largest size — directional, deliberately far
 * under the design's ~230× at 10× scale (the ratio grows with history depth;
 * a local fixture is shallow).
 *
 *   npx tsx perf/breakage/perf--bitmap-clone-queries.ts [--sizes=250,500,1000,2000]
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { allObjectOids, revParse } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { increasingIntegerListFlag, mkTmp, PG_URL, seedRepo, table } from "./_perf-util"

const SIZES = increasingIntegerListFlag("sizes", [250, 500, 1000, 2000])
const REPO = "probe/bitmap-clone"
/** The largest size must cut clone-serve queries by at least this factor. */
const MIN_QUERY_FACTOR = 5

type Counter = { n: number }

function countingClient(schema: string): { sql: postgres.Sql; c: Counter } {
	const c: Counter = { n: 0 }
	const sql = postgres(PG_URL, {
		connection: { search_path: schema },
		debug: () => {
			c.n++
		},
		max: 4,
		onnotice: () => {},
	})
	return { c, sql }
}

type Row = {
	n: number
	objects: number
	walkQueries: number
	walkMs: number
	bitmapQueries: number
	bitmapMs: number
	factor: number
}

async function cloneCounting(
	schema: string,
	label: string,
): Promise<{ queries: number; ms: number; oids: string[]; tip: string }> {
	const { sql, c } = countingClient(schema)
	try {
		const server = await serveOnPort(createGitApp(createGitDeps(sql)), 0)
		try {
			const dest = join(mkTmp(`bmq-${label}`), "c")
			try {
				const t0 = Date.now()
				await spawnGit([
					"clone",
					"-c",
					"protocol.version=2",
					"--quiet",
					`http://127.0.0.1:${server.port}/${REPO}`,
					dest,
				])
				const ms = Date.now() - t0
				await spawnGit(["fsck", "--full", "--no-dangling"], { cwd: dest })
				return {
					ms,
					oids: await allObjectOids(dest),
					queries: c.n,
					tip: await revParse(dest, "refs/heads/main"),
				}
			} finally {
				rmSync(dest, { force: true, recursive: true })
			}
		} finally {
			await server.close()
		}
	} finally {
		await sql.end()
	}
}

async function measure(n: number): Promise<Row> {
	const src = await createAppendOnlyRepo({ docs: 8, runs: n })
	try {
		const db = await createIsolatedSchema(PG_URL)
		try {
			const seeded = await seedRepo(db.sql, REPO, src)
			const expectedOids = await allObjectOids(src)
			const expectedTip = await revParse(src, "refs/heads/main")
			if (seeded.objects !== expectedOids.length) {
				throw new Error(
					`seeded ${seeded.objects} objects, canonical git has ${expectedOids.length}`,
				)
			}

			const walk = await cloneCounting(db.schema, `walk-${n}`)

			// One drain produces the epoch; huge grace so nothing is reclaimed and
			// the two clones serve the same repo state.
			const gc = await createGc(db.sql).gc(REPO, { graceSeconds: 365 * 24 * 3600 })
			if (gc.epoch !== "rebuilt") {
				throw new Error(`expected the drain to rebuild an epoch, got ${gc.epoch}`)
			}

			const bitmap = await cloneCounting(db.schema, `bitmap-${n}`)

			// Canonical git is the correctness anchor; comparing the two pggit routes
			// only would let a shared under-walk self-confirm.
			for (const [label, clone] of [
				["walk", walk],
				["bitmap", bitmap],
			] as const) {
				if (
					clone.tip !== expectedTip ||
					clone.oids.length !== expectedOids.length ||
					clone.oids.some((oid, i) => oid !== expectedOids[i])
				) {
					throw new Error(`${label}-served clone diverged from canonical git`)
				}
			}
			if (walk.queries <= 0 || bitmap.queries <= 0) {
				throw new Error(
					`query counter did not observe both serves: walk=${walk.queries}, bitmap=${bitmap.queries}`,
				)
			}

			return {
				bitmapMs: bitmap.ms,
				bitmapQueries: bitmap.queries,
				factor: walk.queries / bitmap.queries,
				n,
				objects: seeded.objects,
				walkMs: walk.ms,
				walkQueries: walk.queries,
			}
		} finally {
			await db.drop()
		}
	} finally {
		rmSync(src, { force: true, recursive: true })
	}
}

const rows: Row[] = []
for (const n of SIZES) rows.push(await measure(n))

console.log(
	table(
		["commits", "objects", "walk q", "walk ms", "bitmap q", "bitmap ms", "q factor"],
		rows.map((r) => [
			String(r.n),
			String(r.objects),
			String(r.walkQueries),
			String(r.walkMs),
			String(r.bitmapQueries),
			String(r.bitmapMs),
			r.factor.toFixed(1),
		]),
	),
)

const last = rows[rows.length - 1] as Row
if (last.factor < MIN_QUERY_FACTOR) {
	console.error(
		`FAIL: epoch-served clone cut queries only ${last.factor.toFixed(1)}× at ${last.n} commits (limit ${MIN_QUERY_FACTOR}×)`,
	)
	process.exit(1)
}
console.log(
	`OK: epoch serve cuts clone queries ${last.factor.toFixed(1)}× at ${last.n} commits`,
)

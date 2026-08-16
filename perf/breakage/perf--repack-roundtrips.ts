/**
 * PROBE: how many Postgres round-trips does ONE repack pass take, and what does
 * that cost when the database is not on loopback?
 *
 * Design concern C3 / work item W2 carry an UNVERIFIED estimate ("14k reads ×
 * ~30 ms ≈ 7 min"). This measures the multiplier instead of guessing it:
 * `createRepack` is handed a porsager client built with the driver's public
 * `debug` hook, which fires once per query execution, so the count is exact and
 * nothing inside pggit is touched. The same is done for a full clone off the wire
 * and for one gc pass, so the drain's three phases can be compared.
 *
 * The modeled columns are count × RTT — the honest lower bound for a serialized
 * request/response workload (every read here is awaited before the next is
 * issued).
 *
 *   npx tsx perf/breakage/perf--repack-roundtrips.ts [--sizes=250,500,1000,2000]
 */
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { cleanupTmp, flag, mkTmp, PG_URL, secs, seedRepo, table } from "./_perf-util"

const SIZES = flag("sizes", "250,500,1000,2000").split(",").map(Number)
/** Round-trip times to model: loopback, same-region managed PG, cross-region. */
const RTTS = [1, 15, 30]
/** Modeled minutes for ONE repo at 30 ms RTT above which this is called broken.
 * Two minutes is one repo of a fleet the drain walks serially — the provisioning
 * window W2 asks for is sized by this number. */
const MODELED_MINUTES_LIMIT = 2

type Counter = { n: number; byShape: Map<string, number> }

function countingClient(schema: string): { sql: postgres.Sql; c: Counter } {
	const c: Counter = { byShape: new Map(), n: 0 }
	const sql = postgres(PG_URL, {
		connection: { search_path: schema },
		debug: (_id, query) => {
			c.n++
			const shape = query.trim().replace(/\s+/g, " ").slice(0, 46)
			c.byShape.set(shape, (c.byShape.get(shape) ?? 0) + 1)
		},
		max: 4,
		onnotice: () => {},
	})
	return { c, sql }
}

type Row = {
	n: number
	objects: number
	repack: number
	repackMs: number
	clone: number
	gc: number
	top: string
}

async function measure(n: number): Promise<Row> {
	const src = await createAppendOnlyRepo({ docs: 8, runs: n })
	try {
		const db = await createIsolatedSchema(PG_URL)
		try {
			const seeded = await seedRepo(db.sql, "probe/rt", src)

			const repackC = countingClient(db.schema)
			const t0 = Date.now()
			await createRepack(repackC.sql).repack("probe/rt")
			const repackMs = Date.now() - t0
			await repackC.sql.end()

			const cloneC = countingClient(db.schema)
			const server = await serveOnPort(createGitApp(createGitDeps(cloneC.sql)), 0)
			const dest = join(mkTmp(`rt-clone-${n}`), "c")
			mkdirSync(dest, { recursive: true })
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--bare",
				`http://127.0.0.1:${server.port}/probe/rt`,
				dest,
			])
			await server.close()
			await cloneC.sql.end()

			const gcC = countingClient(db.schema)
			await createGc(gcC.sql).gc("probe/rt", { graceSeconds: 0, maintain: false })
			await gcC.sql.end()

			const top = [...repackC.c.byShape.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([s, k]) => `${k}× ${s}`)
				.join(" · ")
			return {
				clone: cloneC.c.n,
				gc: gcC.c.n,
				n,
				objects: seeded.objects,
				repack: repackC.c.n,
				repackMs,
				top,
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

	console.log("# Postgres round-trips per drain phase (append-only repo)\n")
	console.log(
		table(
			[
				"commits",
				"objects",
				"repack queries",
				"queries / object",
				"repack s @loopback",
				...RTTS.map((r) => `modeled @${r}ms`),
				"clone queries",
				"gc queries",
			],
			rows.map((r) => [
				r.n + 1,
				r.objects,
				r.repack,
				(r.repack / r.objects).toFixed(2),
				secs(r.repackMs),
				...RTTS.map((rtt) => `${((r.repack * rtt) / 60000).toFixed(1)} min`),
				r.clone,
				r.gc,
			]),
		),
	)
	console.log(
		`\nbusiest repack statements at the largest size:\n  ${(rows[rows.length - 1] as Row).top}`,
	)

	const last = rows[rows.length - 1] as Row
	const modeled = (last.repack * 30) / 60000
	console.log(
		`\nFAIL CONDITION: one repo's first repack modeled at 30 ms RTT exceeds ${MODELED_MINUTES_LIMIT} min.`,
	)
	console.log(
		`observed: ${last.repack} queries for ${last.objects} objects ⇒ ${modeled.toFixed(1)} min at 30 ms, ${((last.repack * 15) / 60000).toFixed(1)} min at 15 ms`,
	)
	if (modeled > MODELED_MINUTES_LIMIT) process.exitCode = 1
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

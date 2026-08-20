/**
 * PROBE: how many Postgres round-trips does ONE repack pass take, and what does
 * that cost when the database is not on loopback?
 *
 * Design concern C3 carries an UNVERIFIED estimate ("14k reads × ~30 ms ≈ 7 min"). This probe invokes `createRepack` directly — the production drain currently runs GC only — and measures the multiplier instead of guessing it. A porsager client built with the driver's public `debug` hook counts each query execution exactly without touching pggit internals. The same is done for a full clone off the wire and for one GC pass, so explicit maintenance work can be compared with the serve path.
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
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	loadGitObjects,
	repackEligibleObjects,
	requiredAt,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { increasingIntegerListArg, parseArgs, pgUrlArg } from "../args"
import { cleanupTmp, mkTmp, secs, seedRepo, table } from "./_perf-util"

const { pg: PG_URL, sizes: SIZES } = parseArgs(
	z
		.object({
			pg: pgUrlArg,
			sizes: increasingIntegerListArg([250, 500, 1000, 2000]),
		})
		.strict(),
)
/** Round-trip times to model: loopback, same-region managed PG, cross-region. */
const RTTS = [1, 15, 30]
/** Modeled minutes for ONE repo at 30 ms RTT above which this is called broken.
 * Two minutes is the per-repository budget for one explicitly invoked repack. */
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
			const expectedOids = await allObjectOids(src)
			const expectedObjects = await loadGitObjects(src, expectedOids)
			const expectedTip = await revParse(src, "refs/heads/main")
			const seeded = await seedRepo(db.sql, "probe/rt", src, expectedObjects)
			if (seeded.objects !== expectedOids.length) {
				throw new Error(
					`seeded ${seeded.objects} objects, expected ${expectedOids.length}`,
				)
			}

			const repackC = countingClient(db.schema)
			const { repacked, repackMs } = await (async () => {
				const t0 = Date.now()
				try {
					return {
						repacked: await createRepack(repackC.sql).repack("probe/rt"),
						repackMs: Date.now() - t0,
					}
				} finally {
					await repackC.sql.end()
				}
			})()
			if (
				repacked.wholes + repacked.deltas !== seeded.eligibleObjects ||
				repacked.deltas <= 0 ||
				repackC.c.n <= 0 ||
				repackMs <= 0
			) {
				throw new Error(
					`repack prerequisite invalid: ${repacked.wholes} wholes + ${repacked.deltas} deltas/${seeded.eligibleObjects} eligible objects, q=${repackC.c.n}, ms=${repackMs}`,
				)
			}
			await assertCanonicalStoreFixture(db.sql, "probe/rt", {
				encodings: {
					kind: "exact",
					objects: repackEligibleObjects(expectedObjects),
				},
				objects: expectedObjects,
				refs: await canonicalStoreRefsOf(src),
			})

			const cloneC = countingClient(db.schema)
			let server: Awaited<ReturnType<typeof serveOnPort>> | undefined
			try {
				server = await serveOnPort(createGitApp(createGitDeps(cloneC.sql)), 0)
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
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				const gotOids = await allObjectOids(dest)
				const gotTip = await revParse(dest, "refs/heads/main")
				if (
					gotTip !== expectedTip ||
					gotOids.length !== expectedOids.length ||
					gotOids.some((oid, i) => oid !== expectedOids[i])
				) {
					throw new Error("clone diverged from canonical git ref tip/object set")
				}
			} finally {
				try {
					await server?.close()
				} finally {
					await cloneC.sql.end()
				}
			}
			if (cloneC.c.n <= 0) throw new Error("clone query counter observed no queries")

			const gcC = countingClient(db.schema)
			const swept = await (async () => {
				try {
					return await createGc(gcC.sql).gc("probe/rt", {
						graceSeconds: 0,
						maintain: false,
					})
				} finally {
					await gcC.sql.end()
				}
			})()
			if (swept.deletedObjects !== 0 || swept.epoch !== "rebuilt" || gcC.c.n <= 0) {
				throw new Error(
					`completed GC receipt invalid: deleted=${swept.deletedObjects}, epoch=${swept.epoch}, q=${gcC.c.n}`,
				)
			}
			await assertCanonicalStoreFixture(db.sql, "probe/rt", {
				encodings: {
					kind: "exact",
					objects: repackEligibleObjects(expectedObjects),
				},
				objects: expectedObjects,
				refs: await canonicalStoreRefsOf(src),
			})

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

	console.log("# Postgres round-trips per explicit operation (append-only repo)\n")
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
		`\nbusiest repack statements at the largest size:\n  ${requiredAt(rows, rows.length - 1, "largest repack-roundtrip measurement").top}`,
	)

	const last = requiredAt(rows, rows.length - 1, "largest repack-roundtrip measurement")
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

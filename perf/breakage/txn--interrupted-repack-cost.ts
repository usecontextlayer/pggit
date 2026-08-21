/**
 * TRANSACTIONAL-INTEGRITY PROBE 2b — an interrupted repack must not create a permanent transfer-size penalty.
 *
 * Repack emits changed subtrees before their roots, so every committed crash prefix is subtree-closed. A resumed pass should therefore converge without downgrading unseen subtrees to whole encodings. This probe injects exact failures at named COPY flushes, proves each injection fired, completes a clean pass, requires full nonzero encoding coverage and exact source/client object equality, and measures pggit's request-scoped raw pack-byte counter rather than Git's client-rewritten packfiles.
 *
 * THRESHOLD — non-zero exit when any crash schedule's raw served pack is larger than the uninterrupted baseline. A crash may cost wall time; it must not cost permanent transfer bytes.
 *
 *   npx tsx perf/breakage/txn--interrupted-repack-cost.ts
 *   npx tsx perf/breakage/txn--interrupted-repack-cost.ts --pg=postgres://…
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "postgres"
import { z } from "zod"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { createGitApp } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	assertGitReachableObjects,
	branchAndTagRefsOf,
	canonicalStoreRefsOf,
	gitReachableOids,
	loadGitObjects,
	repackEligibleObjects,
	revParse,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"
import { parseArgs, pgUrlArg } from "../args"
import { requiredCollector, requiredPositiveCounter } from "../collector-evidence"
import { table } from "../table"

const REPO = "r"
const { pg: PG_URL } = parseArgs(z.object({ pg: pgUrlArg }).strict())
const RUNS = 400

/** A client whose `begin()` throws on the Nth call — the pass dies with N-1
 * flushes committed, exactly what a killed process or a dropped connection
 * leaves behind. */
function dieAtFlush(pg: Sql, n: number): { sql: Sql; fired: () => boolean } {
	let seen = 0
	let fired = false
	const sql = new Proxy(pg, {
		get(target, prop, receiver) {
			if (prop !== "begin") return Reflect.get(target, prop, receiver)
			const real = Reflect.get(target, prop, target) as Sql["begin"]
			return (...args: unknown[]) => {
				if (++seen === n) {
					fired = true
					throw new Error(`crash@${n}`)
				}
				return (real as (...a: unknown[]) => unknown).apply(target, args)
			}
		},
	}) as Sql
	return { fired: () => fired, sql }
}

type TierStats = {
	rows: number
	bytes: number
	deltas: number
	wholetrees: number
	eligibleObjects: number
	ineligibleRows: number
}

async function stats(db: IsolatedDb): Promise<TierStats> {
	const [row] = await db.sql<TierStats[]>`
		select count(*)::int as rows,
			coalesce(sum(octet_length(e.data)), 0)::int as bytes,
			count(*) filter (where e.base_oid is not null)::int as deltas,
			count(*) filter (where e.base_oid is null and o.type = 2)::int as wholetrees,
			(select count(*)::int from git_object where size < ${MAX_INLINE_BYTEA_BYTES}) as "eligibleObjects",
			count(*) filter (where o.size >= ${MAX_INLINE_BYTEA_BYTES})::int as "ineligibleRows"
		from git_pack_encoding e
			join git_object o on o.repo_id = e.repo_id and o.oid = e.oid`
	if (!row) throw new Error("tier-stats query returned no row")
	return row
}

function requireRawPackBytes(label: string, expectedObjects: number): number {
	const collector = requiredCollector(collectedRuns(), "fetch", label)
	const objectsServed = requiredPositiveCounter(collector, "objectsServed", label)
	if (objectsServed !== expectedObjects) {
		throw new Error(
			`${label}: collector served ${objectsServed}/${expectedObjects} canonical objects`,
		)
	}
	requiredPositiveCounter(collector, "wireBytes", label)
	return requiredPositiveCounter(collector, "packBytes", label)
}

type Run = { label: string; packBytes: number; tier: TierStats }

/** Build the tier under a crash schedule, then report tier bytes + clone bytes. */
async function run(
	label: string,
	crashes: number[],
	src: string,
	scratchDir: string,
): Promise<Run> {
	const db = await createIsolatedSchema(PG_URL)
	let server: GitServer | undefined
	try {
		mkdirSync(scratchDir, { recursive: true })
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const canonicalObjects = await loadGitObjects(src, await allObjectOids(src))
		const canonicalRefs = await canonicalStoreRefsOf(src)
		await seedRepoIntoStore(REPO, src, { objects, refs })
		for (const at of crashes) {
			const fault = dieAtFlush(db.sql, at)
			let thrown: unknown
			try {
				await createRepack(fault.sql).repack(REPO)
			} catch (error) {
				thrown = error
			}
			if (
				!fault.fired() ||
				!(thrown instanceof Error) ||
				thrown.message !== `crash@${at}`
			) {
				throw new Error(
					`${label}: fault crash@${at} did not fire exactly (fired=${fault.fired()}, error=${String(thrown)})`,
					{ cause: thrown },
				)
			}
		}
		const beforeClean = await stats(db)
		const clean = await createRepack(db.sql).repack(REPO)
		if (clean.wholes + clean.deltas !== beforeClean.eligibleObjects - beforeClean.rows) {
			throw new Error(
				`${label}: clean pass covered ${clean.wholes + clean.deltas}/${beforeClean.eligibleObjects - beforeClean.rows} pending objects`,
			)
		}
		const tier = await stats(db)
		if (
			tier.eligibleObjects === 0 ||
			tier.rows !== tier.eligibleObjects ||
			tier.ineligibleRows !== 0 ||
			tier.bytes === 0 ||
			tier.deltas === 0
		) {
			throw new Error(
				`${label}: incomplete or vacuous tier (${tier.rows}/${tier.eligibleObjects} rows, ${tier.ineligibleRows} ineligible, ${tier.bytes} bytes, ${tier.deltas} deltas)`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, REPO, {
			encodings: { kind: "exact", objects: repackEligibleObjects(canonicalObjects) },
			objects: canonicalObjects,
			refs: canonicalRefs,
		})

		server = await serveOnPort(createGitApp({ objects, refs }, { instrument: true }), 0)
		const dest = join(scratchDir, "c")
		resetCollected()
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			`http://127.0.0.1:${server.port}/${REPO}`,
			dest,
		])
		// The correctness sub-check the probe carried: a resumed tier must still serve
		// a repository canonical git accepts. `spawnGit` throws on a non-zero exit.
		const [expected, expectedRefs, actualRefs] = await Promise.all([
			gitReachableOids(src),
			branchAndTagRefsOf(src),
			branchAndTagRefsOf(dest),
		])
		await assertGitReachableObjects(dest, expected, `${label} clone`)
		if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
			throw new Error(`${label}: clone refs differ from source`)
		}
		const [expectedTip, actualTip] = await Promise.all([
			revParse(src, "HEAD"),
			revParse(dest, "HEAD"),
		])
		if (expectedTip !== actualTip) {
			throw new Error(`${label}: clone HEAD ${actualTip} != source ${expectedTip}`)
		}
		return {
			label,
			packBytes: requireRawPackBytes(label, canonicalObjects.length),
			tier,
		}
	} finally {
		await server?.close()
		await db.drop()
	}
}

async function main(): Promise<void> {
	const scratch = createScratchArena()
	const root = scratch.make("repack-cost")
	const src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
	scratch.own(src)
	try {
		console.log(`# txn--interrupted-repack-cost — ${RUNS} runs\n`)
		const base = await run("uninterrupted", [], src, join(root, "a"))
		const one = await run("one crash mid-phase-1", [2], src, join(root, "b"))
		const two = await run("crashes at flush 2 then 3", [2, 3], src, join(root, "c"))
		const many = await run(
			"crash on every pass (5x)",
			[2, 2, 2, 2, 2],
			src,
			join(root, "d"),
		)
		const runs = [base, one, two, many]

		console.log(
			table(
				["schedule", "tier bytes", "deltas", "whole trees", "RAW PACK bytes"],
				runs.map((r) => [
					r.label,
					r.tier.bytes,
					r.tier.deltas,
					r.tier.wholetrees,
					r.packBytes,
				]),
			),
		)

		const pct = (n: number): string =>
			`${(((n - base.packBytes) / base.packBytes) * 100).toFixed(1)}%`
		console.log(
			`\nraw-pack regression vs uninterrupted: one=${pct(one.packBytes)} ` +
				`two=${pct(two.packBytes)} many=${pct(many.packBytes)}`,
		)

		const regressed = runs.filter((r) => r.packBytes > base.packBytes)
		for (const r of regressed) {
			console.error(
				`THRESHOLD VIOLATED: "${r.label}" serves ${r.packBytes}B vs the uninterrupted ${base.packBytes}B (${pct(r.packBytes)})`,
			)
		}
		console.log(`\n${regressed.length === 0 ? "OK" : `${regressed.length} REGRESSIONS`}`)
		if (regressed.length > 0) process.exitCode = 1
	} finally {
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

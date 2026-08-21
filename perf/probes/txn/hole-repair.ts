/**
 * PROBE 6 — D15 repair must re-deltify holes below covered roots without changing the tier.
 *
 * A live delta row disappears when GC reclaims its base and the 0008 FK cascade removes dependent encodings. The current repair mode detects pending objects older than the last completed pass, descends through covered trees for recursion, and must reconstruct those rows exactly; the ordinary covered-tree prune remains in force for new work.
 *
 * This deletes a nonempty, delta-bearing slice of the growing `RUNS_DIR` lineage, proves every named row existed, runs repair, and requires exact lineage shape, tier bytes, and full eligible-object coverage. The control deletes the same lineage plus its covered ancestors and must converge to the same tier. Missing fixtures, zero deltas, partial deletes, and incomplete repair are prerequisite failures rather than favorable scores.
 *
 * THRESHOLD — non-zero exit when the repaired lineage differs from the original encoding shape or the repaired tier differs in bytes from the original deterministic tier.
 *
 *   npx tsx perf/probes/txn/hole-repair.ts
 *   npx tsx perf/probes/txn/hole-repair.ts --pg=postgres://…
 */
import { rmSync } from "node:fs"
import { parseArgs, pgUrlArg } from "@perf/args"
import { table } from "@perf/probes/_table"
import { z } from "zod"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import type { Oid } from "@/oid"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo, RUNS_DIR } from "@/testing/append-only-repo"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	loadGitObjects,
	parseRevListObjectOids,
	repackEligibleObjects,
	revParse,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "r"
const { pg: PG_URL } = parseArgs(z.object({ pg: pgUrlArg }).strict())
const RUNS = 150
/** The slice of history whose `RUNS_DIR` lineage gets holed — 31 successive
 * versions of the growing tree, mid-history so anchors exist on both sides. */
const LINEAGE_FROM = 100
const LINEAGE_TO = 131

type TierSize = {
	bytes: number
	wholeTrees: number
	deltas: number
	encodingRows: number
	eligibleObjects: number
	ineligibleRows: number
}
type LineageShape = { deltas: number; wholes: number; rows: number }

async function tierSize(db: IsolatedDb): Promise<TierSize> {
	const [row] = await db.sql<TierSize[]>`
		select coalesce(sum(octet_length(e.data)), 0)::int as bytes,
			count(*) filter (where e.base_oid is null and o.type = 2)::int as "wholeTrees",
			count(*) filter (where e.base_oid is not null)::int as deltas,
			count(*)::int as "encodingRows",
			(select count(*)::int from git_object where size < ${MAX_INLINE_BYTEA_BYTES}) as "eligibleObjects",
			count(*) filter (where o.size >= ${MAX_INLINE_BYTEA_BYTES})::int as "ineligibleRows"
		from git_pack_encoding e
			join git_object o on o.repo_id = e.repo_id and o.oid = e.oid`
	if (!row) throw new Error("tier-size query returned no row")
	return row
}

/** How the given lineage's trees are currently encoded. */
async function lineageShape(db: IsolatedDb, oids: Buffer[]): Promise<LineageShape> {
	const [row] = await db.sql<LineageShape[]>`
		select count(*) filter (where base_oid is not null)::int as deltas,
			count(*) filter (where base_oid is null)::int as wholes,
			count(*)::int as rows
		from git_pack_encoding where oid in ${db.sql(oids)}`
	if (!row) throw new Error("lineage-shape query returned no row")
	return row
}

/** The tree OID at a fixture path that must exist. */
async function treeAt(dir: string, spec: string): Promise<Oid> {
	return revParse(dir, spec)
}

function assertTierCoverage(stage: string, tier: TierSize): void {
	if (
		tier.eligibleObjects === 0 ||
		tier.encodingRows !== tier.eligibleObjects ||
		tier.ineligibleRows !== 0
	) {
		throw new Error(
			`${stage}: encoding coverage ${tier.encodingRows}/${tier.eligibleObjects} eligible objects, ${tier.ineligibleRows} ineligible rows`,
		)
	}
	if (tier.bytes === 0) throw new Error(`${stage}: encoding tier contains zero bytes`)
}

async function main(): Promise<void> {
	const src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
	const db = await createIsolatedSchema(PG_URL)
	try {
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		const canonicalObjects = await loadGitObjects(src, await allObjectOids(src))
		const canonicalRefs = await canonicalStoreRefsOf(src)
		const eligibleObjects = repackEligibleObjects(canonicalObjects)
		const requireCanonicalTier = async (stage: string): Promise<void> => {
			await assertCanonicalStoreFixture(db.sql, REPO, {
				encodings: { kind: "exact", objects: eligibleObjects },
				objects: canonicalObjects,
				refs: canonicalRefs,
			})
			if (eligibleObjects.length === 0) {
				throw new Error(`${stage}: canonical fixture has no repack-eligible objects`)
			}
		}
		await seedRepoIntoStore(REPO, src, { objects, refs })
		const seedPass = await createRepack(db.sql).repack(REPO)
		const before = await tierSize(db)
		if (seedPass.wholes + seedPass.deltas === 0 || seedPass.deltas === 0) {
			throw new Error(
				`seed repack did not exercise the delta tier (${seedPass.wholes} wholes, ${seedPass.deltas} deltas)`,
			)
		}
		assertTierCoverage("before holes", before)
		await requireCanonicalTier("before holes")
		console.log(
			`# txn--hole-repair — ${RUNS} runs, seed pass ${seedPass.wholes} wholes + ${seedPass.deltas} deltas\n`,
		)

		// The runs-dir lineage: the growing tree the whole design exists for.
		const commits = parseRevListObjectOids(
			(await spawnGit(["rev-list", "--reverse", "HEAD"], { cwd: src })).stdout,
		)
		if (commits.length < LINEAGE_TO) {
			throw new Error(
				`fixture has ${commits.length} commits; need at least ${LINEAGE_TO}`,
			)
		}
		const lineage: Oid[] = []
		for (const c of commits.slice(LINEAGE_FROM, LINEAGE_TO)) {
			const t = await treeAt(src, `${c}:${RUNS_DIR}`)
			lineage.push(t)
		}
		const expectedLineage = LINEAGE_TO - LINEAGE_FROM
		if (lineage.length !== expectedLineage || new Set(lineage).size !== expectedLineage) {
			throw new Error(
				`fixture produced ${lineage.length} lineage rows / ${new Set(lineage).size} unique; expected ${expectedLineage}`,
			)
		}
		const bufs = lineage.map((h) => Buffer.from(h, "hex"))
		const holed = await lineageShape(db, bufs)
		if (holed.rows !== lineage.length || holed.deltas === 0) {
			throw new Error(
				`named hole fixture has ${holed.rows}/${lineage.length} encoding rows and ${holed.deltas} deltas`,
			)
		}
		console.log(
			`${lineage.length} versions of ${RUNS_DIR} selected; ${holed.deltas} of them are currently deltas\n`,
		)

		// What the base-oid cascade does to a hole: remove the rows, leave the objects.
		const gone = await db.sql`
			delete from git_pack_encoding where oid in ${db.sql(bufs)} returning 1`
		if (gone.length !== lineage.length) {
			throw new Error(`deleted ${gone.length}/${lineage.length} named lineage rows`)
		}
		console.log(
			`deleted ${gone.length} encoding rows (objects untouched, still reachable)`,
		)

		const repair = await createRepack(db.sql).repack(REPO)
		const afterRepair = await lineageShape(db, bufs)
		const after = await tierSize(db)
		assertTierCoverage("after repair", after)
		await requireCanonicalTier("after repair")
		if (afterRepair.rows !== holed.rows) {
			throw new Error(`repair restored ${afterRepair.rows}/${holed.rows} lineage rows`)
		}
		if (repair.wholes + repair.deltas !== gone.length) {
			throw new Error(
				`repair wrote ${repair.wholes + repair.deltas}/${gone.length} deleted rows`,
			)
		}

		// A second pass proves the repaired coverage is stable and idempotent.
		const repairTwice = await createRepack(db.sql).repack(REPO)
		const afterTwice = await tierSize(db)
		assertTierCoverage("after second repair", afterTwice)
		await requireCanonicalTier("after second repair")
		if (repairTwice.wholes !== 0 || repairTwice.deltas !== 0) {
			throw new Error(
				`second repair was not a no-op (${repairTwice.wholes} wholes, ${repairTwice.deltas} deltas)`,
			)
		}

		// Control: remove the same lineage plus its covered ancestors. Repair must
		// converge to the same deterministic tier from this wider hole as well.
		const roots: Buffer[] = []
		for (const c of commits.slice(LINEAGE_FROM, LINEAGE_TO)) {
			for (const spec of [`${c}^{tree}`, `${c}:.engine`, `${c}:.engine/runs`]) {
				roots.push(Buffer.from(await treeAt(src, spec), "hex"))
			}
		}
		const controlTargets = [
			...new Map([...bufs, ...roots].map((oid) => [oid.toString("hex"), oid])).values(),
		]
		const controlDeleted = await db.sql`
			delete from git_pack_encoding where oid in ${db.sql(controlTargets)} returning 1`
		if (controlDeleted.length !== controlTargets.length) {
			throw new Error(
				`control deleted ${controlDeleted.length}/${controlTargets.length} named rows`,
			)
		}
		const controlPass = await createRepack(db.sql).repack(REPO)
		const control = await lineageShape(db, bufs)
		const afterControl = await tierSize(db)
		assertTierCoverage("after control repair", afterControl)
		await requireCanonicalTier("after control repair")
		if (control.rows !== holed.rows) {
			throw new Error(`control restored ${control.rows}/${holed.rows} lineage rows`)
		}
		if (controlPass.wholes + controlPass.deltas !== controlDeleted.length) {
			throw new Error(
				`control repair wrote ${controlPass.wholes + controlPass.deltas}/${controlDeleted.length} deleted rows`,
			)
		}
		if (
			control.deltas !== holed.deltas ||
			control.wholes !== holed.wholes ||
			afterControl.bytes !== before.bytes
		) {
			throw new Error(
				`control did not reconstruct the original tier (lineage ${control.deltas} deltas/${control.wholes} wholes; bytes ${afterControl.bytes}/${before.bytes})`,
			)
		}

		console.log(`\n## the tier, stage by stage\n`)
		console.log(
			table(
				["stage", "repack pass", "encoding bytes", "whole trees", "deltas"],
				[
					[
						"before the holes",
						`${seedPass.wholes}w + ${seedPass.deltas}Δ`,
						before.bytes,
						before.wholeTrees,
						before.deltas,
					],
					[
						"after repair",
						`${repair.wholes}w + ${repair.deltas}Δ`,
						after.bytes,
						after.wholeTrees,
						after.deltas,
					],
					[
						"after 2nd repair",
						`${repairTwice.wholes}w + ${repairTwice.deltas}Δ`,
						afterTwice.bytes,
						afterTwice.wholeTrees,
						afterTwice.deltas,
					],
					[
						"CONTROL (roots holed too)",
						`${controlPass.wholes}w + ${controlPass.deltas}Δ`,
						afterControl.bytes,
						afterControl.wholeTrees,
						afterControl.deltas,
					],
				],
			),
		)

		console.log(`\n## the ${lineage.length} holed versions of ${RUNS_DIR}\n`)
		console.log(
			table(
				["stage", "deltas", "wholes"],
				[
					["before the holes", holed.deltas, holed.wholes],
					["after repair", afterRepair.deltas, afterRepair.wholes],
					["CONTROL (roots holed too)", control.deltas, control.wholes],
				],
			),
		)

		const pct = (n: number): string =>
			`${(((n - before.bytes) / before.bytes) * 100).toFixed(1)}%`
		console.log(
			`\ntier-byte regression vs before the holes: repair=${pct(after.bytes)} ` +
				`second-repair=${pct(afterTwice.bytes)} control=${pct(afterControl.bytes)}`,
		)

		const t1 = afterRepair.deltas !== holed.deltas || afterRepair.wholes !== holed.wholes
		const t2 = after.bytes !== before.bytes || afterTwice.bytes !== before.bytes
		if (t1) {
			console.error(
				`T1 VIOLATED: repaired lineage is ${afterRepair.deltas} deltas/${afterRepair.wholes} wholes; expected ${holed.deltas}/${holed.wholes}`,
			)
		}
		if (t2) {
			console.error(
				`T2 VIOLATED: tier bytes must remain ${before.bytes}B; repair=${after.bytes}B, second=${afterTwice.bytes}B`,
			)
		}
		console.log(`\n${t1 || t2 ? "REGRESSION" : "OK"}`)
		if (t1 || t2) process.exitCode = 1
	} finally {
		await db.drop()
		rmSync(src, { force: true, recursive: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

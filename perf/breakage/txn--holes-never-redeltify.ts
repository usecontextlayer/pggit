/**
 * PROBE 6 — a hole in the tier is never re-deltified, and the reason is an early
 * return that also blinds the walk to everything BELOW the hole.
 *
 * repack.ts `encodeTreePair`:
 *
 *     if (treeOid === parentTreeOid) return
 *     if (!pendingByOid.has(treeOid)) return     // <-- BEFORE the subtree recursion
 *     ...
 *     for (const entry of treeEntries(raw)) ... encodeTreePair(entry.oid, prior)
 *
 * A tree that already has a row terminates the walk at that node. So when GC
 * holes a SUBTREE's row (its anchor was reclaimed, and the 0008 base-oid cascade
 * takes every delta anchored on it) while the ROOT tree's row survives — the two
 * lineages have different anchors — the next repack cannot reach that subtree
 * through the walk at all. Without D15's repair mode it falls to the phase-2
 * sweep and ships WHOLE, forever (design D4: rows are never rewritten); with it,
 * the walk descends through covered trees and re-deltas the hole.
 *
 * This deletes rows for the big growing tree's lineage the way the sweep would,
 * then measures what the next pass does with them.
 *
 * It is a PERF harness, not a vitest test, because its verdict is a BYTE
 * MEASUREMENT with a control: the same holes, but with the ROOT trees holed too so
 * the walk is not short-circuited above them. If the control DOES restore the
 * deltas, the early return (not the phase-2 fallback) is the cause.
 *
 * THRESHOLD — non-zero exit when either holds:
 *   T1  the repair pass restores fewer deltas than the holes it was handed
 *       (measured: 0 of them come back — the downgrade is permanent).
 *   T2  the tier is bigger after the repair pass than before the holes were made
 *       (measured: +52.9%).
 *
 *   npx tsx perf/breakage/txn--holes-never-redeltify.ts
 *   npx tsx perf/breakage/txn--holes-never-redeltify.ts --pg=postgres://…
 */
import { rmSync } from "node:fs"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo, RUNS_DIR } from "@/testing/append-only-repo"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { PG_URL, table } from "./_txn-util"

const REPO = "r"
const RUNS = 150
/** The slice of history whose `RUNS_DIR` lineage gets holed — 31 successive
 * versions of the growing tree, mid-history so anchors exist on both sides. */
const LINEAGE_FROM = 100
const LINEAGE_TO = 131

type TierSize = { bytes: number; wholeTrees: number; deltas: number }
type LineageShape = { deltas: number; wholes: number }

async function tierSize(db: IsolatedDb): Promise<TierSize> {
	const [row] = await db.sql<TierSize[]>`
		select sum(octet_length(e.data))::int as bytes,
			count(*) filter (where e.base_oid is null and o.type = 2)::int as "wholeTrees",
			count(*) filter (where e.base_oid is not null)::int as deltas
		from git_pack_encoding e
			join git_object o on o.repo_id = e.repo_id and o.oid = e.oid`
	if (!row) throw new Error("tier-size query returned no row")
	return row
}

/** How the given lineage's trees are currently encoded. */
async function lineageShape(db: IsolatedDb, oids: Buffer[]): Promise<LineageShape> {
	const [row] = await db.sql<LineageShape[]>`
		select count(*) filter (where base_oid is not null)::int as deltas,
			count(*) filter (where base_oid is null)::int as wholes
		from git_pack_encoding where oid in ${db.sql(oids)}`
	if (!row) throw new Error("lineage-shape query returned no row")
	return row
}

/** The tree OID at `spec` in `dir`, or "" when that path does not exist there. */
async function treeAt(dir: string, spec: string): Promise<string> {
	return await spawnGit(["rev-parse", spec], { cwd: dir })
		.then((r) => r.stdout.trim())
		.catch(() => "")
}

async function main(): Promise<void> {
	const src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
	const db = await createIsolatedSchema(PG_URL)
	try {
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		await seedRepoIntoStore(REPO, src, { objects, refs })
		const seedPass = await createRepack(db.sql).repack(REPO)
		const before = await tierSize(db)
		console.log(
			`# txn--holes-never-redeltify — ${RUNS} runs, seed pass ${seedPass.wholes} wholes + ${seedPass.deltas} deltas\n`,
		)

		// The runs-dir lineage: the growing tree the whole design exists for.
		const commits = (
			await spawnGit(["rev-list", "--reverse", "HEAD"], { cwd: src })
		).stdout
			.trim()
			.split("\n")
		const lineage: string[] = []
		for (const c of commits.slice(LINEAGE_FROM, LINEAGE_TO)) {
			const t = await treeAt(src, `${c}:${RUNS_DIR}`)
			if (t) lineage.push(t)
		}
		const bufs = lineage.map((h) => Buffer.from(h, "hex"))
		const holed = await lineageShape(db, bufs)
		console.log(
			`${lineage.length} versions of ${RUNS_DIR} selected; ${holed.deltas} of them are currently deltas\n`,
		)

		// What the base-oid cascade does to a hole: remove the rows, leave the objects.
		const gone = await db.sql`
			delete from git_pack_encoding where oid in ${db.sql(bufs)} returning 1`
		console.log(
			`deleted ${gone.length} encoding rows (objects untouched, still reachable)`,
		)

		const repair = await createRepack(db.sql).repack(REPO)
		const afterRepair = await lineageShape(db, bufs)
		const after = await tierSize(db)

		// And a second pass changes nothing — the downgrade is permanent.
		const repairTwice = await createRepack(db.sql).repack(REPO)
		const afterTwice = await tierSize(db)

		// CONTROL — same holes, but the ROOT trees of those commits are holed too, so
		// the walk is not short-circuited above them. If these DO come back as deltas,
		// the early return (not the phase-2 fallback) is the cause.
		const roots: Buffer[] = []
		for (const c of commits.slice(LINEAGE_FROM, LINEAGE_TO)) {
			for (const spec of [`${c}^{tree}`, `${c}:.engine`, `${c}:.engine/runs`]) {
				const t = await treeAt(src, spec)
				if (t) roots.push(Buffer.from(t, "hex"))
			}
		}
		await db.sql`delete from git_pack_encoding where oid in ${db.sql([...bufs, ...roots])}`
		const controlPass = await createRepack(db.sql).repack(REPO)
		const control = await lineageShape(db, bufs)
		const afterControl = await tierSize(db)

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

		const t1 = afterRepair.deltas < holed.deltas
		const t2 = after.bytes > before.bytes
		if (t1) {
			console.error(
				`T1 VIOLATED: the repair pass restored ${afterRepair.deltas} of ${holed.deltas} holed deltas`,
			)
		}
		if (t2) {
			console.error(
				`T2 VIOLATED: the tier grew from ${before.bytes}B to ${after.bytes}B (${pct(after.bytes)})`,
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

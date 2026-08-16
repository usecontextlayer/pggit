/**
 * TRANSACTIONAL-INTEGRITY PROBE 2b — what an interrupted repack COSTS.
 *
 * Probe 2 (`src/e2e/breakage/txn--interrupted-repack.test.ts`) showed a resumed
 * pass is correct (clone is fsck-clean) but produces a DIFFERENT tier from an
 * uninterrupted one. Rows are never rewritten (design D4), so whatever the resume
 * decided is permanent. This measures the difference where the customer pays it:
 * the bytes a real `git clone` pulls down.
 *
 * The suspected mechanism, from repack.ts `encodeTreePair`:
 *
 *     if (!pendingByOid.has(treeOid)) return    // <- returns BEFORE the recursion
 *
 * A tree that already has a row ends the walk at that node, so its CHANGED
 * SUBTREES are never paired with their predecessors. When a crash commits a root
 * tree but not the subtree chain below it, the resumed pass cannot re-enter that
 * lineage — those subtrees fall through to phase 2 and ship WHOLE.
 *
 * It is a PERF harness, not a vitest test, because its verdict is a BYTE
 * MEASUREMENT: clone bytes under each crash schedule against the uninterrupted
 * baseline. Every run still carries the correctness sub-check the probe had — each
 * clone must be fsck-clean, or `spawnGit` throws and the harness exits non-zero.
 *
 * THRESHOLD — non-zero exit when any crash schedule's clone is LARGER than the
 * uninterrupted baseline. A crash is allowed to cost wall time; it is not allowed
 * to cost the customer permanent transfer bytes.
 *
 *   npx tsx perf/breakage/txn--interrupted-repack-cost.ts
 *   npx tsx perf/breakage/txn--interrupted-repack-cost.ts --pg=postgres://…
 */
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Sql } from "postgres"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { PACK_DIR, packFiles, seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { PG_URL, table } from "./_txn-util"

const REPO = "r"
const RUNS = 400

/** A client whose `begin()` throws on the Nth call — the pass dies with N-1
 * flushes committed, exactly what a killed process or a dropped connection
 * leaves behind. */
function dieAtFlush(pg: Sql, n: number): Sql {
	let seen = 0
	return new Proxy(pg, {
		get(target, prop, receiver) {
			if (prop !== "begin") return Reflect.get(target, prop, receiver)
			const real = Reflect.get(target, prop, target) as Sql["begin"]
			return (...args: unknown[]) => {
				if (++seen === n) throw new Error(`crash@${n}`)
				return (real as (...a: unknown[]) => unknown).apply(target, args)
			}
		},
	}) as Sql
}

type TierStats = { rows: number; bytes: number; deltas: number; wholetrees: number }

async function stats(db: IsolatedDb): Promise<TierStats> {
	const [row] = await db.sql<TierStats[]>`
		select count(*)::int as rows,
			sum(octet_length(e.data))::int as bytes,
			count(*) filter (where e.base_oid is not null)::int as deltas,
			count(*) filter (where e.base_oid is null and o.type = 2)::int as wholetrees
		from git_pack_encoding e
			join git_object o on o.repo_id = e.repo_id and o.oid = e.oid`
	if (!row) throw new Error("tier-stats query returned no row")
	return row
}

/** Total bytes of a checkout's pack files — the transfer, measured client-side. */
function clonePackBytes(dir: string): number {
	return packFiles(dir)
		.map((f) => statSync(join(dir, PACK_DIR, f)).size)
		.reduce((a, b) => a + b, 0)
}

type Run = { label: string; tier: TierStats; wire: number }

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
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		await seedRepoIntoStore(REPO, src, { objects, refs })
		for (const at of crashes) {
			try {
				await createRepack(dieAtFlush(db.sql, at)).repack(REPO)
			} catch {
				/* the crash under test */
			}
		}
		await createRepack(db.sql).repack(REPO) // the eventual clean pass
		const tier = await stats(db)

		server = await serveOnPort(createGitApp({ objects, refs }), 0)
		const dest = join(scratchDir, "c")
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
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
		return { label, tier, wire: clonePackBytes(dest) }
	} finally {
		await server?.close()
		await db.drop()
	}
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pggit-breakage-repack-cost-"))
	const src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
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
				["schedule", "tier bytes", "deltas", "whole trees", "CLONE bytes"],
				runs.map((r) => [
					r.label,
					r.tier.bytes,
					r.tier.deltas,
					r.tier.wholetrees,
					r.wire,
				]),
			),
		)

		const pct = (n: number): string =>
			`${(((n - base.wire) / base.wire) * 100).toFixed(1)}%`
		console.log(
			`\nclone-byte regression vs uninterrupted: one=${pct(one.wire)} ` +
				`two=${pct(two.wire)} many=${pct(many.wire)}`,
		)

		const regressed = runs.filter((r) => r.wire > base.wire)
		for (const r of regressed) {
			console.error(
				`THRESHOLD VIOLATED: "${r.label}" clones ${r.wire}B vs the uninterrupted ${base.wire}B (${pct(r.wire)})`,
			)
		}
		console.log(`\n${regressed.length === 0 ? "OK" : `${regressed.length} REGRESSIONS`}`)
		if (regressed.length > 0) process.exitCode = 1
	} finally {
		rmSync(src, { force: true, recursive: true })
		rmSync(root, { force: true, recursive: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

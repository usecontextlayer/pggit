/**
 * pgres — WHAT DOES A GC PASS COST NOW, AND WHAT DOES IT LEAVE BEHIND?
 *
 * Two questions the delta-pack change puts on the GC pass:
 *
 * 1. Concern C2 — `sweepEncodings` adds a query round to EVERY pass, including
 *    passes that reclaim nothing. The drain runs one pass per eligible repo on a
 *    hot cadence, so a fixed per-pass cost is paid per repo per interval. Priced
 *    here by running many no-op passes with the tier present vs absent.
 *
 * 2. The `gc_live_<id>` UNLOGGED staging table — `create if not exists` →
 *    `truncate` → `drop` on every pass, on the pooled connection, outside any
 *    transaction. Each create/drop cycle writes and deletes rows in the DATABASE's
 *    system catalogs (`pg_class`, `pg_attribute`, `pg_type`, `pg_depend`,
 *    `pg_index`, …). Those catalogs are shared by every repo and every schema, are
 *    never touched by `maintain()`, and a fleet drain runs this cycle once per repo
 *    per interval — forever. Measured here as catalog rows churned per GC pass.
 *
 * Also asserted: after the loop, ZERO `gc_live_%` relations remain in the harness's
 * own schema (the `finally` drop actually fires on the happy path).
 *
 * NOISE: `pg_stat_sys_tables` counters are DATABASE-wide and this Postgres is
 * shared, so an idle control window of the same duration is measured and printed
 * beside the loop. The loop's own rate must stand well clear of it to mean
 * anything.
 *
 * 3. Does that fixed cost SCALE with the tier? `sweepEncodings` selects victims
 *    with `where e.repo_id = $1 and (…)` under a `limit` — the limit applies AFTER
 *    the filter, so a pass with nothing to sweep must still walk every encoding row
 *    the repo owns before it can conclude the batch is empty. Arm 3 sweeps repo
 *    size to see whether the no-op overhead tracks tier size.
 *
 * FAILURE BOUND (non-zero exit): any `gc_live_%` relation survives the loop, OR
 * — from the PAIRED TWIN-REPO sweep, whose two arms are byte-identical repos
 * measured in alternation so drift cancels — `sweepEncodings` adds more than 15% to
 * a no-op pass (C2 made real). The 120-pass arm above it is reported for context
 * but NOT bounded: its two halves run in blocks minutes apart, and this shared box
 * drifts by more than the effect, which flipped sign between runs.
 *
 *   npx tsx perf/breakage/pgres--gc-pass-overhead.ts --passes=120 --repos=12
 */
import type { Sql } from "postgres"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import {
	cleanupTmp,
	fastImport,
	initRepo,
	median,
	numFlag,
	objectsBetween,
	PG_URL,
	revParse,
	runCommits,
	seedObjects,
	setMain,
	sleep,
	table,
} from "./_pgres-util"

const PASSES = numFlag("passes", 120)
const REPOS = numFlag("repos", 12)
const COMMITS = numFlag("commits", 40)

type Catalog = { size: number; ins: number; del: number; upd: number }

/** Database-wide system-catalog churn counters. NOISY (shared instance). */
async function catalogState(pg: Sql): Promise<Catalog> {
	const [r] = await pg<{ size: string; ins: string; del: string; upd: string }[]>`
		select
			sum(pg_total_relation_size(c.oid))::text as size,
			sum(coalesce(s.n_tup_ins, 0))::text as ins,
			sum(coalesce(s.n_tup_del, 0))::text as del,
			sum(coalesce(s.n_tup_upd, 0))::text as upd
		from pg_class c
			join pg_namespace n on n.oid = c.relnamespace
			left join pg_stat_sys_tables s on s.relid = c.oid
		where n.nspname = 'pg_catalog'
			and c.relname in ('pg_class','pg_attribute','pg_type','pg_depend','pg_index','pg_constraint','pg_shdepend')`
	return {
		del: Number(r?.del ?? 0),
		ins: Number(r?.ins ?? 0),
		size: Number(r?.size ?? 0),
		upd: Number(r?.upd ?? 0),
	}
}

async function main(): Promise<void> {
	const iso = await createIsolatedSchema(PG_URL)
	let failed = false
	try {
		const pg = iso.sql
		const gc = createGc(pg)
		const repack = createRepack(pg)

		// A small fleet of repos — the drain's real shape (one pass per repo per tick).
		const dir = await initRepo("gcpass")
		await fastImport(
			dir,
			runCommits({
				blobChars: 500,
				branch: "refs/heads/main",
				count: COMMITS,
				markStart: 0,
				salt: "gcpass",
			}).stream,
		)
		const tip = await revParse(dir, "refs/heads/main")
		const objects = await objectsBetween(dir, tip, [])
		const names = Array.from({ length: REPOS }, (_, i) => `fleet-${i}`)
		for (const n of names) {
			await seedObjects(pg, n, objects)
			await setMain(pg, n, tip)
		}

		// ── C2: the cost of a NO-OP pass, tier absent vs tier present ───────────
		// A pass over a repo with nothing unreachable reclaims nothing; what is left
		// is the fixed cost — staging table create/truncate/drop, the closure walk,
		// and the three sweeps (objects, edges, encodings).
		const noop = async (rounds: number): Promise<number[]> => {
			const out: number[] = []
			for (let i = 0; i < rounds; i++) {
				const name = names[i % names.length] as string
				const t = Date.now()
				await gc.gc(name, { graceSeconds: 3600, maintain: false })
				out.push(Date.now() - t)
			}
			return out
		}

		await noop(REPOS) // warm caches / plans
		const c0 = await catalogState(pg)
		const t0 = Date.now()
		const bare = await noop(PASSES)
		const bareMs = Date.now() - t0
		const c1 = await catalogState(pg)

		// Idle control window of the same duration — the ambient catalog churn from
		// the sibling agents on this shared instance.
		await sleep(bareMs)
		const c2 = await catalogState(pg)

		// Now build the tier on every repo and repeat the identical loop.
		for (const n of names) await repack.repack(n)
		await noop(REPOS)
		const c3 = await catalogState(pg)
		const t1 = Date.now()
		const withTier = await noop(PASSES)
		const withMs = Date.now() - t1
		const c4 = await catalogState(pg)

		// ── leftovers ──────────────────────────────────────────────────────────
		const left = await pg<{ relname: string }[]>`
			select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = ${iso.schema} and c.relname like 'gc\\_live\\_%'`

		console.log("# GC pass: fixed cost and catalog churn\n")
		console.log(
			`${REPOS} repos × ${objects.length} objects each · ${PASSES} no-op passes per arm\n`,
		)
		console.log(
			table(
				["arm", "passes", "p50 ms", "p95 ms", "total ms", "ms/pass"],
				[
					[
						"tier ABSENT (never repacked)",
						bare.length,
						median(bare).toFixed(1),
						[...bare].sort((a, b) => a - b)[Math.floor(bare.length * 0.95)] ?? 0,
						bareMs,
						(bareMs / bare.length).toFixed(1),
					],
					[
						"tier PRESENT (repacked)",
						withTier.length,
						median(withTier).toFixed(1),
						[...withTier].sort((a, b) => a - b)[Math.floor(withTier.length * 0.95)] ?? 0,
						withMs,
						(withMs / withTier.length).toFixed(1),
					],
				],
			),
		)
		const overhead = median(withTier) / median(bare) - 1
		console.log(
			`\nsweepEncodings overhead on a NO-OP pass: ${(overhead * 100).toFixed(0)}% (median ${median(bare).toFixed(1)} → ${median(withTier).toFixed(1)} ms)`,
		)

		console.log("\n## system-catalog churn (DATABASE-wide — noisy, control included)\n")
		const rate = (a: Catalog, b: Catalog, n: number): (string | number)[] => [
			((b.ins - a.ins) / n).toFixed(1),
			((b.del - a.del) / n).toFixed(1),
			((b.upd - a.upd) / n).toFixed(1),
			((b.size - a.size) / 1024).toFixed(0),
			((b.size - a.size) / 1024 / n).toFixed(1),
		]
		console.log(
			table(
				[
					"window",
					"catalog rows INS /pass",
					"DEL /pass",
					"UPD /pass",
					"catalog KB (window)",
					"catalog KB /pass",
				],
				[
					["GC loop, tier absent", ...rate(c0, c1, PASSES)],
					["IDLE control (same duration)", ...rate(c1, c2, PASSES)],
					["GC loop, tier present", ...rate(c3, c4, PASSES)],
				],
			),
		)
		console.log(
			"\nEvery GC pass creates and drops one `gc_live_<id>` UNLOGGED table. Those catalog rows are DEAD TUPLES in pg_class/pg_attribute/pg_depend — shared by every repo and every schema in the database, never vacuumed by `maintain()`, and produced once per repo per drain interval, forever.",
		)

		// ── does the no-op sweep cost scale with the tier's SIZE? ───────────────
		console.log("\n## does the fixed per-pass cost scale with the tier?\n")
		const scale: (string | number)[][] = []
		let pairedOverhead = 0
		// Append-only history: tree bytes grow quadratically and so does the GC closure
		// walk, so these stay small enough that ~14 passes per size fit the budget.
		for (const size of [120, 360, 1000]) {
			const repo = `scale-${size}`
			const sdir = await initRepo(`scale-${size}`)
			await fastImport(
				sdir,
				runCommits({
					blobChars: 300,
					branch: "refs/heads/main",
					count: size,
					markStart: 0,
					salt: `sc${size}`,
				}).stream,
			)
			const stip = await revParse(sdir, "refs/heads/main")
			const sobjs = await objectsBetween(sdir, stip, [])
			await seedObjects(pg, repo, sobjs)
			await setMain(pg, repo, stip)

			const timeNoop = async (n: number): Promise<number> => {
				const xs: number[] = []
				for (let i = 0; i < n; i++) {
					const t = Date.now()
					await gc.gc(repo, { graceSeconds: 3600, maintain: false })
					xs.push(Date.now() - t)
				}
				return median(xs)
			}
			await timeNoop(2)
			const bareMed = await timeNoop(5)
			await repack.repack(repo)
			await timeNoop(2)
			const tierMed = await timeNoop(5)
			scale.push([
				sobjs.length,
				bareMed.toFixed(1),
				tierMed.toFixed(1),
				(tierMed - bareMed).toFixed(1),
				`${(((tierMed - bareMed) / bareMed) * 100).toFixed(0)}%`,
			])
			pairedOverhead = (tierMed - bareMed) / bareMed
		}
		console.log(
			table(
				[
					"repo objects (= tier rows)",
					"no-op pass, tier absent (ms)",
					"no-op pass, tier present (ms)",
					"added by sweepEncodings (ms)",
					"overhead",
				],
				scale,
			),
		)
		const first = scale[0] as (string | number)[]
		const last = scale[scale.length - 1] as (string | number)[]
		console.log(
			`\nadded cost went ${Number(first[3]).toFixed(0)} ms → ${Number(last[3]).toFixed(0)} ms while the tier grew ${(Number(last[0]) / Number(first[0])).toFixed(1)}× — a no-op sweep must walk the repo's whole encoding tier before it can conclude the batch is empty (the \`limit\` applies AFTER the filter).`,
		)

		console.log(
			`\nleftover gc_live_% relations in the harness's own schema after ${PASSES * 2 + REPOS * 2} passes: ${left.length === 0 ? "0 (clean)" : left.map((l) => l.relname).join(", ")}`,
		)
		if (left.length > 0) failed = true
		if (pairedOverhead > 0.15) failed = true
		console.log(
			`\nunpaired 120-pass arm measured ${(overhead * 100).toFixed(0)}% — NOT bounded; its halves run minutes apart and this box drifts by more than that.`,
		)
		console.log(
			`\n${failed ? "FAIL" : "ok  "}  BOUND: no leftover staging tables, and the PAIRED twin-repo sweep adds ≤15% to a no-op pass (measured ${(pairedOverhead * 100).toFixed(0)}%).`,
		)
	} finally {
		cleanupTmp()
		await iso.drop()
	}
	if (failed) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

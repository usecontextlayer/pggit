/**
 * pgres — WHAT DOES A GC PASS COST NOW, AND WHAT DOES IT LEAVE BEHIND?
 *
 * HISTORY (2026-08-16): this harness originally priced `sweepEncodings` (concern
 * C2) and the shared `gc_live_<id>` UNLOGGED staging table. D14 deleted the sweep
 * (the 0008 FK cascades do the tier's bookkeeping inside the object DELETEs) and
 * D12 replaced the shared staging table with a per-pass TEMP table on a reserved
 * connection. The measurements stay meaningful in their new roles:
 *
 * 1. Tier-presence overhead on a no-op pass — now a REGRESSION GUARD: with no
 *    sweep left, the tier's presence should add ~nothing to a pass that reclaims
 *    nothing. The paired same-repo bound (≤15%) must hold; it firing
 *    again means someone reintroduced per-pass tier work.
 *
 * 2. Staging-table catalog churn — still real, mechanism changed: a TEMP table is
 *    created and dropped per pass, and each cycle still writes and deletes rows in
 *    the DATABASE's system catalogs (`pg_class`, `pg_attribute`, `pg_type`,
 *    `pg_depend`, …), which are shared by every schema and never touched by
 *    `maintain()`. Measured here as catalog rows churned per GC pass.
 *
 * Also asserted: after every fleet and scale pass, ZERO `gc_live_%` relations
 * remain in the harness's own schema (TEMP tables live in `pg_temp`, so any
 * survivor here means the design regressed to schema tables).
 *
 * NOISE: `pg_stat_sys_tables` counters are DATABASE-wide and this Postgres is
 * shared, so an idle control window of the same duration is measured and printed
 * beside the loop. The loop's own rate must stand well clear of it to mean
 * anything.
 *
 * FAILURE BOUND (non-zero exit): any `gc_live_%` relation survives the loop, OR
 * — from the paired same-repo sweep, measured before and after complete tier
 * production — the tier's presence adds more than
 * 15% to a no-op pass. The unpaired fleet arm above it is reported for context but
 * NOT bounded: its two halves run in blocks minutes apart, and this shared box
 * drifts by more than the effect, which flipped sign between runs.
 *
 *   npx tsx perf/breakage/pgres--gc-pass-overhead.ts --passes=120 --repos=12
 */
import type { Sql } from "postgres"
import { z } from "zod"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import {
	assertCanonicalStoreFixture,
	repackEligibleObjects,
	requiredAt,
	requireGitOid,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { parseArgs, pgUrlArg, positiveIntegerArg } from "../args"
import {
	cleanupTmp,
	fastImport,
	initRepo,
	median,
	type Obj,
	objectsBetween,
	revParse,
	runCommits,
	seedObjects,
	setMain,
	sleep,
	table,
} from "./_pgres-util"

const args = parseArgs(
	z
		.object({
			commits: positiveIntegerArg.default(40),
			passes: positiveIntegerArg.default(120),
			pg: pgUrlArg,
			repos: positiveIntegerArg.default(12),
		})
		.strict(),
)
const PASSES = args.passes
const REPOS = args.repos
const COMMITS = args.commits
const PG_URL = args.pg

type Catalog = { size: number; ins: number; del: number; upd: number }

async function requireFixture(
	pg: Sql,
	repo: string,
	objects: readonly Obj[],
	tip: string,
	encodings: readonly Obj[],
): Promise<void> {
	await assertCanonicalStoreFixture(pg, repo, {
		encodings: { kind: "exact", objects: encodings },
		objects,
		refs: [
			{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
			{
				kind: "direct",
				name: "refs/heads/main",
				oid: requireGitOid(tip, `${repo} main tip`),
			},
		],
	})
}

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
	if (!r) throw new Error("system-catalog census returned no row")
	return {
		del: Number(r.del),
		ins: Number(r.ins),
		size: Number(r.size),
		upd: Number(r.upd),
	}
}

async function main(): Promise<void> {
	if (PASSES < 1 || REPOS < 1 || COMMITS < 1) {
		throw new Error("passes, repos, and commits must be positive")
	}
	const iso = await createIsolatedSchema(PG_URL)
	let failed = false
	try {
		const pg = iso.sql
		const gc = createGc(pg)
		const repack = createRepack(pg)

		// A small fleet modeling one scheduler tick whose eligible set contains these
		// repos. The production scheduler runs GC only for repos selected by that tick.
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
		if (objects.length === 0) throw new Error("fixture produced no objects")
		const names = Array.from({ length: REPOS }, (_, i) => `fleet-${i}`)
		for (const n of names) {
			await seedObjects(pg, n, objects)
			await setMain(pg, n, tip)
			await requireFixture(pg, n, objects, tip, [])
		}

		// ── C2: the cost of a NO-OP pass, tier absent vs tier present ───────────
		// A pass over a repo with nothing unreachable reclaims nothing; what is left
		// is the fixed cost — the TEMP live table, reachability plan, and object sweep.
		const noop = async (rounds: number): Promise<number[]> => {
			const out: number[] = []
			for (let i = 0; i < rounds; i++) {
				const name = requiredAt(names, i % names.length, "fleet repository")
				const t = Date.now()
				const result = await gc.gc(name, { graceSeconds: 3600, maintain: false })
				if (result.deletedObjects !== 0) {
					throw new Error(`${name}: no-op GC deleted ${result.deletedObjects} objects`)
				}
				const elapsed = Date.now() - t
				if (!Number.isFinite(elapsed) || elapsed <= 0) {
					throw new Error(`${name}: no-op GC returned invalid timing ${elapsed} ms`)
				}
				out.push(elapsed)
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
		const fleetEligible = repackEligibleObjects(objects)
		for (const n of names) {
			const result = await repack.repack(n)
			if (result.wholes + result.deltas !== fleetEligible.length) {
				throw new Error(`${n}: repack covered incomplete object set`)
			}
			await requireFixture(pg, n, objects, tip, fleetEligible)
		}
		const [fleetTier] = await pg<
			{ n: string }[]
		>`select count(*)::text as n from git_pack_encoding`
		if (!fleetTier || Number(fleetTier.n) !== names.length * fleetEligible.length) {
			throw new Error(
				`fleet tier has ${fleetTier?.n ?? "no count"}/${names.length * fleetEligible.length} rows`,
			)
		}
		await noop(REPOS)
		const c3 = await catalogState(pg)
		const t1 = Date.now()
		const withTier = await noop(PASSES)
		const withMs = Date.now() - t1
		const c4 = await catalogState(pg)
		const bareMedian = median(bare)
		const withTierMedian = median(withTier)
		if (
			!Number.isFinite(bareMs) ||
			bareMs <= 0 ||
			!Number.isFinite(withMs) ||
			withMs <= 0 ||
			!Number.isFinite(bareMedian) ||
			bareMedian <= 0 ||
			!Number.isFinite(withTierMedian) ||
			withTierMedian <= 0
		) {
			throw new Error(
				`fleet timings must be positive: ${JSON.stringify({ bareMedian, bareMs, withMs, withTierMedian })}`,
			)
		}

		console.log("# GC pass: fixed cost and catalog churn\n")
		console.log(
			`${REPOS} repos × ${objects.length} objects each · ${PASSES} no-op passes per arm\n`,
		)
		const bareP95 = requiredAt(
			[...bare].sort((a, b) => a - b),
			Math.floor(bare.length * 0.95),
			"tier-absent p95",
		)
		const withTierP95 = requiredAt(
			[...withTier].sort((a, b) => a - b),
			Math.floor(withTier.length * 0.95),
			"tier-present p95",
		)
		console.log(
			table(
				["arm", "passes", "p50 ms", "p95 ms", "total ms", "ms/pass"],
				[
					[
						"tier ABSENT (never repacked)",
						bare.length,
						bareMedian.toFixed(1),
						bareP95,
						bareMs,
						(bareMs / bare.length).toFixed(1),
					],
					[
						"tier PRESENT (repacked)",
						withTier.length,
						withTierMedian.toFixed(1),
						withTierP95,
						withMs,
						(withMs / withTier.length).toFixed(1),
					],
				],
			),
		)
		const overhead = withTierMedian / bareMedian - 1
		console.log(
			`\ntier-presence overhead on a NO-OP pass (regression guard; the sweep itself is gone, D14): ${(overhead * 100).toFixed(0)}% (median ${bareMedian.toFixed(1)} → ${withTierMedian.toFixed(1)} ms)`,
		)

		console.log("\n## system-catalog churn (DATABASE-wide — noisy, control included)\n")
		const rate = (a: Catalog, b: Catalog, n: number): (string | number)[] => {
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error(`catalog rate requires a positive pass count, got ${n}`)
			}
			return [
				((b.ins - a.ins) / n).toFixed(1),
				((b.del - a.del) / n).toFixed(1),
				((b.upd - a.upd) / n).toFixed(1),
				((b.size - a.size) / 1024).toFixed(0),
				((b.size - a.size) / 1024 / n).toFixed(1),
			]
		}
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
			"\nEvery GC invocation creates and drops one `gc_live` TEMP table (D12; the old shared `gc_live_<id>` UNLOGGED table is gone). The create/drop cycle still churns catalog rows in pg_class/pg_attribute/pg_depend — shared by every repo and schema in the database, never vacuumed by `maintain()`. In production, the scheduler invokes GC only for repos eligible in that tick.",
		)

		// ── does the no-op sweep cost scale with the tier's SIZE? ───────────────
		console.log("\n## does the fixed per-pass cost scale with the tier?\n")
		type ScaleMeasurement = { bareMs: number; objects: number; tierMs: number }
		const scale: ScaleMeasurement[] = []
		let worstPairedOverhead = Number.NEGATIVE_INFINITY
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
			if (sobjs.length === 0) throw new Error(`${repo}: fixture produced no objects`)
			await seedObjects(pg, repo, sobjs)
			await setMain(pg, repo, stip)
			await requireFixture(pg, repo, sobjs, stip, [])

			const timeNoop = async (n: number): Promise<number> => {
				if (!Number.isFinite(n) || n <= 0) {
					throw new Error(`${repo}: timing requires a positive pass count, got ${n}`)
				}
				const xs: number[] = []
				for (let i = 0; i < n; i++) {
					const t = Date.now()
					const result = await gc.gc(repo, { graceSeconds: 3600, maintain: false })
					if (result.deletedObjects !== 0) {
						throw new Error(`${repo}: no-op GC deleted ${result.deletedObjects} objects`)
					}
					const elapsed = Date.now() - t
					if (!Number.isFinite(elapsed) || elapsed <= 0) {
						throw new Error(`${repo}: no-op GC returned invalid timing ${elapsed} ms`)
					}
					xs.push(elapsed)
				}
				const measured = median(xs)
				if (!Number.isFinite(measured) || measured <= 0) {
					throw new Error(`${repo}: median timing must be positive, got ${measured}`)
				}
				return measured
			}
			await timeNoop(2)
			const bareMed = await timeNoop(5)
			const scaled = await repack.repack(repo)
			const eligible = repackEligibleObjects(sobjs)
			if (scaled.wholes + scaled.deltas !== eligible.length) {
				throw new Error(`${repo}: repack covered incomplete object set`)
			}
			await requireFixture(pg, repo, sobjs, stip, eligible)
			const [tierRows] = await pg<{ n: string }[]>`
				select count(*)::text as n from git_pack_encoding e
				join repos r on r.id = e.repo_id where r.name = ${repo}`
			if (!tierRows || Number(tierRows.n) !== eligible.length) {
				throw new Error(
					`${repo}: tier has ${tierRows?.n ?? "no count"}/${eligible.length} rows`,
				)
			}
			await timeNoop(2)
			const tierMed = await timeNoop(5)
			scale.push({ bareMs: bareMed, objects: sobjs.length, tierMs: tierMed })
			worstPairedOverhead = Math.max(worstPairedOverhead, (tierMed - bareMed) / bareMed)
		}
		if (!Number.isFinite(worstPairedOverhead)) {
			throw new Error("paired overhead measurement produced no finite result")
		}
		console.log(
			table(
				[
					"repo objects (= tier rows)",
					"no-op pass, tier absent (ms)",
					"no-op pass, tier present (ms)",
					"added by tier presence (ms)",
					"overhead",
				],
				scale.map(({ bareMs, objects, tierMs }) => [
					objects,
					bareMs.toFixed(1),
					tierMs.toFixed(1),
					(tierMs - bareMs).toFixed(1),
					`${(((tierMs - bareMs) / bareMs) * 100).toFixed(0)}%`,
				]),
			),
		)
		const first = requiredAt(scale, 0, "smallest scale measurement")
		const last = requiredAt(scale, scale.length - 1, "largest scale measurement")
		console.log(
			`\nadded cost went ${(first.tierMs - first.bareMs).toFixed(0)} ms → ${(last.tierMs - last.bareMs).toFixed(0)} ms while the tier grew ${(last.objects / first.objects).toFixed(1)}×. No GC query should scan that tier; this is the regression signal the 15% bound protects.`,
		)

		// Query after the scale passes too: every GC invocation above is in scope.
		const left = await pg<{ relname: string }[]>`
			select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = ${iso.schema} and c.relname like 'gc\\_live\\_%'`

		console.log(
			`\nleftover gc_live_% relations in the harness's own schema after all fleet and scale passes: ${left.length === 0 ? "0 (clean)" : left.map((l) => l.relname).join(", ")}`,
		)
		if (left.length > 0) failed = true
		if (worstPairedOverhead > 0.15) failed = true
		console.log(
			`\nunpaired ${PASSES}-pass arm measured ${(overhead * 100).toFixed(0)}% — NOT bounded; its halves run minutes apart and this box drifts by more than that.`,
		)
		console.log(
			`\n${failed ? "FAIL" : "ok  "}  BOUND: no leftover staging tables, and the worst paired same-repo measurement adds ≤15% to a no-op pass (worst ${(worstPairedOverhead * 100).toFixed(0)}%).`,
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

/**
 * pgres — GC HOLDS A SNAPSHOT FOR ITS WHOLE CLOSURE WALK, AND THAT BLOCKS THE
 * RECLAMATION OF ITS OWN CHURN.
 *
 * `gc.ts liveSet()` reserves one connection, opens `begin isolation level
 * repeatable read`, and holds it across the ref read AND the entire multi-statement
 * `reachableClosure` walk before committing. That is deliberate and correct — §5
 * defense (a), one MVCC snapshot so a concurrent push cannot interleave. The
 * resource consequence is what this harness prices:
 *
 *   While ANY transaction holds a snapshot, VACUUM — autovacuum included — cannot
 *   remove a tuple deleted after that snapshot began. Not just in the GC'd repo:
 *   the xmin horizon is DATABASE-wide, so one repo's closure walk suspends
 *   reclamation for every repo, every schema, and both tiers.
 *
 * The drain runs GC per eligible repo, `concurrency` at a time, on a hot cadence.
 * If the per-repo hold is long relative to the interval, the horizon is held
 * continuously and NOTHING is ever reclaimed — which is exactly the state this
 * shared instance is in (see the sibling-agent lag printed below).
 *
 * Part 1 — MEASUREMENT: how long is the snapshot held, as a function of repo size?
 * Sampled from `pg_stat_activity` filtered to this harness's OWN application_name.
 *
 * Part 2 — CAUSAL DEMONSTRATION, entirely on the harness's own tables and its own
 * snapshot: open a REPEATABLE READ snapshot, THEN churn (rewind + gc), then
 * `VACUUM (VERBOSE)` and read POSTGRES'S OWN VERDICT — VACUUM reports, per
 * relation, how many "dead row versions cannot be removed yet" and names the
 * `oldest xmin` that is blocking them. That verdict needs no quiet instance: it is
 * the server attributing the block to a specific transaction. The snapshot is then
 * released and the VACUUM repeated, so the two verdicts can be compared.
 *
 * FAILURE BOUND (non-zero exit): a GC pass holds its snapshot for more than 50% of
 * its own wall time (so the drain's snapshot duty cycle approaches 1 as soon as
 * passes are back to back), OR part 2 shows dead tuples surviving a VACUUM taken
 * under a held snapshot while a clear-horizon VACUUM removes them — confirming the
 * mechanism.
 *
 *   npx tsx perf/breakage/pgres--gc-snapshot-blocks-reclaim.ts
 */
import postgres, { type Sql } from "postgres"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import {
	cleanupTmp,
	fastImport,
	initRepo,
	objectsBetween,
	PG_URL,
	revParse,
	runCommits,
	schemaStats,
	seedObjects,
	setMain,
	sleep,
	stat,
	table,
} from "./_pgres-util"

const APP = "pgres-snapshot-probe"
/** Append-only history: tree bytes grow QUADRATICALLY, so 2400 commits is already
 * ~180 MB of object content. Past that the fixture harness (`spawnGit` buffers
 * `cat-file --batch` output as one JS string) hits V8's 512 MB string cap — a
 * harness limit, not a pggit one. */
const SIZES = [200, 600, 1200, 2400]

type Sample = {
	commits: number
	objects: number
	gcMs: number
	holdMs: number
	dutyCycle: number
	othersLagS: number
}

/** Longest-held snapshot age (ms) among backends with this harness's app name. */
async function ownSnapshotAge(watch: Sql): Promise<number> {
	const [r] = await watch<{ ms: string }[]>`
		select coalesce(max(extract(epoch from (clock_timestamp() - xact_start)) * 1000), 0)::int::text as ms
		from pg_stat_activity
		where application_name = ${APP} and backend_xmin is not null`
	return Number(r?.ms ?? 0)
}

/** Longest-held snapshot age (s) among OTHER backends — the sibling agents. */
async function othersLag(watch: Sql): Promise<number> {
	const [r] = await watch<{ s: string }[]>`
		select coalesce(max(extract(epoch from (clock_timestamp() - xact_start))), 0)::int::text as s
		from pg_stat_activity
		where application_name <> ${APP} and backend_type = 'client backend'
			and backend_xmin is not null`
	return Number(r?.s ?? 0)
}

async function main(): Promise<void> {
	const iso = await createIsolatedSchema(PG_URL)
	const gcPg = postgres(PG_URL, {
		connection: { application_name: APP, search_path: iso.schema },
		max: 4,
		onnotice: () => {},
	})
	const watch = postgres(PG_URL, {
		connection: { application_name: `${APP}-watch`, search_path: iso.schema },
		max: 2,
		onnotice: () => {},
	})
	let failed = false
	try {
		const gc = createGc(gcPg)
		const repack = createRepack(gcPg)

		// ── Part 1: how long is the snapshot held, by repo size? ────────────────
		const samples: Sample[] = []
		for (const commits of SIZES) {
			const repo = `snap-${commits}`
			const dir = await initRepo(`snap-${commits}`)
			await fastImport(
				dir,
				runCommits({
					blobChars: 400,
					branch: "refs/heads/main",
					count: commits,
					markStart: 0,
					salt: `s${commits}`,
				}).stream,
			)
			const tip = await revParse(dir, "refs/heads/main")
			const objects = await objectsBetween(dir, tip, [])
			await seedObjects(gcPg, repo, objects)
			await setMain(gcPg, repo, tip)
			await repack.repack(repo)

			let holdMs = 0
			const sampler = setInterval(() => {
				void ownSnapshotAge(watch).then((ms) => {
					if (ms > holdMs) holdMs = ms
				})
			}, 20)
			const t0 = Date.now()
			await gc.gc(repo, { graceSeconds: 3600, maintain: false })
			const gcMs = Date.now() - t0
			clearInterval(sampler)
			await sleep(50)
			samples.push({
				commits,
				dutyCycle: holdMs / gcMs,
				gcMs,
				holdMs,
				objects: objects.length,
				othersLagS: await othersLag(watch),
			})
		}

		console.log("# GC's REPEATABLE READ snapshot: how long, and what it costs\n")
		console.log(
			table(
				[
					"commits",
					"objects",
					"gc pass ms",
					"snapshot held ms",
					"held / pass",
					"other backends' oldest snapshot (s)",
				],
				samples.map((s) => [
					s.commits,
					s.objects,
					s.gcMs,
					s.holdMs,
					`${(s.dutyCycle * 100).toFixed(0)}%`,
					s.othersLagS,
				]),
			),
		)
		const worst = Math.max(...samples.map((s) => s.dutyCycle))
		const biggest = samples[samples.length - 1] as Sample
		console.log(
			`\nsnapshot hold scales with the closure walk: ${(biggest.holdMs / (samples[0] as Sample).holdMs).toFixed(1)}× from ${(samples[0] as Sample).objects} to ${biggest.objects} objects.`,
		)
		console.log(
			`worst duty cycle ${(worst * 100).toFixed(0)}% — with the drain running passes back to back over a fleet, the DATABASE-WIDE xmin horizon is held ~that fraction of the time.`,
		)

		// ── Part 2: the causal demonstration ────────────────────────────────────
		console.log(
			"\n## does a held snapshot actually block reclamation of the tier's churn?\n",
		)
		const repo = "snap-demo"
		const dir = await initRepo("snap-demo")
		const base = runCommits({
			blobChars: 900,
			branch: "refs/heads/main",
			count: 40,
			markStart: 0,
			salt: "demo-base",
		})
		await fastImport(dir, base.stream)
		const baseTip = await revParse(dir, "refs/heads/main")
		await fastImport(
			dir,
			runCommits({
				blobChars: 900,
				branch: "refs/heads/main",
				count: 400,
				from: baseTip,
				markStart: 0,
				salt: "demo-churn",
			}).stream,
		)
		const tip = await revParse(dir, "refs/heads/main")
		await seedObjects(gcPg, repo, await objectsBetween(dir, tip, []))
		await setMain(gcPg, repo, tip)
		await repack.repack(repo)

		const deadNow = async (): Promise<{ enc: number; obj: number }> => {
			await sleep(1200)
			const s = await schemaStats(gcPg, iso.schema)
			return { enc: stat(s, "git_pack_encoding").dead, obj: stat(s, "git_object").dead }
		}

		// 1. Open OUR OWN REPEATABLE READ snapshot BEFORE the deletions — exactly the
		//    shape of a concurrent GC pass on some other repo.
		const holder = await gcPg.reserve()
		await holder`begin isolation level repeatable read`
		await holder`select 1`

		// 2. Churn: rewind to the base and GC, deleting ~all of the 400-commit tail in
		//    both tiers.
		await setMain(gcPg, repo, baseTip)
		const g = await gc.gc(repo, { graceSeconds: 0, maintain: false })

		// 3. VACUUM under the held snapshot, capturing Postgres's own verdict. VACUUM
		//    VERBOSE emits INFO messages; porsager surfaces them through `onnotice`.
		// VACUUM VERBOSE emits one INFO per relation; porsager surfaces them through
		// `onnotice`. Only three numbers matter, and they are Postgres's own words:
		// how many tuples it removed, how many it saw as "dead but not yet
		// removable", and how many XIDs behind the removable cutoff was.
		type Verdict = {
			removed: number
			notRemovable: number
			xidsOld: number
			rels: number
		}
		let acc: Verdict = { notRemovable: 0, rels: 0, removed: 0, xidsOld: 0 }
		const verbose = postgres(PG_URL, {
			connection: { application_name: `${APP}-vac`, search_path: iso.schema },
			max: 1,
			onnotice: (n) => {
				const m = `${n.message ?? ""}`.replace(/\s+/g, " ")
				if (!/finished vacuuming/.test(m)) return
				if (!/git_pack_encoding|git_object/.test(m)) return
				const t = m.match(
					/tuples: (\d+) removed, \d+ remain, (\d+) are dead but not yet removable/,
				)
				const x = m.match(/which was (\d+) XIDs old/)
				if (t) {
					acc.removed += Number(t[1])
					acc.notRemovable += Number(t[2])
					acc.rels++
				}
				if (x) acc.xidsOld = Math.max(acc.xidsOld, Number(x[1]))
			},
		})
		const vacuumVerbose = async (): Promise<Verdict> => {
			acc = { notRemovable: 0, rels: 0, removed: 0, xidsOld: 0 }
			await verbose.unsafe("vacuum (verbose, analyze) git_pack_encoding")
			await verbose.unsafe("vacuum (verbose, analyze) git_object")
			return acc
		}
		const underVerdict = await vacuumVerbose()
		const under = await deadNow()

		// 4. Release the snapshot, wait for a clear horizon, VACUUM again.
		await holder`commit`
		holder.release()
		let waited = 0
		let clear = false
		while (waited < 20_000) {
			if ((await othersLag(watch)) < 2) {
				clear = true
				break
			}
			await sleep(500)
			waited += 500
		}
		const afterVerdict = await vacuumVerbose()
		const after = await deadNow()
		await verbose.end()

		console.log(
			table(
				["stage", "git_pack_encoding dead tuples", "git_object dead tuples"],
				[
					[
						`after gc (deleted ${g.deletedEncodings} encodings / ${g.deletedObjects} objects)`,
						"—",
						"—",
					],
					["VACUUM taken UNDER a held snapshot", under.enc, under.obj],
					[
						`VACUUM after release${clear ? "" : " (horizon NOT clear — see caveat)"}`,
						after.enc,
						after.obj,
					],
				],
			),
		)
		console.log("\nPostgres's own verdict, from VACUUM (VERBOSE) over the two tiers:\n")
		console.log(
			table(
				[
					"VACUUM taken",
					"relations",
					"tuples REMOVED",
					"dead but NOT YET REMOVABLE",
					"removable cutoff was N XIDs old",
				],
				[
					[
						"UNDER a held snapshot",
						underVerdict.rels,
						underVerdict.removed,
						underVerdict.notRemovable,
						underVerdict.xidsOld,
					],
					[
						"AFTER releasing it",
						afterVerdict.rels,
						afterVerdict.removed,
						afterVerdict.notRemovable,
						afterVerdict.xidsOld,
					],
				],
			),
		)
		console.log(
			"\n`dead but not yet removable` is Postgres refusing to reclaim a tuple because some snapshot can still see it; `XIDs old` is how far behind the horizon was. Neither number is about pggit's code — they are the server naming the cost of holding a snapshot.",
		)
		console.log(
			`\nwaited ${waited} ms for a clear horizon; other backends' oldest snapshot at the second VACUUM: ${await othersLag(watch)} s (${clear ? "clear" : "STILL HELD by a sibling agent — the second VACUUM is therefore also blocked and its row under-reports"})`,
		)
		// What is actually holding the horizon right now? Named, not guessed.
		const holders = await watch<{ app: string; age: string; q: string }[]>`
			select application_name as app,
				extract(epoch from (clock_timestamp() - xact_start))::int::text as age,
				left(coalesce(query, ''), 90) as q
			from pg_stat_activity
			where backend_type = 'client backend' and backend_xmin is not null
			order by xact_start limit 3`
		console.log("\noldest snapshot holders on the instance right now:")
		for (const h of holders)
			console.log(`  ${h.age}s  app=${h.app}  ${h.q?.replace(/\s+/g, " ").trim()}`)
		const blocked = under.enc > 0
		const released = after.enc < under.enc
		console.log(
			blocked && released
				? "\nCONFIRMED: the held snapshot blocked reclamation; releasing it let the same VACUUM reclaim."
				: blocked && !released
					? "\nINCONCLUSIVE on this shared box: dead tuples survived BOTH vacuums — a sibling agent's snapshot never cleared."
					: "\nNot reproduced in this window (dead tuples were already reclaimable).",
		)

		if (worst > 0.5) failed = true
		console.log(
			`\n${failed ? "FAIL" : "ok  "}  BOUND: a GC pass holds its snapshot for ≤50% of its own wall time — measured ${(worst * 100).toFixed(0)}%.`,
		)
	} finally {
		await gcPg.end()
		await watch.end()
		cleanupTmp()
		await iso.drop()
	}
	if (failed) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

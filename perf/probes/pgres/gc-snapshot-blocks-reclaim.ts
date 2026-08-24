/**
 * pgres — GC HOLDS A SNAPSHOT FOR ITS WHOLE CLOSURE WALK, AND THAT BLOCKS THE
 * RECLAMATION OF ITS OWN CHURN.
 *
 * `gc.ts` reserves one connection and `livePlan()` opens `begin isolation level
 * repeatable read` across the ref read and epoch plan. On a fresh fixture the absent
 * epoch forces a full `originClosure` walk inside that snapshot. One MVCC snapshot
 * prevents a concurrent push from interleaving. The resource consequence is what
 * this harness prices:
 *
 *   While ANY transaction holds a snapshot, VACUUM — autovacuum included — cannot
 *   remove a tuple deleted after that snapshot began. Not just in the GC'd repo:
 *   the xmin horizon is DATABASE-wide, so one repo's closure walk suspends
 *   reclamation for every repo, every schema, and both tiers.
 *
 * A host can run GC passes back to back over a fleet. If the per-repo hold is long
 * relative to the interval, the horizon can be held nearly continuously; the
 * other-backend lag printed below is context, not evidence about this harness.
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
 * passes are back to back). Part 2 is the causal prerequisite for interpreting that
 * score: it must prove the held snapshot blocked reclaim and the clear-horizon
 * VACUUM removed the same churn, but confirmation of the documented MVCC mechanism
 * is evidence, not a second performance failure.
 *
 *   npx tsx perf/probes/pgres/gc-snapshot-blocks-reclaim.ts
 */
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs, pgUrlArg } from "@perf/args"
import { table } from "@perf/probes/_table"
import { vacuumVerbose } from "@perf/probes/_vacuum-evidence"
import {
	cleanupTmp,
	fastImport,
	initRepo,
	objectsBetween,
	runCommits,
	schemaStats,
	seedObjects,
	setMain,
	stat,
} from "@perf/probes/pgres/_util"
import postgres, { type Sql } from "postgres"
import { z } from "zod"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import {
	assertCanonicalStoreFixture,
	type GitObjectWithOid,
	repackEligibleObjects,
	requiredAt,
	requireGitOid,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"

const APP = "pgres-snapshot-probe"
const { pg: PG_URL } = parseArgs(z.object({ pg: pgUrlArg }).strict())
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

function requireNonnegativeInteger(value: string, context: string): number {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(
			`${context}: expected a nonnegative integer, got ${JSON.stringify(value)}`,
		)
	}
	return parsed
}

async function requireRepoCensus(
	pg: Sql,
	repo: string,
	objects: readonly GitObjectWithOid[],
	tip: string,
): Promise<void> {
	await assertCanonicalStoreFixture(pg, repo, {
		encodings: { kind: "exact", objects: repackEligibleObjects(objects) },
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

/** Longest-held snapshot age (ms) among backends with this harness's app name. */
async function ownSnapshotAge(watch: Sql): Promise<number> {
	const [r] = await watch<{ ms: string }[]>`
		select coalesce(max(extract(epoch from (clock_timestamp() - xact_start)) * 1000), 0)::int::text as ms
		from pg_stat_activity
		where application_name = ${APP} and backend_xmin is not null`
	if (!r) throw new Error("own-snapshot census returned no row")
	return requireNonnegativeInteger(r.ms, "own-snapshot age")
}

/** Longest-held snapshot age (s) among other backends. */
async function othersLag(watch: Sql): Promise<number> {
	const [r] = await watch<{ s: string }[]>`
		select coalesce(max(extract(epoch from (clock_timestamp() - xact_start))), 0)::int::text as s
		from pg_stat_activity
		where application_name <> ${APP} and backend_type = 'client backend'
			and backend_xmin is not null`
	if (!r) throw new Error("other-snapshot census returned no row")
	return requireNonnegativeInteger(r.s, "other-snapshot age")
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
			if (objects.length === 0) throw new Error(`${repo}: fixture produced no objects`)
			await seedObjects(gcPg, repo, objects)
			await setMain(gcPg, repo, tip)
			const encoded = await repack.repack(repo)
			const eligibleObjects = repackEligibleObjects(objects)
			if (
				eligibleObjects.length === 0 ||
				encoded.wholes + encoded.deltas !== eligibleObjects.length
			) {
				throw new Error(`${repo}: repack covered incomplete object set`)
			}
			await requireRepoCensus(gcPg, repo, objects, tip)

			let holdMs = 0
			let sampling = true
			let observed = 0
			const sampler = (async () => {
				while (sampling) {
					const ms = await ownSnapshotAge(watch)
					if (ms > 0) observed++
					if (ms > holdMs) holdMs = ms
					await sleep(20)
				}
			})()
			const t0 = Date.now()
			let gcMs = 0
			let result: Awaited<ReturnType<typeof gc.gc>>
			try {
				result = await gc.gc(repo, { graceSeconds: 3600, maintain: false })
				gcMs = Date.now() - t0
			} finally {
				sampling = false
				await sampler
			}
			if (result.deletedObjects !== 0 || observed === 0 || holdMs <= 0 || gcMs <= 0) {
				throw new Error(
					`${repo}: invalid GC measurement deleted=${result.deletedObjects}, observed=${observed}, hold=${holdMs}, wall=${gcMs}`,
				)
			}
			await requireRepoCensus(gcPg, repo, objects, tip)
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
		const smallest = requiredAt(samples, 0, "smallest snapshot sample")
		const biggest = requiredAt(samples, samples.length - 1, "largest snapshot sample")
		console.log(
			`\nobserved snapshot hold changed ${(biggest.holdMs / smallest.holdMs).toFixed(1)}× from ${smallest.objects} to ${biggest.objects} objects.`,
		)
		console.log(
			`worst duty cycle ${(worst * 100).toFixed(0)}% — back-to-back passes over a fleet would make the DATABASE-WIDE xmin hold approach that fraction.`,
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
		const baseObjects = await objectsBetween(dir, baseTip, [])
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
		const allObjects = await objectsBetween(dir, tip, [])
		const tailObjects = await objectsBetween(dir, tip, [baseTip])
		await seedObjects(gcPg, repo, allObjects)
		await setMain(gcPg, repo, tip)
		const demoRepack = await repack.repack(repo)
		const eligibleDemoObjects = repackEligibleObjects(allObjects)
		if (
			eligibleDemoObjects.length === 0 ||
			demoRepack.wholes + demoRepack.deltas !== eligibleDemoObjects.length ||
			tailObjects.length === 0
		) {
			throw new Error("snapshot demo did not establish a complete nonempty churn tier")
		}
		await requireRepoCensus(gcPg, repo, allObjects, tip)

		const deadNow = async (): Promise<{ enc: number; obj: number }> => {
			await sleep(1200)
			const s = await schemaStats(gcPg, iso.schema)
			if (!s.git_pack_encoding || !s.git_object) {
				throw new Error("snapshot demo storage stats missing measured tables")
			}
			return { enc: stat(s, "git_pack_encoding").dead, obj: stat(s, "git_object").dead }
		}

		// 1. Open OUR OWN REPEATABLE READ snapshot BEFORE the deletions — exactly the
		//    shape of a concurrent GC pass on some other repo.
		const holder = await gcPg.reserve()
		let holderInTransaction = false
		let holderReleased = false
		try {
			await holder`begin isolation level repeatable read`
			holderInTransaction = true
			await holder`select 1`

			// 2. Churn: rewind to the base and GC, deleting ~all of the 400-commit tail in
			//    both tiers.
			await setMain(gcPg, repo, baseTip)
			const g = await gc.gc(repo, { graceSeconds: 0, maintain: false })
			if (g.deletedObjects !== tailObjects.length) {
				throw new Error(
					`snapshot demo GC mismatch: deleted=${g.deletedObjects}/${tailObjects.length}`,
				)
			}
			await requireRepoCensus(gcPg, repo, baseObjects, baseTip)

			// 3. VACUUM under the held snapshot, capturing Postgres's own verdict. VACUUM
			// VERBOSE emits one INFO per relation; porsager surfaces them through
			// `onnotice`. Only three numbers matter, and they are Postgres's own words:
			// how many tuples it removed, how many it saw as "dead but not yet
			// removable", and how many XIDs behind the removable cutoff was.
			const collectVacuumEvidence = () =>
				vacuumVerbose(PG_URL, iso.schema, ["git_pack_encoding", "git_object"], {
					analyze: true,
					applicationName: `${APP}-vac`,
				})
			const underVerdict = await collectVacuumEvidence()
			const under = await deadNow()
			if (
				underVerdict.relations === 0 ||
				underVerdict.notRemovable === 0 ||
				under.enc === 0
			) {
				throw new Error(
					`snapshot demo did not prove blocked reclaim: ${JSON.stringify({ under, underVerdict })}`,
				)
			}

			// 4. Release the snapshot, wait for a clear horizon, VACUUM again.
			await holder`commit`
			holderInTransaction = false
			holder.release()
			holderReleased = true
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
			if (!clear) {
				throw new Error(
					`release-side prerequisite failed: database snapshot horizon did not clear within ${waited} ms`,
				)
			}
			const afterVerdict = await collectVacuumEvidence()
			const after = await deadNow()
			if (afterVerdict.notRemovable !== 0 || after.enc >= under.enc) {
				throw new Error(
					`clear-horizon VACUUM did not reclaim the blocked tier rows: ${JSON.stringify({ after, afterVerdict, under })}`,
				)
			}

			console.log(
				table(
					["stage", "git_pack_encoding dead tuples", "git_object dead tuples"],
					[
						[
							`after gc (deleted ${g.deletedObjects} objects; encodings went with them by cascade)`,
							"—",
							"—",
						],
						["VACUUM taken UNDER a held snapshot", under.enc, under.obj],
						["VACUUM after release and clear horizon", after.enc, after.obj],
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
							underVerdict.relations,
							underVerdict.removed,
							underVerdict.notRemovable,
							underVerdict.xidsOld,
						],
						[
							"AFTER releasing it",
							afterVerdict.relations,
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
				`\nwaited ${waited} ms for a clear horizon; other backends' oldest snapshot at the second VACUUM: ${await othersLag(watch)} s`,
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
					: "\nNot reproduced in this window (dead tuples were already reclaimable).",
			)
			if (worst > 0.5) failed = true
			console.log(
				`\n${failed ? "FAIL" : "ok  "}  BOUND: a GC pass holds its snapshot for ≤50% of its own wall time — measured ${(worst * 100).toFixed(0)}%.`,
			)
		} finally {
			try {
				if (holderInTransaction) await holder`rollback`
			} finally {
				if (!holderReleased) holder.release()
			}
		}
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

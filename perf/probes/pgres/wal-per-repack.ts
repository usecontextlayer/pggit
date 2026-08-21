/**
 * pgres — HOW MUCH WAL DOES THE DERIVED TIER ADD?
 *
 * `git_pack_encoding` is a second, fully-WAL-logged copy of (almost) every object's
 * bytes: `deflate(raw)` for a whole encoding, `deflate(delta program)` for a delta.
 * A repack therefore writes a whole second generation of the repo into WAL, on top
 * of the original push. This measures the multiplier on the same content.
 *
 * Phases measured per trial, on a FRESH schema each time so nothing carries over:
 *   push    — `putPack` of every object + `setRef` (git_object + git_commit/git_tag + TOAST)
 *   repack  — `createRepack().repack()` (git_pack_encoding only)
 *   gc      — `gc(graceSeconds: 0)` after a rewind (delete WAL for both tiers)
 *   delete  — `admin.deleteRepo()`, a bare `DELETE FROM repos` whose ENTIRE teardown
 *             is the FK cascade. Trials run with the tier BOTH present and absent,
 *             isolating the encoding rows' contribution to that cascade.
 *
 * NOISE, stated plainly: `pg_current_wal_lsn()` is INSTANCE-WIDE and this Postgres
 * is shared with sibling agents, so every delta here includes their writes. Three
 * mitigations: (1) N trials, medians reported, spread shown; (2) an idle "control"
 * window of the same wall-clock duration is measured between phases, so the reader
 * can see the ambient rate; (3) phases are short. Treat the RATIO of repack-WAL to
 * push-WAL as the finding, never the absolute bytes.
 *
 * This instance also runs `full_page_writes = off` and `fsync = off` (checked and
 * printed), which SUPPRESSES full-page-image WAL — so every number here is a
 * LOWER BOUND on what a production instance with FPW on would write.
 *
 * FAILURE BOUND (non-zero exit): the median repack WAL exceeds 1.5× the median
 * push WAL for the identical content — i.e. building the derived tier costs more
 * WAL than storing the authoritative objects did.
 *
 *   npx tsx perf/probes/pgres/wal-per-repack.ts --trials=5 --commits=250
 */

import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs, pgUrlArg, positiveIntegerArg } from "@perf/args"
import { median, requireSamples } from "@perf/memory"
import { table } from "@perf/probes/_table"
import {
	cleanupTmp,
	encodingCensus,
	fastImport,
	initRepo,
	mb,
	objectsBetween,
	runCommits,
	seedObjects,
	setMain,
	walLsn,
} from "@perf/probes/pgres/_util"
import { z } from "zod"
import { createGitDeps } from "@/index"
import type { Oid } from "@/oid"
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
import { spawnGit } from "@/testing/spawn-git"

const args = parseArgs(
	z
		.object({
			commits: positiveIntegerArg.default(250),
			pg: pgUrlArg,
			trials: positiveIntegerArg.default(5),
		})
		.strict(),
)
const TRIALS = args.trials
const COMMITS = args.commits
const PG_URL = args.pg
const BLOB_CHARS = 1200
const REPO = "wal"

type Trial = {
	n: number
	mode: "tier-absent" | "tier-present"
	rawBytes: number
	pushWal: number
	repackWal: number
	gcWal: number
	idleWal: number
	deleteWal: number
	pushMs: number
	repackMs: number
	deleteMs: number
	encBytes: number
	encRows: number
}

async function trial(
	n: number,
	dir: string,
	tip: Oid,
	rootCommit: Oid,
	mode: Trial["mode"],
): Promise<Trial> {
	const iso = await createIsolatedSchema(PG_URL)
	try {
		const pg = iso.sql
		const objects = await objectsBetween(dir, tip, [])
		const rootObjects = await objectsBetween(dir, rootCommit, [])
		const reclaimedObjects = await objectsBetween(dir, tip, [rootCommit])
		const eligibleObjects = repackEligibleObjects(objects)
		const eligibleRootObjects = repackEligibleObjects(rootObjects)
		const tierPresent = mode === "tier-present"
		const rawBytes = objects.reduce((s, o) => s + o.content.length, 0)
		if (
			objects.length === 0 ||
			rootObjects.length === 0 ||
			reclaimedObjects.length === 0 ||
			rawBytes === 0
		) {
			throw new Error(
				"WAL fixture did not establish nonempty push, root, and rewind sets",
			)
		}
		const assertRows = async (
			expectedObjects: readonly GitObjectWithOid[],
			expectedEncodings: readonly GitObjectWithOid[],
			expectedTip: Oid,
		): Promise<void> => {
			await assertCanonicalStoreFixture(pg, REPO, {
				encodings: { kind: "exact", objects: expectedEncodings },
				objects: expectedObjects,
				refs: [
					{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
					{
						kind: "direct",
						name: "refs/heads/main",
						oid: expectedTip,
					},
				],
			})
		}

		// PUSH
		const w0 = await walLsn(pg)
		const t0 = Date.now()
		await seedObjects(pg, REPO, objects)
		await setMain(pg, REPO, tip)
		const pushMs = Date.now() - t0
		const w1 = await walLsn(pg)
		await assertRows(objects, [], tip)

		// IDLE control window of comparable duration — the ambient sibling-agent rate.
		await sleep(Math.min(2000, Math.max(300, pushMs)))
		const w2 = await walLsn(pg)

		// REPACK (skipped in the tier-absent arm)
		const t1 = Date.now()
		if (tierPresent) {
			const receipt = await createRepack(pg).repack(REPO)
			if (receipt.wholes + receipt.deltas !== eligibleObjects.length) {
				throw new Error(
					`repack covered ${receipt.wholes + receipt.deltas}/${eligibleObjects.length} eligible objects`,
				)
			}
		}
		const repackMs = Date.now() - t1
		const w3 = await walLsn(pg)

		const census = await encodingCensus(pg)
		if (
			census.rows !== (tierPresent ? eligibleObjects.length : 0) ||
			(tierPresent && census.dataBytes === 0)
		) {
			throw new Error(
				`encoding census does not match repack arm: ${JSON.stringify(census)}, objects=${objects.length}`,
			)
		}
		await assertRows(objects, tierPresent ? eligibleObjects : [], tip)

		// GC after a rewind to the ROOT commit: reclaims almost everything, in both
		// tiers, so the delete-side WAL of the derived tier is visible too.
		await setMain(pg, REPO, rootCommit)
		const w4 = await walLsn(pg)
		const gcReceipt = await createGc(pg).gc(REPO, {
			graceSeconds: 0,
			maintain: false,
		})
		const w5 = await walLsn(pg)
		if (gcReceipt.deletedObjects !== reclaimedObjects.length) {
			throw new Error(
				`GC deleted ${gcReceipt.deletedObjects}/${reclaimedObjects.length} rewind objects`,
			)
		}
		await assertRows(rootObjects, tierPresent ? eligibleRootObjects : [], rootCommit)

		// DELETE the repo: one `DELETE FROM repos`, everything else is the cascade.
		// Re-seed first so the cascade has a full repo to tear down, not a GC'd husk.
		await seedObjects(pg, REPO, objects)
		await setMain(pg, REPO, tip)
		if (tierPresent) {
			const receipt = await createRepack(pg).repack(REPO)
			const restoredEncodings = eligibleObjects.length - eligibleRootObjects.length
			if (receipt.wholes + receipt.deltas !== restoredEncodings) {
				throw new Error(
					`cascade fixture repack covered ${receipt.wholes + receipt.deltas}/${restoredEncodings} restored eligible objects`,
				)
			}
		}
		await assertRows(objects, tierPresent ? eligibleObjects : [], tip)
		const w6 = await walLsn(pg)
		const t2 = Date.now()
		await createGitDeps(pg).admin.deleteRepo(REPO)
		const deleteMs = Date.now() - t2
		const w7 = await walLsn(pg)
		const [remaining] = await pg<
			{
				commits: string
				encodings: string
				objects: string
				refs: string
				repos: string
				tags: string
			}[]
		>`
			select (select count(*)::text from repos) as repos,
				(select count(*)::text from git_object) as objects,
				(select count(*)::text from git_commit) as commits,
				(select count(*)::text from git_tag) as tags,
				(select count(*)::text from git_ref) as refs,
				(select count(*)::text from git_pack_encoding) as encodings`
		if (
			!remaining ||
			Number(remaining.repos) !== 0 ||
			Number(remaining.objects) !== 0 ||
			Number(remaining.commits) !== 0 ||
			Number(remaining.tags) !== 0 ||
			Number(remaining.refs) !== 0 ||
			Number(remaining.encodings) !== 0
		) {
			throw new Error(`repo cascade left rows behind: ${JSON.stringify(remaining)}`)
		}
		const pushWal = Number(w1 - w0)
		const repackWal = Number(w3 - w2)
		const gcWal = Number(w5 - w4)
		const deleteWal = Number(w7 - w6)
		if (pushWal <= 0 || gcWal <= 0 || deleteWal <= 0 || (tierPresent && repackWal <= 0)) {
			throw new Error(
				`WAL counters did not record required work: ${JSON.stringify({ deleteWal, gcWal, mode, pushWal, repackWal })}`,
			)
		}

		return {
			deleteMs,
			deleteWal,
			encBytes: census.dataBytes,
			encRows: census.rows,
			gcWal,
			idleWal: Number(w2 - w1),
			mode,
			n,
			pushMs,
			pushWal,
			rawBytes,
			repackMs,
			repackWal,
		}
	} finally {
		await iso.drop()
	}
}

async function main(): Promise<void> {
	if (TRIALS < 1 || COMMITS < 2) {
		throw new Error("trials must be positive and commits must be at least 2")
	}
	const iso = await createIsolatedSchema(PG_URL)
	const [cfg] = await iso.sql<{ fpw: string; fsync: string; wc: string; wl: string }[]>`
		select
			(select setting from pg_settings where name = 'full_page_writes') as fpw,
			(select setting from pg_settings where name = 'fsync') as fsync,
			(select setting from pg_settings where name = 'wal_compression') as wc,
			(select setting from pg_settings where name = 'wal_level') as wl`
	await iso.drop()
	if (!cfg) throw new Error("Postgres WAL configuration query returned no row")
	console.log("# WAL cost of the derived pack-encoding tier\n")
	console.log(
		`instance: wal_level=${cfg.wl} full_page_writes=${cfg.fpw} fsync=${cfg.fsync} wal_compression=${cfg.wc}`,
	)
	console.log(
		"NOISY: pg_current_wal_lsn() is instance-wide and this Postgres is shared. Medians over trials; the idle column is the ambient rate.\n",
	)

	const dir = await initRepo("wal")
	await fastImport(
		dir,
		runCommits({
			blobChars: BLOB_CHARS,
			branch: "refs/heads/main",
			count: COMMITS,
			markStart: 0,
			salt: "wal",
		}).stream,
	)
	const tip = requireGitOid(
		await revParse(dir, "refs/heads/main"),
		"WAL fixture main tip",
	)

	const all: Trial[] = []
	const rootCommit = requireGitOid(
		(await spawnGit(["rev-list", "--max-parents=0", tip], { cwd: dir })).stdout.trim(),
		"WAL fixture root commit",
	)
	// Interleaved, not blocked: this box is shared and drifts.
	for (let i = 1; i <= TRIALS; i++) {
		all.push(await trial(i, dir, tip, rootCommit, "tier-present"))
		all.push(await trial(i, dir, tip, rootCommit, "tier-absent"))
	}
	const trials = all.filter((t) => t.mode === "tier-present")
	const noTier = all.filter((t) => t.mode === "tier-absent")

	const t0 = requiredAt(trials, 0, "first WAL trial")
	console.log(
		`fixture: ${COMMITS} append-only commits · ${trials.length} trials · raw object bytes ${mb(t0.rawBytes)} MB · encoding rows ${t0.encRows} holding ${mb(t0.encBytes)} MB deflated\n`,
	)
	console.log(
		table(
			[
				"trial",
				"push WAL MB",
				"idle WAL MB",
				"repack WAL MB",
				"gc WAL MB",
				"repack/push",
				"push ms",
				"repack ms",
			],
			trials.map((t) => [
				t.n,
				mb(t.pushWal),
				mb(t.idleWal),
				mb(t.repackWal),
				mb(t.gcWal),
				(t.repackWal / t.pushWal).toFixed(2),
				t.pushMs,
				t.repackMs,
			]),
		),
	)

	console.log("\n## repo deletion — encoding-row contribution to the FK cascade\n")
	console.log(
		table(
			["arm", "delete WAL MB (median)", "delete ms (median)"],
			[
				[
					"tier PRESENT",
					mb(median(requireSamples(trials.map((t) => t.deleteWal)))),
					median(requireSamples(trials.map((t) => t.deleteMs))).toFixed(0),
				],
				[
					"tier ABSENT (control)",
					mb(median(requireSamples(noTier.map((t) => t.deleteWal)))),
					median(requireSamples(noTier.map((t) => t.deleteMs))).toFixed(0),
				],
			],
		),
	)
	const delWith = median(requireSamples(trials.map((t) => t.deleteMs)))
	const delWithout = median(requireSamples(noTier.map((t) => t.deleteMs)))
	if (delWith <= 0 || delWithout <= 0) {
		throw new Error(`repo deletion timers must be positive: ${delWith}/${delWithout}`)
	}
	console.log(
		`\nthe tier adds ${(delWith - delWithout).toFixed(0)} ms (×${(delWith / delWithout).toFixed(2)}) to a repo deletion — ONE statement, ONE transaction, holding its locks for that whole time.`,
	)

	const push = median(requireSamples(trials.map((t) => t.pushWal)))
	const repack = median(requireSamples(trials.map((t) => t.repackWal)))
	const idle = median(requireSamples(trials.map((t) => t.idleWal)))
	const gc = median(requireSamples(trials.map((t) => t.gcWal)))
	const ratio = repack / push

	console.log(
		`\nmedians: push ${mb(push)} MB · repack ${mb(repack)} MB · gc ${mb(gc)} MB · ambient idle ${mb(idle)} MB`,
	)
	console.log(
		`repack WAL / push WAL = ${ratio.toFixed(2)}×  (a full push+repack cycle writes ${((push + repack) / push).toFixed(2)}× the WAL a push alone did)`,
	)
	console.log(
		`WAL amplification vs the bytes actually stored: push ${(push / t0.rawBytes).toFixed(2)}× raw · repack ${(repack / t0.encBytes).toFixed(2)}× deflated-encoding`,
	)
	console.log(
		`\nNOTE: full_page_writes=${cfg.fpw} here. With FPW on (any production instance) both numbers rise; this lower-bound fixture does not quantify that production difference.`,
	)

	cleanupTmp()
	const bad = ratio > 1.5
	console.log(
		`\n${bad ? "FAIL" : "ok  "}  BOUND: repack WAL ≤ 1.5× push WAL for the same content — measured ${ratio.toFixed(2)}×`,
	)
	if (bad) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

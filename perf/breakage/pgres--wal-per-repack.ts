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
 *             is the FK cascade. Migration 0008 hangs a FOURTH hash-partitioned
 *             child off that cascade, so one statement, one transaction, now also
 *             deletes every encoding row. Trials run with the tier BOTH present and
 *             absent, so the cascade's added cost is a difference, not a guess.
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
 *   npx tsx perf/breakage/pgres--wal-per-repack.ts --trials=5 --commits=250
 */
import { createGitDeps } from "@/index"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	cleanupTmp,
	encodingCensus,
	fastImport,
	initRepo,
	mb,
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
	walLsn,
} from "./_pgres-util"

const TRIALS = numFlag("trials", 5)
const COMMITS = numFlag("commits", 250)
const BLOB_CHARS = 1200
const REPO = "wal"

type Trial = {
	n: number
	tier: boolean
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
	tip: string,
	rootCommit: string,
	tier: boolean,
): Promise<Trial> {
	const iso = await createIsolatedSchema(PG_URL)
	try {
		const pg = iso.sql
		const objects = await objectsBetween(dir, tip, [])
		const rawBytes = objects.reduce((s, o) => s + o.content.length, 0)

		// PUSH
		const w0 = await walLsn(pg)
		const t0 = Date.now()
		await seedObjects(pg, REPO, objects)
		await setMain(pg, REPO, tip)
		const pushMs = Date.now() - t0
		const w1 = await walLsn(pg)

		// IDLE control window of comparable duration — the ambient sibling-agent rate.
		await sleep(Math.min(2000, Math.max(300, pushMs)))
		const w2 = await walLsn(pg)

		// REPACK (skipped in the tier-absent arm)
		const t1 = Date.now()
		if (tier) await createRepack(pg).repack(REPO)
		const repackMs = Date.now() - t1
		const w3 = await walLsn(pg)

		const census = await encodingCensus(pg)

		// GC after a rewind to the ROOT commit: reclaims almost everything, in both
		// tiers, so the delete-side WAL of the derived tier is visible too.
		await setMain(pg, REPO, rootCommit)
		const w4 = await walLsn(pg)
		await createGc(pg).gc(REPO, { graceSeconds: 0, maintain: false })
		const w5 = await walLsn(pg)

		// DELETE the repo: one `DELETE FROM repos`, everything else is the cascade.
		// Re-seed first so the cascade has a full repo to tear down, not a GC'd husk.
		await seedObjects(pg, REPO, objects)
		await setMain(pg, REPO, tip)
		if (tier) await createRepack(pg).repack(REPO)
		const w6 = await walLsn(pg)
		const t2 = Date.now()
		await createGitDeps(pg).admin.deleteRepo(REPO)
		const deleteMs = Date.now() - t2
		const w7 = await walLsn(pg)

		return {
			deleteMs,
			deleteWal: Number(w7 - w6),
			encBytes: census.dataBytes,
			encRows: census.rows,
			gcWal: Number(w5 - w4),
			idleWal: Number(w2 - w1),
			n,
			pushMs,
			pushWal: Number(w1 - w0),
			rawBytes,
			repackMs,
			repackWal: Number(w3 - w2),
			tier,
		}
	} finally {
		await iso.drop()
	}
}

async function main(): Promise<void> {
	const iso = await createIsolatedSchema(PG_URL)
	const [cfg] = await iso.sql<{ fpw: string; fsync: string; wc: string; wl: string }[]>`
		select
			(select setting from pg_settings where name = 'full_page_writes') as fpw,
			(select setting from pg_settings where name = 'fsync') as fsync,
			(select setting from pg_settings where name = 'wal_compression') as wc,
			(select setting from pg_settings where name = 'wal_level') as wl`
	await iso.drop()
	console.log("# WAL cost of the derived pack-encoding tier\n")
	console.log(
		`instance: wal_level=${cfg?.wl} full_page_writes=${cfg?.fpw} fsync=${cfg?.fsync} wal_compression=${cfg?.wc}`,
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
	const tip = await revParse(dir, "refs/heads/main")

	const all: Trial[] = []
	const rootCommit = (
		await spawnGit(["rev-list", "--max-parents=0", tip], { cwd: dir })
	).stdout.trim()
	// Interleaved, not blocked: this box is shared and drifts.
	for (let i = 1; i <= TRIALS; i++) {
		all.push(await trial(i, dir, tip, rootCommit, true))
		all.push(await trial(i, dir, tip, rootCommit, false))
	}
	const trials = all.filter((t) => t.tier)
	const noTier = all.filter((t) => !t.tier)

	const t0 = trials[0] as Trial
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

	console.log("\n## repo deletion — the FK cascade now carries a fourth child table\n")
	console.log(
		table(
			["arm", "delete WAL MB (median)", "delete ms (median)"],
			[
				[
					"tier PRESENT",
					mb(median(trials.map((t) => t.deleteWal))),
					median(trials.map((t) => t.deleteMs)).toFixed(0),
				],
				[
					"tier ABSENT (control)",
					mb(median(noTier.map((t) => t.deleteWal))),
					median(noTier.map((t) => t.deleteMs)).toFixed(0),
				],
			],
		),
	)
	const delWith = median(trials.map((t) => t.deleteMs))
	const delWithout = median(noTier.map((t) => t.deleteMs))
	console.log(
		`\nthe tier adds ${(delWith - delWithout).toFixed(0)} ms (×${(delWith / Math.max(1, delWithout)).toFixed(2)}) to a repo deletion — ONE statement, ONE transaction, holding its locks for that whole time.`,
	)

	const push = median(trials.map((t) => t.pushWal))
	const repack = median(trials.map((t) => t.repackWal))
	const idle = median(trials.map((t) => t.idleWal))
	const gc = median(trials.map((t) => t.gcWal))
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
		`\nNOTE: full_page_writes=${cfg?.fpw} here. With FPW on (any production instance) both numbers rise, and the repack side rises MORE — it dirties fresh pages in a table with fillfactor=100.`,
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

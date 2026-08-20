/**
 * Compare pggit's and canonical git's exact protocol-v2 PACK bytes for a cold fetch
 * and for warm incremental fetches through real repository history.
 *
 * D8' permits a warm fetch to encode REF_DELTA entries against objects the client
 * proved it has. Such a response is thin: `index-pack --fix-thin` appends those
 * external bases before writing a client pack, so client-side `.pack` growth is not
 * wire evidence. This harness captures the raw HTTP/upload-pack responses instead.
 * Canonical index-pack then proves that both raw packs contain the same transmitted
 * OIDs, and real tracking clients prove the resulting refs and reachable closures.
 *
 *   npx tsx perf/breakage/realrepo--incremental-fetch-size.ts --repo=/path/to/checkout --slug=<n>
 *
 * Exit 0 = exact prerequisites hold and warm pggit bytes are within `--max-ratio`
 * (default 3.0) of canonical git. Exit 1 = the measured ratio misses that bar.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import {
	branchAndTagRefsOf,
	gitReachableOids,
	parseRevListObjectOids,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"
import {
	canonicalV2Pack,
	createScratch,
	DEFAULT_PG_URL,
	flag,
	kb,
	positiveIntegerFlag,
	positiveNumberFlag,
	postPggitV2Pack,
	prepareMirror,
	rawPackObjectOids,
	repackExactly,
} from "./_realrepo-util"

const SLUG = flag("slug", "repo")
const STEP = positiveIntegerFlag("step", 50)
const MAX_RATIO = positiveNumberFlag("max-ratio", 3)
const PG_URL = flag("pg", DEFAULT_PG_URL)

if (SLUG.length === 0) throw new Error("--slug must not be empty")

const scratch = createScratch(`warm-${SLUG}`)

function requireEqual<T>(label: string, left: readonly T[], right: readonly T[]): void {
	if (JSON.stringify(left) !== JSON.stringify(right)) {
		throw new Error(
			`${label} differs:\npggit ${JSON.stringify(left)}\ngit   ${JSON.stringify(right)}`,
		)
	}
}

async function requireTrackingClientsEqual(pgDir: string, gitDir: string): Promise<void> {
	await Promise.all([
		spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: pgDir }),
		spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: gitDir }),
	])
	requireEqual(
		"tracking reachable OIDs",
		await gitReachableOids(pgDir),
		await gitReachableOids(gitDir),
	)
	requireEqual(
		"tracking refs",
		await branchAndTagRefsOf(pgDir),
		await branchAndTagRefsOf(gitDir),
	)
}

async function main(): Promise<void> {
	const mirror = await prepareMirror(scratch)
	console.log(`# incremental (warm) raw fetch size — ${SLUG}\n  mirror ${mirror}`)
	const chain = parseRevListObjectOids(
		(
			await spawnGit(["rev-list", "--first-parent", "--reverse", "HEAD"], {
				cwd: mirror,
			})
		).stdout,
	)
	if (chain.length < 2) throw new Error("fixture needs at least two first-parent commits")
	const checkpoints: string[] = []
	for (let i = STEP - 1; i < chain.length; i += STEP) checkpoints.push(chain[i] as string)
	if (checkpoints[checkpoints.length - 1] !== chain[chain.length - 1]) {
		checkpoints.push(chain[chain.length - 1] as string)
	}
	if (checkpoints.length < 2) {
		throw new Error(
			`--step=${STEP} selected only ${checkpoints.length} checkpoint; warm measurement requires at least two`,
		)
	}
	console.log(`  ${chain.length} first-parent commits -> ${checkpoints.length} rounds`)

	const repoId = `warm/${SLUG}`
	const db = await createIsolatedSchema(PG_URL)
	const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	const url = `http://127.0.0.1:${server.port}/${repoId}`
	const oracle = join(scratch.mk("oracle"), "o.git")
	mkdirSync(oracle, { recursive: true })
	await spawnGit(["init", "-q", "--bare", oracle])
	const pgTrack = join(scratch.mk("pgtrack"), "t.git")
	const gitTrack = join(scratch.mk("gittrack"), "t.git")
	const rows: { round: number; rev: string; pggit: number; git: number }[] = []
	let appendedPggitBases = 0
	let storedDeltas = 0

	try {
		for (let round = 0; round < checkpoints.length; round++) {
			const rev = checkpoints[round] as string
			await spawnGit(["push", url, `${rev}:refs/heads/main`], { cwd: mirror })
			await spawnGit(["push", `file://${oracle}`, `${rev}:refs/heads/main`], {
				cwd: mirror,
			})
			const repack = await repackExactly(db.sql, repoId)
			if (repack.wholes + repack.deltas === 0) {
				throw new Error(`round ${round}: repack encoded no objects`)
			}
			storedDeltas += repack.deltas
			await spawnGit(["gc", "--prune=now", "-q"], { cwd: oracle })

			if (round === 0) {
				await spawnGit([
					"-c",
					"protocol.version=2",
					"clone",
					"--bare",
					"-q",
					url,
					pgTrack,
				])
				await spawnGit([
					"-c",
					"protocol.version=2",
					"clone",
					"--bare",
					"-q",
					`file://${oracle}`,
					gitTrack,
				])
			} else {
				await spawnGit(
					[
						"-c",
						"protocol.version=2",
						"fetch",
						"-q",
						"origin",
						"+refs/heads/main:refs/heads/main",
					],
					{ cwd: pgTrack },
				)
				await spawnGit(
					[
						"-c",
						"protocol.version=2",
						"fetch",
						"-q",
						"origin",
						"+refs/heads/main:refs/heads/main",
					],
					{ cwd: gitTrack },
				)
			}
			await requireTrackingClientsEqual(pgTrack, gitTrack)

			const previous = round === 0 ? undefined : checkpoints[round - 1]
			const request = fetchRequest({
				done: true,
				haves: previous ? [previous] : [],
				thinPack: previous !== undefined,
				wants: [rev],
			})
			const [pggitPack, gitPack] = await Promise.all([
				postPggitV2Pack(url, request),
				canonicalV2Pack(oracle, request),
			])
			const [pggitObjects, gitObjects] = await Promise.all([
				rawPackObjectOids(pgTrack, pggitPack, previous !== undefined),
				rawPackObjectOids(gitTrack, gitPack, previous !== undefined),
			])
			requireEqual(`round ${round} transmitted OIDs`, pggitObjects.oids, gitObjects.oids)
			appendedPggitBases += pggitObjects.appendedBases
			rows.push({ git: gitPack.length, pggit: pggitPack.length, rev, round })
		}
		if (storedDeltas === 0) throw new Error("fixture produced no stored delta encodings")
		if (appendedPggitBases === 0) {
			throw new Error("warm pggit responses used no external client-have delta base")
		}
	} finally {
		await server.close()
		await db.drop()
		scratch.cleanup()
	}

	const warm = rows.slice(1)
	const pggitWarmBytes = warm.reduce((total, row) => total + row.pggit, 0)
	const gitWarmBytes = warm.reduce((total, row) => total + row.git, 0)
	if (pggitWarmBytes === 0 || gitWarmBytes === 0) {
		throw new Error("warm raw pack totals must both be positive")
	}
	console.log("\n### per-round raw PACK bytes (round 0 is cold)\n")
	console.log("| round | commit | pggit | git | ratio |")
	console.log("|---|---|---|---|---|")
	for (const row of rows) {
		console.log(
			`| ${row.round} | ${row.rev.slice(0, 8)} | ${kb(row.pggit)} | ${kb(row.git)} | ${(row.pggit / row.git).toFixed(2)}x |`,
		)
	}
	const ratio = pggitWarmBytes / gitWarmBytes
	const cold = rows[0]
	if (cold === undefined) throw new Error("cold round was not measured")
	console.log(
		`\n**warm total: pggit ${kb(pggitWarmBytes)} vs git ${kb(gitWarmBytes)} = ${ratio.toFixed(2)}x; cold ${(
			cold.pggit / cold.git
		).toFixed(2)}x; ${appendedPggitBases} external pggit bases proven**`,
	)
	if (ratio > MAX_RATIO) {
		console.log(
			`\nREPRODUCED: warm raw fetches cost ${ratio.toFixed(2)}x canonical git on ${SLUG}.`,
		)
		process.exitCode = 1
	} else {
		console.log(`\nOK: ${ratio.toFixed(2)}x is within the ${MAX_RATIO}x bar.`)
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})

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
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import type { Oid } from "@/oid"
import { serveOnPort } from "@/server"
import {
	assertGitReachableObjects,
	branchAndTagRefsOf,
	gitReachableOids,
	parseRevListObjectOids,
	requiredAt,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"
import {
	nonemptyStringArg,
	parseArgs,
	pgUrlArg,
	positiveIntegerArg,
	positiveNumberArg,
} from "../args"
import { table } from "../table"
import {
	assertCanonicalRealRepoStore,
	canonicalV2Pack,
	createScratch,
	kb,
	mirrorSourceFromArgs,
	postPggitV2Pack,
	prepareMirror,
	rawPackObjectOids,
	repackExactly,
} from "./_realrepo-util"

const args = parseArgs(
	z
		.object({
			"max-ratio": positiveNumberArg.default(3),
			mirror: nonemptyStringArg.optional(),
			pg: pgUrlArg,
			repo: nonemptyStringArg.optional(),
			slug: nonemptyStringArg.default("repo"),
			step: positiveIntegerArg.default(50),
		})
		.strict()
		.transform(({ mirror, repo, ...values }) => ({
			...values,
			source: mirrorSourceFromArgs({ mirror, repo }),
		})),
)
const SLUG = args.slug
const STEP = args.step
const MAX_RATIO = args["max-ratio"]
const PG_URL = args.pg

const scratch = createScratch(`warm-${SLUG}`)

function requireEqual<T>(label: string, left: readonly T[], right: readonly T[]): void {
	if (JSON.stringify(left) !== JSON.stringify(right)) {
		throw new Error(
			`${label} differs:\npggit ${JSON.stringify(left)}\ngit   ${JSON.stringify(right)}`,
		)
	}
}

async function requireTrackingClientsEqual(pgDir: string, gitDir: string): Promise<void> {
	const expectedOids = await gitReachableOids(gitDir)
	await Promise.all([
		assertGitReachableObjects(pgDir, expectedOids, "pggit tracking client"),
		assertGitReachableObjects(gitDir, expectedOids, "canonical tracking client"),
	])
	requireEqual(
		"tracking refs",
		await branchAndTagRefsOf(pgDir),
		await branchAndTagRefsOf(gitDir),
	)
}

async function main(): Promise<void> {
	const mirror = await prepareMirror(scratch, args.source)
	console.log(`# incremental (warm) raw fetch size — ${SLUG}\n  mirror ${mirror}`)
	const chain = parseRevListObjectOids(
		(
			await spawnGit(["rev-list", "--first-parent", "--reverse", "HEAD"], {
				cwd: mirror,
			})
		).stdout,
	)
	if (chain.length < 2) throw new Error("fixture needs at least two first-parent commits")
	const checkpoints: Oid[] = []
	for (let i = STEP - 1; i < chain.length; i += STEP) {
		checkpoints.push(requiredAt(chain, i, "incremental checkpoint"))
	}
	const head = requiredAt(chain, chain.length - 1, "incremental head commit")
	if (checkpoints[checkpoints.length - 1] !== head) {
		checkpoints.push(head)
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
	await spawnGit(["init", "-q", "-b", "main", "--bare", oracle])
	const pgTrack = join(scratch.mk("pgtrack"), "t.git")
	const gitTrack = join(scratch.mk("gittrack"), "t.git")
	const rows: { round: number; rev: Oid; pggit: number; git: number }[] = []
	let appendedPggitBases = 0
	let storedDeltas = 0

	try {
		for (let round = 0; round < checkpoints.length; round++) {
			const rev = requiredAt(checkpoints, round, "incremental round checkpoint")
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
			await assertCanonicalRealRepoStore(db.sql, repoId, oracle, { kind: "repacked" })

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

			type FetchState = { kind: "cold" } | { kind: "warm"; previous: Oid }
			const fetchState: FetchState =
				round === 0
					? { kind: "cold" }
					: {
							kind: "warm",
							previous: requiredAt(checkpoints, round - 1, "previous warm checkpoint"),
						}
			const request = fetchRequest({
				done: true,
				haves: fetchState.kind === "warm" ? [fetchState.previous] : [],
				thinPack: fetchState.kind === "warm",
				wants: [rev],
			})
			const [pggitPack, gitPack] = await Promise.all([
				postPggitV2Pack(url, request),
				canonicalV2Pack(oracle, request),
			])
			const [pggitObjects, gitObjects] = await Promise.all([
				rawPackObjectOids(
					pgTrack,
					pggitPack,
					fetchState.kind === "warm" ? "thin" : "complete",
				),
				rawPackObjectOids(
					gitTrack,
					gitPack,
					fetchState.kind === "warm" ? "thin" : "complete",
				),
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
	console.log(
		table(
			["round", "commit", "pggit", "git", "ratio"],
			rows.map((row) => [
				row.round,
				row.rev.slice(0, 8),
				kb(row.pggit),
				kb(row.git),
				`${(row.pggit / row.git).toFixed(2)}x`,
			]),
		),
	)
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

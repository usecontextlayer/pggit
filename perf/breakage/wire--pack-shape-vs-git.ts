/**
 * Compare raw protocol-v2 PACK size and client-indexed pack shape across three
 * remotes holding the identical object set: pggit with stored encodings, pggit
 * without stored encodings, and canonical git.
 *
 * Raw response bytes are the size evidence. Client packs are shape evidence only:
 * a warm thin pack is rewritten by `index-pack --fix-thin`, which appends external
 * bases before storage. Canonical index-pack validates each raw pack and proves that
 * all three servers transmitted the same object OIDs before any ratio is reported.
 *
 *   D2/D9 — star topology, depth ≤ 1: no entry pggit serves may have chain depth > 1.
 *   D8'   — a warm fetch may ship a thin REF_DELTA against a proven client `have`.
 *
 * Failure conditions (exit non-zero):
 *   - a client-indexed delta chain deeper than 1 from the encoded pggit remote
 *   - the encoded pggit remote serving more raw bytes than its unencoded arm
 *   - any fsck failure or object-set divergence between the three clones
 * The pggit-vs-git ratios are REPORTED, not asserted — the gap is a known design
 * consequence; this harness exists to put honest numbers on it.
 *
 *   npx tsx perf/breakage/wire--pack-shape-vs-git.ts
 *   npx tsx perf/breakage/wire--pack-shape-vs-git.ts --runs=600 --new=120
 */
import { join } from "node:path"
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import type { Oid } from "@/oid"
import { serveOnPort } from "@/server"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { mirrorStateOf, revParse, verifyPackObjectsInRepo } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"
import { parseArgs, pgUrlArg, positiveIntegerArg } from "../args"
import { table } from "../table"
import {
	assertCanonicalRealRepoStore,
	canonicalV2Pack,
	encodingCoverage,
	postPggitV2Pack,
	rawPackObjectOids,
	repackExactly,
} from "./_realrepo-util"

const REPO = "workspace/probe/shape"
/** Two pggit repos in one schema: only one receives stored encodings. */
const RAW_REPO = `${REPO}-raw`
const args = parseArgs(
	z
		.object({
			new: positiveIntegerArg.default(60),
			pg: pgUrlArg,
			runs: positiveIntegerArg.default(300),
		})
		.strict(),
)
const RUNS_1 = args.runs
const RUNS_2 = args.new
const PG_URL = args.pg

const scratch = createScratchArena()
const mk = scratch.make
const failures: string[] = []
const fail = (msg: string): void => {
	failures.push(msg)
	console.error(`FAIL: ${msg}`)
}
/**
 * Parse `verify-pack -v`: entry count, delta count, max chain depth, and how many
 * deltas sit at a LOWER pack offset than their base (which only resolves because
 * REF_DELTA lookup is order-independent — worth knowing the case is exercised).
 */
async function packShape(dir: string): Promise<{
	entries: number
	deltas: number
	maxDepth: number
	deltaBeforeBase: number
}> {
	let entries = 0
	let deltas = 0
	let maxDepth = 0
	let deltaBeforeBase = 0
	for (const pack of await verifyPackObjectsInRepo(dir)) {
		const offsetOf = new Map<string, number>()
		const rows: { oid: Oid; offset: number; base?: Oid }[] = []
		for (const object of pack.objects) {
			entries++
			offsetOf.set(object.oid, object.offset)
			if (object.kind === "delta") {
				deltas++
				maxDepth = Math.max(maxDepth, object.depth)
				rows.push({ base: object.baseOid, offset: object.offset, oid: object.oid })
			}
		}
		for (const r of rows) {
			const b = r.base ? offsetOf.get(r.base) : undefined
			if (b !== undefined && r.offset < b) deltaBeforeBase++
		}
	}
	return { deltaBeforeBase, deltas, entries, maxDepth }
}

function requireSameOids(label: string, observations: readonly Oid[][]): void {
	const expected = observations[observations.length - 1]
	if (expected === undefined || expected.length === 0) {
		throw new Error(`${label}: canonical git transmitted no objects`)
	}
	for (const observed of observations.slice(0, -1)) {
		if (JSON.stringify(observed) !== JSON.stringify(expected)) {
			throw new Error(`${label}: transmitted object OIDs differ from canonical git`)
		}
	}
}

function requireCloneDir(clones: ReadonlyMap<string, string>, label: string): string {
	const dir = clones.get(label)
	if (dir === undefined) throw new Error(`missing tracking clone for ${label}`)
	return dir
}

async function requireCloneParity(
	stage: string,
	clones: ReadonlyMap<string, string>,
): Promise<void> {
	const labels = ["pggit-repacked", "pggit-raw", "git"] as const
	const states = await Promise.all(
		labels.map((label) => mirrorStateOf(requireCloneDir(clones, label))),
	)
	const expected = states[2]
	if (
		expected === undefined ||
		expected.objects.length === 0 ||
		expected.refs.length < 2
	) {
		throw new Error(`${stage}: canonical clone state was empty`)
	}
	for (const [index, state] of states.entries()) {
		if (state.fsck !== "") {
			throw new Error(
				`${stage}: ${labels[index] ?? "unknown clone"} failed fsck: ${state.fsck}`,
			)
		}
		if (
			state.digest !== expected.digest ||
			JSON.stringify(state.objects) !== JSON.stringify(expected.objects) ||
			JSON.stringify(state.refs) !== JSON.stringify(expected.refs)
		) {
			throw new Error(`${stage}: client repository state differs from canonical git`)
		}
	}
}

async function main(): Promise<void> {
	console.log(`# wire--pack-shape-vs-git — ${RUNS_1} runs, +${RUNS_2} on the fetch\n`)
	const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS_1 })
	scratch.own(src)
	const bare = join(mk("bare"), "oracle.git")
	await spawnGit(["clone", "--bare", "-q", src, bare])
	await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })

	const db = await createIsolatedSchema(PG_URL)
	const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	const remotes = [
		["pggit-repacked", `http://127.0.0.1:${server.port}/${REPO}`],
		["pggit-raw", `http://127.0.0.1:${server.port}/${RAW_REPO}`],
		["git", `file://${bare}`],
	] as const

	try {
		for (const repo of [REPO, RAW_REPO]) {
			await spawnGit(
				[
					"push",
					"-q",
					`http://127.0.0.1:${server.port}/${repo}`,
					"refs/heads/*:refs/heads/*",
				],
				{ cwd: src },
			)
		}
		const r = await repackExactly(db.sql, REPO)
		if (r.wholes + r.deltas === 0 || r.deltas === 0) {
			throw new Error(
				`initial repack did not exercise stored deltas: ${JSON.stringify(r)}`,
			)
		}
		const rawCoverage = await encodingCoverage(db.sql, RAW_REPO)
		if (rawCoverage.encoded !== 0) {
			throw new Error(
				`unencoded control has ${rawCoverage.encoded} stored encodings before the cold fetch`,
			)
		}
		await Promise.all([
			assertCanonicalRealRepoStore(db.sql, REPO, src, { kind: "repacked" }),
			assertCanonicalRealRepoStore(db.sql, RAW_REPO, src, { kind: "unencoded" }),
		])
		console.log(`repack: ${r.wholes} wholes + ${r.deltas} deltas\n`)

		// ---- A. cold fetch -------------------------------------------------------
		console.log("## A. cold fetch: raw size and client-indexed shape\n")
		const clones = new Map<string, string>()
		const coldRows: (string | number)[][] = []
		for (const [label, url] of remotes) {
			const dest = join(mk(`c-${label}`), "c")
			await spawnGit([
				"-c",
				"protocol.version=2",
				"-c",
				"transfer.fsckobjects=true",
				"clone",
				"-q",
				"--no-local",
				url,
				dest,
			])
			clones.set(label, dest)
			const s = await packShape(dest)
			coldRows.push([label, s.entries, s.deltas, s.maxDepth, s.deltaBeforeBase])
			if (label === "pggit-repacked" && s.maxDepth > 1) {
				fail(
					`pggit served a delta chain of depth ${s.maxDepth} — star topology claims ≤ 1`,
				)
			}
		}
		console.log(
			table(
				["remote", "entries", "deltas", "max chain depth", "deltas ahead of base"],
				coldRows,
			),
		)
		await requireCloneParity("cold clone prerequisite", clones)
		const initialTip = await revParse(src, "HEAD")
		const coldRequest = fetchRequest({ done: true, wants: [initialTip] })
		const [coldPggit, coldUnencoded, coldGit] = await Promise.all([
			postPggitV2Pack(remotes[0][1], coldRequest),
			postPggitV2Pack(remotes[1][1], coldRequest),
			canonicalV2Pack(bare, coldRequest),
		])
		const coldObjects = await Promise.all([
			rawPackObjectOids(requireCloneDir(clones, "pggit-repacked"), coldPggit, "complete"),
			rawPackObjectOids(requireCloneDir(clones, "pggit-raw"), coldUnencoded, "complete"),
			rawPackObjectOids(requireCloneDir(clones, "git"), coldGit, "complete"),
		])
		requireSameOids(
			"cold fetch",
			coldObjects.map((objects) => objects.oids),
		)
		const [cP, cR, cG] = [coldPggit.length, coldUnencoded.length, coldGit.length]
		console.log(
			`\ncold raw PACK: encoded/unencoded = **${(cP / cR).toFixed(2)}×**, ` +
				`repacked/git = ${(cP / cG).toFixed(2)}×`,
		)
		if (cP > cR) fail(`encoded cold pack (${cP}B) is larger than unencoded pack (${cR}B)`)

		// ---- B. the incremental fetch -------------------------------------------
		const grown = await createAppendOnlyRepo({ docs: 6, runs: RUNS_1 + RUNS_2 })
		scratch.own(grown)
		for (const repo of [REPO, RAW_REPO]) {
			await spawnGit(
				[
					"push",
					"-q",
					`http://127.0.0.1:${server.port}/${repo}`,
					"refs/heads/*:refs/heads/*",
				],
				{ cwd: grown },
			)
		}
		await spawnGit(["push", "-q", `file://${bare}`, "refs/heads/*:refs/heads/*"], {
			cwd: grown,
		})
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })
		const r2 = await repackExactly(db.sql, REPO)
		if (r2.wholes + r2.deltas === 0 || r2.deltas === 0) {
			throw new Error(
				`incremental repack did not exercise stored deltas: ${JSON.stringify(r2)}`,
			)
		}
		const rawCoverageAfterPush = await encodingCoverage(db.sql, RAW_REPO)
		if (rawCoverageAfterPush.encoded !== 0) {
			throw new Error(
				`unencoded control has ${rawCoverageAfterPush.encoded} stored encodings before the warm fetch`,
			)
		}
		await Promise.all([
			assertCanonicalRealRepoStore(db.sql, REPO, grown, { kind: "repacked" }),
			assertCanonicalRealRepoStore(db.sql, RAW_REPO, grown, { kind: "unencoded" }),
		])
		console.log(`\nrepack #2: ${r2.wholes} wholes + ${r2.deltas} deltas\n`)

		console.log(`## B. +${RUNS_2}-commit warm fetch: client-indexed shape\n`)
		const warmRows: (string | number)[][] = []
		for (const [label] of remotes) {
			const dest = requireCloneDir(clones, label)
			await spawnGit(["-c", "protocol.version=2", "fetch", "-q", "origin"], { cwd: dest })
			const s = await packShape(dest)
			warmRows.push([label, s.maxDepth])
			if (label === "pggit-repacked" && s.maxDepth > 1) {
				fail(`pggit served a delta chain of depth ${s.maxDepth} on the incremental fetch`)
			}
		}
		console.log(table(["remote", "max chain depth after"], warmRows))
		await requireCloneParity("warm-fetch prerequisite", clones)
		const grownTip = await revParse(grown, "HEAD")
		if (grownTip === initialTip) {
			throw new Error("grown fixture did not produce a distinct tip OID")
		}
		const warmRequest = fetchRequest({
			done: true,
			haves: [initialTip],
			thinPack: true,
			wants: [grownTip],
		})
		const [warmPggit, warmUnencoded, warmGit] = await Promise.all([
			postPggitV2Pack(remotes[0][1], warmRequest),
			postPggitV2Pack(remotes[1][1], warmRequest),
			canonicalV2Pack(bare, warmRequest),
		])
		const warmObjects = await Promise.all([
			rawPackObjectOids(requireCloneDir(clones, "pggit-repacked"), warmPggit, "thin"),
			rawPackObjectOids(requireCloneDir(clones, "pggit-raw"), warmUnencoded, "thin"),
			rawPackObjectOids(requireCloneDir(clones, "git"), warmGit, "thin"),
		])
		requireSameOids(
			"warm fetch",
			warmObjects.map((objects) => objects.oids),
		)
		const encodedWarmObjects = warmObjects[0]
		if (encodedWarmObjects === undefined || encodedWarmObjects.appendedBases === 0) {
			throw new Error("encoded pggit warm pack did not use an external client-have base")
		}
		const [fP, fR, fG] = [warmPggit.length, warmUnencoded.length, warmGit.length]
		console.log(
			`\nwarm raw PACK: encoded/unencoded = **${(fP / fR).toFixed(2)}×**, ` +
				`encoded/git = ${(fP / fG).toFixed(2)}× (reported, not asserted)`,
		)
		if (fP > fR) {
			fail(`encoded warm pack (${fP}B) is larger than unencoded pack (${fR}B)`)
		}
	} finally {
		await server.close()
		await db.drop()
		scratch.cleanup()
	}

	if (failures.length > 0) {
		console.error(`\n${failures.length} FAILURE(S)`)
		process.exitCode = 1
	} else {
		console.log("\nOK — served pack shape within the design's claims")
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

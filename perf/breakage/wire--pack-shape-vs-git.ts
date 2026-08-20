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
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allRefsOf,
	parseVerifyPackObjects,
	repositoryHeadOf,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"
import {
	canonicalV2Pack,
	flag,
	positiveIntegerFlag,
	postPggitV2Pack,
	rawPackObjectOids,
	repackExactly,
} from "./_realrepo-util"

const REPO = "workspace/probe/shape"
/** Two pggit repos in one schema: only one receives stored encodings. */
const RAW_REPO = `${REPO}-raw`
const RUNS_1 = positiveIntegerFlag("runs", 300)
const RUNS_2 = positiveIntegerFlag("new", 60)
const PG_URL = flag("pg", "postgres://postgres:postgres@localhost:6489/postgres")

const scratch: string[] = []
const mk = (tag: string): string => {
	const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
	scratch.push(d)
	return d
}
const failures: string[] = []
const fail = (msg: string): void => {
	failures.push(msg)
	console.error(`FAIL: ${msg}`)
}
const packDir = (dir: string): string => join(dir, ".git", "objects", "pack")

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
	const p = packDir(dir)
	let entries = 0
	let deltas = 0
	let maxDepth = 0
	let deltaBeforeBase = 0
	const indexes = readdirSync(p).filter((x) => x.endsWith(".idx"))
	if (indexes.length === 0) throw new Error(`${dir}: client has no indexed packs`)
	for (const f of indexes) {
		const out = await spawnGit(["verify-pack", "-v", join(p, f)], { cwd: dir })
		const offsetOf = new Map<string, number>()
		const rows: { oid: string; offset: number; base?: string }[] = []
		for (const object of parseVerifyPackObjects(out.stdout)) {
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

async function inventory(dir: string): Promise<string> {
	const out = await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], {
		cwd: dir,
	})
	const rows = out.stdout.trim().split("\n").filter(Boolean)
	if (rows.length === 0) throw new Error(`${dir}: object inventory was empty`)
	for (const row of rows) {
		if (!/^[0-9a-f]{40} (blob|commit|tag|tree) [0-9]+$/.test(row)) {
			throw new Error(`${dir}: malformed object inventory row ${JSON.stringify(row)}`)
		}
	}
	return rows.sort().join("\n")
}

async function refs(dir: string): Promise<string> {
	const direct = (await allRefsOf(dir)).map(({ name, oid }) => `${oid} ${name}`)
	if (direct.length === 0) throw new Error(`${dir}: ref inventory was empty`)
	const head = await repositoryHeadOf(dir)
	return [...direct, `${head.oid} HEAD -> ${head.target}`].sort().join("\n")
}

function requireSameOids(label: string, observations: readonly string[][]): void {
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
	const inventories = await Promise.all(
		labels.map((label) => inventory(requireCloneDir(clones, label))),
	)
	const refsByRemote = await Promise.all(
		labels.map((label) => refs(requireCloneDir(clones, label))),
	)
	if (inventories[0] !== inventories[2] || inventories[1] !== inventories[2]) {
		throw new Error(`${stage}: client object inventories differ from canonical git`)
	}
	if (refsByRemote[0] !== refsByRemote[2] || refsByRemote[1] !== refsByRemote[2]) {
		throw new Error(`${stage}: client refs differ from canonical git`)
	}
}

async function main(): Promise<void> {
	console.log(`# wire--pack-shape-vs-git — ${RUNS_1} runs, +${RUNS_2} on the fetch\n`)
	const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS_1 })
	scratch.push(src)
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
		console.log(`repack: ${r.wholes} wholes + ${r.deltas} deltas\n`)

		// ---- A. cold fetch -------------------------------------------------------
		console.log("## A. cold fetch: raw size and client-indexed shape\n")
		console.log("| remote | entries | deltas | max chain depth | deltas ahead of base |")
		console.log("|---|---|---|---|---|")
		const clones = new Map<string, string>()
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
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			clones.set(label, dest)
			const s = await packShape(dest)
			console.log(
				`| ${label} | ${s.entries} | ${s.deltas} | ${s.maxDepth} | ${s.deltaBeforeBase} |`,
			)
			if (label === "pggit-repacked" && s.maxDepth > 1) {
				fail(
					`pggit served a delta chain of depth ${s.maxDepth} — star topology claims ≤ 1`,
				)
			}
		}
		await requireCloneParity("cold clone prerequisite", clones)
		const initialTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		if (!/^[0-9a-f]{40}$/.test(initialTip)) throw new Error("initial tip was not an OID")
		const coldRequest = fetchRequest({ done: true, wants: [initialTip] })
		const [coldPggit, coldUnencoded, coldGit] = await Promise.all([
			postPggitV2Pack(remotes[0][1], coldRequest),
			postPggitV2Pack(remotes[1][1], coldRequest),
			canonicalV2Pack(bare, coldRequest),
		])
		const coldObjects = await Promise.all([
			rawPackObjectOids(requireCloneDir(clones, "pggit-repacked"), coldPggit, false),
			rawPackObjectOids(requireCloneDir(clones, "pggit-raw"), coldUnencoded, false),
			rawPackObjectOids(requireCloneDir(clones, "git"), coldGit, false),
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
		scratch.push(grown)
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
		console.log(`\nrepack #2: ${r2.wholes} wholes + ${r2.deltas} deltas\n`)

		console.log(`## B. +${RUNS_2}-commit warm fetch: client-indexed shape\n`)
		console.log("| remote | max chain depth after |")
		console.log("|---|---|")
		for (const [label] of remotes) {
			const dest = clones.get(label) as string
			await spawnGit(["-c", "protocol.version=2", "fetch", "-q", "origin"], { cwd: dest })
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			const s = await packShape(dest)
			console.log(`| ${label} | ${s.maxDepth} |`)
			if (label === "pggit-repacked" && s.maxDepth > 1) {
				fail(`pggit served a delta chain of depth ${s.maxDepth} on the incremental fetch`)
			}
		}
		await requireCloneParity("warm-fetch prerequisite", clones)
		const grownTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: grown })).stdout.trim()
		if (!/^[0-9a-f]{40}$/.test(grownTip) || grownTip === initialTip) {
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
			rawPackObjectOids(requireCloneDir(clones, "pggit-repacked"), warmPggit, true),
			rawPackObjectOids(requireCloneDir(clones, "pggit-raw"), warmUnencoded, true),
			rawPackObjectOids(requireCloneDir(clones, "git"), warmGit, true),
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
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
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

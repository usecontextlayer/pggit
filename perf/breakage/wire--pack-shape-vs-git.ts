/**
 * WIRE — the SHAPE and SIZE of the pack a client actually receives, across THREE
 * remotes holding the identical object set: pggit repacked, pggit NOT repacked (the
 * pre-change baseline), and a plain bare git remote.
 * (Converted from `breakage/wire--pack-shape-vs-git.ts`.)
 *
 * `git clone` stores the received pack verbatim (index-pack only builds the .idx),
 * so `git verify-pack -v` on the clone is a black-box read of exactly what the
 * server emitted: how many entries shipped as deltas, and the delta chain depth.
 * That makes design claims client-observable:
 *
 *   D2/D9 — star topology, depth ≤ 1: no entry pggit serves may have chain depth > 1.
 *   W3    — an incremental fetch cannot ship a delta whose base is a client `have`,
 *           so those objects ship WHOLE. The un-repacked arm separates "gap versus
 *           git" from "regression versus what pggit did before".
 *
 * Failure conditions (exit non-zero):
 *   - a received delta chain deeper than 1 from the repacked remote
 *   - the repacked remote serving MORE bytes than the un-repacked one (a regression)
 *   - any fsck failure or object-set divergence between the three clones
 * The pggit-vs-git ratios are REPORTED, not asserted — the gap is a known design
 * consequence (D2/W3); this harness exists to put numbers on it.
 *
 *   npx tsx perf/breakage/wire--pack-shape-vs-git.ts
 *   npx tsx perf/breakage/wire--pack-shape-vs-git.ts --runs=600 --new=120
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

function flag(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}

const REPO = "workspace/probe/shape"
/** Two pggit repos in ONE schema: only one of them is ever repacked, so the
 * un-repacked arm is the exact pre-change serve path over the same objects. */
const RAW_REPO = `${REPO}-raw`
const RUNS_1 = Number(flag("runs", "300"))
const RUNS_2 = Number(flag("new", "60"))
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
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KiB`

const packDir = (dir: string): string => join(dir, ".git", "objects", "pack")
function packBytes(dir: string): number {
	const p = packDir(dir)
	return readdirSync(p)
		.filter((f) => f.endsWith(".pack"))
		.map((f) => statSync(join(p, f)).size)
		.reduce((a, b) => a + b, 0)
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
	const p = packDir(dir)
	let entries = 0
	let deltas = 0
	let maxDepth = 0
	let deltaBeforeBase = 0
	for (const f of readdirSync(p).filter((x) => x.endsWith(".idx"))) {
		const out = await spawnGit(["verify-pack", "-v", join(p, f)], { cwd: dir })
		const offsetOf = new Map<string, number>()
		const rows: { oid: string; offset: number; base?: string }[] = []
		for (const line of out.stdout.split("\n")) {
			// `<sha1> <type> <size> <packed-size> <offset> [<depth> <base-sha1>]`
			const parts = line.trim().split(/\s+/)
			if (parts.length < 5 || !/^[0-9a-f]{40}$/.test(parts[0] as string)) continue
			entries++
			const oid = parts[0] as string
			const offset = Number(parts[4])
			offsetOf.set(oid, offset)
			if (parts.length >= 7) {
				deltas++
				maxDepth = Math.max(maxDepth, Number(parts[5]))
				rows.push({ base: parts[6] as string, offset, oid })
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
	return (
		await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], { cwd: dir })
	).stdout
		.split("\n")
		.filter(Boolean)
		.sort()
		.join("\n")
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
		const r = await createRepack(db.sql).repack(REPO)
		console.log(`repack: ${r.wholes} wholes + ${r.deltas} deltas\n`)

		// ---- A. the full clone from each remote ---------------------------------
		console.log("## A. the pack a full clone receives\n")
		console.log(
			"| remote | pack | entries | deltas | max chain depth | deltas ahead of base |",
		)
		console.log("|---|---|---|---|---|---|")
		const clones = new Map<string, string>()
		const cloneSize = new Map<string, number>()
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
			cloneSize.set(label, packBytes(dest))
			const s = await packShape(dest)
			console.log(
				`| ${label} | ${kb(packBytes(dest))} | ${s.entries} | ${s.deltas} | ` +
					`${s.maxDepth} | ${s.deltaBeforeBase} |`,
			)
			if (label === "pggit-repacked" && s.maxDepth > 1) {
				fail(
					`pggit served a delta chain of depth ${s.maxDepth} — star topology claims ≤ 1`,
				)
			}
		}
		const cP = cloneSize.get("pggit-repacked") as number
		const cR = cloneSize.get("pggit-raw") as number
		const cG = cloneSize.get("git") as number
		console.log(
			`\nclone: repacked/raw = **${(cP / cR).toFixed(2)}×** (want ≪ 1), ` +
				`repacked/git = ${(cP / cG).toFixed(2)}×`,
		)
		if (cP > cR) fail(`repacked clone (${cP}B) is LARGER than un-repacked (${cR}B)`)

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
		const r2 = await createRepack(db.sql).repack(REPO)
		console.log(`\nrepack #2: ${r2.wholes} wholes + ${r2.deltas} deltas\n`)

		console.log(`## B. the pack a +${RUNS_2}-commit incremental fetch receives\n`)
		console.log("| remote | fetched | max chain depth after |")
		console.log("|---|---|---|")
		const fetched = new Map<string, number>()
		for (const [label] of remotes) {
			const dest = clones.get(label) as string
			const before = packBytes(dest)
			await spawnGit(["-c", "protocol.version=2", "fetch", "-q", "origin"], { cwd: dest })
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			fetched.set(label, packBytes(dest) - before)
			const s = await packShape(dest)
			console.log(`| ${label} | +${kb(packBytes(dest) - before)} | ${s.maxDepth} |`)
			if (label === "pggit-repacked" && s.maxDepth > 1) {
				fail(`pggit served a delta chain of depth ${s.maxDepth} on the incremental fetch`)
			}
		}
		const fP = fetched.get("pggit-repacked") as number
		const fR = fetched.get("pggit-raw") as number
		const fG = fetched.get("git") as number
		console.log(
			`\nincremental: repacked/raw = **${(fP / Math.max(fR, 1)).toFixed(2)}×**, ` +
				`repacked/git = ${(fP / Math.max(fG, 1)).toFixed(2)}× ` +
				`(REPORTED — design gap W3, not asserted)`,
		)
		if (fP > fR) {
			fail(
				`repacked incremental fetch (${fP}B) is LARGER than un-repacked (${fR}B) — regression`,
			)
		}

		const invs = new Map<string, string>()
		for (const [label] of remotes) {
			invs.set(label, await inventory(clones.get(label) as string))
		}
		if (
			invs.get("pggit-repacked") !== invs.get("git") ||
			invs.get("pggit-raw") !== invs.get("git")
		) {
			fail("post-fetch object sets diverge between the three clones")
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

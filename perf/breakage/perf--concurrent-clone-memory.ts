/**
 * PROBE: `buildPack` materializes the ENTIRE pack as one Buffer before the first
 * byte leaves (design W4). What does that cost the serving process when more than
 * one client clones at once, and what does canonical git spend serving the same
 * clones?
 *
 * The pggit side is sampled in-process (`process.memoryUsage().rss`, 25 ms). The
 * git side is sampled from the OS: the summed RSS of every live `upload-pack` /
 * `pack-objects` process while the same number of `git clone file://` run
 * concurrently. Both serve the identical object set.
 *
 * Shape: successive whole versions of a large binary file — the repo shape that
 * makes the served pack big (see perf--blob-delta-gap.ts).
 *
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--concurrent-clone-memory.ts [--conc=1,2,4]
 */
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"
import { cleanupTmp, flag, mb, mkTmp, PG_URL, secs, seedRepo, table } from "./_perf-util"

const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const CONC = flag("conc", "1,2,4").split(",").map(Number)
const VERSIONS = Number(flag("versions", "15"))
const BLOB_BYTES = 4_000_000
const REPO_ID = "probe/conc"
/** MB of server RSS per concurrent clone above which this is called broken. */
const PER_CLONE_MB_LIMIT = 40

function noise(salt: string, len: number): Buffer {
	const parts: Buffer[] = []
	let total = 0
	let i = 0
	while (total < len) {
		const b = createHash("sha256").update(`${salt}-${i++}`).digest()
		parts.push(b)
		total += b.length
	}
	return Buffer.concat(parts).subarray(0, len)
}

function stream(): Buffer {
	const parts: Buffer[] = []
	const base = noise("artifact", BLOB_BYTES)
	let prev: number | null = null
	let mark = 0
	for (let v = 0; v < VERSIONS; v++) {
		const body = Buffer.from(base)
		noise(`edit-${v}`, 200).copy(body, v * 1000)
		const bm = ++mark
		parts.push(
			Buffer.from(`blob\nmark :${bm}\ndata ${body.length}\n`),
			body,
			Buffer.from("\n"),
		)
		const cm = ++mark
		const msg = `v${v}`
		parts.push(
			Buffer.from(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\n` +
					(prev === null ? "" : `from :${prev}\n`) +
					`M 100644 :${bm} data/artifact.bin\n`,
			),
		)
		prev = cm
	}
	return Buffer.concat(parts)
}

/** Summed RSS (bytes) of every live git pack-serving process. */
function gitServerRss(): number {
	const out = execSync("ps -axo rss=,command= || true").toString()
	let total = 0
	for (const line of out.split("\n")) {
		if (!/pack-objects|upload-pack/.test(line)) continue
		const kb = Number(line.trim().split(/\s+/)[0])
		if (Number.isFinite(kb)) total += kb * 1024
	}
	return total
}

async function main(): Promise<void> {
	const src = join(mkTmp("conc"), "repo")
	mkdirSync(src, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
	await spawnGit(["fast-import", "--quiet"], { cwd: src, input: stream() })
	const bare = join(mkTmp("conc-bare"), "remote.git")
	await spawnGit(["clone", "--bare", "-q", src, bare], { cwd: "/tmp" })
	await spawnGit(["repack", "-adf", "-q"], { cwd: bare })

	const db = await createIsolatedSchema(PG_URL)
	const rows: (string | number)[][] = []
	let perClone = 0
	try {
		const seeded = await seedRepo(db.sql, REPO_ID, src)
		await createRepack(db.sql).repack(REPO_ID)
		const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)

		for (const conc of CONC) {
			// --- pggit: in-process RSS while N clients clone at once -----------
			globalThis.gc?.()
			await new Promise((r) => setTimeout(r, 50))
			const base = process.memoryUsage().rss
			let peak = base
			const t1 = setInterval(() => {
				const r = process.memoryUsage().rss
				if (r > peak) peak = r
			}, 25)
			const t0 = Date.now()
			await Promise.all(
				Array.from({ length: conc }, (_, i) => {
					const dest = join(mkTmp(`conc-pggit-${conc}-${i}`), "c")
					return spawnGit([
						"-c",
						"protocol.version=2",
						"clone",
						"-q",
						"--bare",
						`http://127.0.0.1:${server.port}/${REPO_ID}`,
						dest,
					])
				}),
			)
			const pggitMs = Date.now() - t0
			clearInterval(t1)
			const pggitRss = peak - base

			// --- git: summed RSS of its pack-serving processes ------------------
			let gitPeak = 0
			const t2 = setInterval(() => {
				const r = gitServerRss()
				if (r > gitPeak) gitPeak = r
			}, 25)
			const g0 = Date.now()
			await Promise.all(
				Array.from({ length: conc }, (_, i) => {
					const dest = join(mkTmp(`conc-git-${conc}-${i}`), "c")
					return spawnGit(["clone", "-q", "--bare", "--no-local", `file://${bare}`, dest])
				}),
			)
			const gitMs = Date.now() - g0
			clearInterval(t2)

			perClone = Math.max(perClone, pggitRss / conc / 1_000_000)
			rows.push([
				conc,
				secs(pggitMs),
				mb(pggitRss),
				mb(pggitRss / conc),
				secs(gitMs),
				mb(gitPeak),
				mb(gitPeak / conc),
			])
		}
		await server.close()
		console.log(
			`# concurrent clones — ${VERSIONS} whole versions of a ${mb(BLOB_BYTES)} MB file (${mb(seeded.rawBytes)} MB raw)\n`,
		)
		console.log(
			table(
				[
					"concurrent clones",
					"pggit wall s",
					"pggit ΔRSS MB",
					"per clone MB",
					"git wall s",
					"git server RSS MB",
					"per clone MB",
				],
				rows,
			),
		)
	} finally {
		await db.drop()
	}

	console.log(
		`\nFAIL CONDITION: the serving process holds > ${PER_CLONE_MB_LIMIT} MB per in-flight clone (git's pack-objects streams).`,
	)
	console.log(`observed worst: ${perClone.toFixed(0)} MB per in-flight clone`)
	if (perClone > PER_CLONE_MB_LIMIT) process.exitCode = 1
	rmSync(src, { force: true, recursive: true })
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

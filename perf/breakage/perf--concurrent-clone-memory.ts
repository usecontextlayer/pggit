/**
 * PROBE: `buildPack` materializes the ENTIRE pack as one Buffer before the first
 * byte leaves (design W4). What does that cost the serving process when more than
 * one client clones at once, and what does canonical git spend serving the same
 * clones?
 *
 * The pggit side is sampled off-thread from process-wide RSS. The git side is
 * sampled from the OS: the summed RSS of the fixture's own `upload-pack` process
 * trees while the same number of `git clone file://` run concurrently. Both serve
 * the identical object set.
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
import { allObjectOids, revParse } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"
import {
	cleanupTmp,
	increasingIntegerListFlag,
	mb,
	mkTmp,
	PG_URL,
	positiveIntegerFlag,
	secs,
	seedRepo,
	table,
	withPeakRss,
} from "./_perf-util"

const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const CONC = increasingIntegerListFlag("conc", [1, 2, 4])
const VERSIONS = positiveIntegerFlag("versions", 15)
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

type ProcessRow = { pid: number; parentPid: number; rssKb: number; command: string }

/** Summed RSS of this fixture's upload-pack roots and every descendant pack worker. */
function gitServerRss(bareDir: string): number {
	const rows: ProcessRow[] = []
	for (const line of execSync("ps -axo pid=,ppid=,rss=,command=")
		.toString()
		.split("\n")) {
		if (line.trim() === "") continue
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
		if (!match) throw new Error(`unexpected ps row: ${line}`)
		rows.push({
			command: match[4] as string,
			parentPid: Number(match[2]),
			pid: Number(match[1]),
			rssKb: Number(match[3]),
		})
	}
	const fixturePids = new Set(
		rows
			.filter(
				(row) =>
					/(?:git-)?upload-pack/.test(row.command) && row.command.includes(bareDir),
			)
			.map((row) => row.pid),
	)
	let changed = true
	while (changed) {
		changed = false
		for (const row of rows) {
			if (!fixturePids.has(row.pid) && fixturePids.has(row.parentPid)) {
				fixturePids.add(row.pid)
				changed = true
			}
		}
	}
	return rows.reduce(
		(total, row) => total + (fixturePids.has(row.pid) ? row.rssKb * 1024 : 0),
		0,
	)
}

async function main(): Promise<void> {
	const src = join(mkTmp("conc"), "repo")
	mkdirSync(src, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
	await spawnGit(["fast-import", "--quiet"], { cwd: src, input: stream() })
	const bare = join(mkTmp("conc-bare"), "remote.git")
	await spawnGit(["clone", "--bare", "-q", src, bare], { cwd: "/tmp" })
	await spawnGit(["repack", "-adf", "-q"], { cwd: bare })
	const expectedOids = await allObjectOids(src)
	const expectedTip = await revParse(src, "refs/heads/main")
	const verify = async (dest: string): Promise<void> => {
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
		const oids = await allObjectOids(dest)
		const tip = await revParse(dest, "refs/heads/main")
		if (
			tip !== expectedTip ||
			oids.length !== expectedOids.length ||
			oids.some((oid, i) => oid !== expectedOids[i])
		) {
			throw new Error(`clone ${dest} diverged from canonical refs/object set`)
		}
	}

	const db = await createIsolatedSchema(PG_URL)
	const rows: (string | number)[][] = []
	let perClone = 0
	try {
		const seeded = await seedRepo(db.sql, REPO_ID, src)
		if (seeded.objects !== expectedOids.length) {
			throw new Error(`seeded ${seeded.objects} objects, expected ${expectedOids.length}`)
		}
		const repacked = await createRepack(db.sql).repack(REPO_ID)
		if (repacked.wholes + repacked.deltas !== seeded.objects) {
			throw new Error(
				`repack covered ${repacked.wholes + repacked.deltas}/${seeded.objects} objects`,
			)
		}
		const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		try {
			for (const conc of CONC) {
				// --- pggit: in-process RSS while N clients clone at once -----------
				if (typeof globalThis.gc !== "function") {
					throw new Error("memory measurement requires NODE_OPTIONS=--expose-gc")
				}
				globalThis.gc()
				globalThis.gc()
				await new Promise((r) => setTimeout(r, 50))
				const pggitDests = Array.from({ length: conc }, (_, i) =>
					join(mkTmp(`conc-pggit-${conc}-${i}`), "c"),
				)
				const pggitRun = await withPeakRss(() =>
					Promise.all(
						pggitDests.map((dest) =>
							spawnGit([
								"-c",
								"protocol.version=2",
								"clone",
								"-q",
								"--bare",
								`http://127.0.0.1:${server.port}/${REPO_ID}`,
								dest,
							]),
						),
					),
				)
				const pggitRss = pggitRun.peakRss - pggitRun.baseRss
				if (pggitRss <= 0) {
					throw new Error(
						`pggit RSS peak did not exceed baseline at concurrency ${conc}: ${pggitRun.peakRss} <= ${pggitRun.baseRss}`,
					)
				}
				for (const dest of pggitDests) await verify(dest)

				// --- git: summed RSS of its pack-serving processes ------------------
				let gitPeak = 0
				let gitSampleError: unknown
				const t2 = setInterval(() => {
					try {
						const r = gitServerRss(bare)
						if (r > gitPeak) gitPeak = r
					} catch (error) {
						gitSampleError = error
					}
				}, 25)
				const g0 = Date.now()
				const gitDests = Array.from({ length: conc }, (_, i) =>
					join(mkTmp(`conc-git-${conc}-${i}`), "c"),
				)
				try {
					await Promise.all(
						gitDests.map((dest) =>
							spawnGit(["clone", "-q", "--bare", "--no-local", `file://${bare}`, dest]),
						),
					)
				} finally {
					clearInterval(t2)
				}
				const gitMs = Date.now() - g0
				if (gitSampleError !== undefined) throw gitSampleError
				for (const dest of gitDests) await verify(dest)
				if (gitPeak <= 0) {
					throw new Error(
						`canonical RSS sampler missed every fixture process at concurrency ${conc}`,
					)
				}

				perClone = Math.max(perClone, pggitRss / conc / 1_000_000)
				rows.push([
					conc,
					secs(pggitRun.ms),
					mb(pggitRss),
					mb(pggitRss / conc),
					secs(gitMs),
					mb(gitPeak),
					mb(gitPeak / conc),
				])
			}
		} finally {
			await server.close()
		}
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

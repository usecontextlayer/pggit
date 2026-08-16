/**
 * PROBE: what does "blobs are never deltified" cost a client, measured at the
 * client, against real git doing the same job?
 *
 * The repack tier only ever deltas TREES (phase 1 walks tree pairs; phase 2 ships
 * everything else whole). A repo whose weight is successive near-identical
 * versions of one large file — a lockfile, a build artifact, a checked-in dataset,
 * a snapshot of generated output — therefore ships every version WHOLE, forever,
 * while `git` deltas them to nearly nothing.
 *
 * Measured black-box: a real `git clone` off the wire server AFTER a full repack,
 * versus a real `git clone` from the same repo served by canonical git. Peak
 * server RSS is sampled through the pggit clone (the pack is materialized whole
 * before the first byte leaves).
 *
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--blob-delta-gap.ts
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--blob-delta-gap.ts --pg=postgres://…
 */
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"
import {
	cleanupTmp,
	flag,
	gitRepack,
	mb,
	mkTmp,
	PG_URL,
	secs,
	seedRepo,
	table,
	timedSpawn,
	withPeakRss,
} from "./_perf-util"

const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const REPO_ID = "probe/blobs"

/** Versions of the big file, and its size. 20 × 4 MB ≈ what a month of a daily
 * regenerated artifact looks like. */
const VERSIONS = Number(flag("versions", "20"))
const BLOB_BYTES = Number(flag("bytes", "4000000"))
/** Ratio of pggit's served pack to git's at which this is called broken. */
const SIZE_RATIO_LIMIT = 3

/** Deterministic incompressible bytes. */
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

/** V commits, each rewriting `data/artifact.bin` with a 200-byte edit. */
function stream(): Buffer {
	const parts: Buffer[] = []
	const base = noise("artifact", BLOB_BYTES)
	let prev: number | null = null
	let mark = 0
	for (let v = 0; v < VERSIONS; v++) {
		const body = Buffer.from(base)
		// Only 200 bytes differ between consecutive versions — git deltas this to ~0.
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

function dirBytes(dir: string): number {
	return (
		Number(
			execSync(`du -sk ${JSON.stringify(dir)}`)
				.toString()
				.split("\t")[0],
		) * 1024
	)
}

async function main(): Promise<void> {
	const src = join(mkTmp("blobs"), "repo")
	mkdirSync(src, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
	await spawnGit(["fast-import", "--quiet"], { cwd: src, input: stream() })

	// --- git's own answer ---------------------------------------------------
	const git = await gitRepack(src, "blobs-git")
	const gitClonedTo = join(mkTmp("blobs-clone-git"), "c")
	const gitClone = await timedSpawn(
		"git",
		["clone", "-q", "--no-local", `file://${src}`, gitClonedTo],
		"/tmp",
	)
	const gitCloneBytes = dirBytes(join(gitClonedTo, ".git", "objects"))

	// --- pggit's answer -----------------------------------------------------
	const db = await createIsolatedSchema(PG_URL)
	let rows: (string | number)[][] = []
	let ratio = 0
	try {
		const seeded = await seedRepo(db.sql, REPO_ID, src)
		const repack = await withPeakRss(() => createRepack(db.sql).repack(REPO_ID))
		const server = await serveOnPort(
			createGitApp(createGitDeps(db.sql), { instrument: true }),
			0,
		)
		resetCollected()
		const dest = join(mkTmp("blobs-clone-pggit"), "c")
		const clone = await withPeakRss(async () => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				`http://127.0.0.1:${server.port}/${REPO_ID}`,
				dest,
			])
		})
		await server.close()
		const run = collectedRuns().find((r) => r.label === "fetch")
		const packBytes = run?.counters.get("packBytes") ?? 0
		const deltasServed = run?.counters.get("deltasServed") ?? 0
		ratio = packBytes / Math.max(git.packBytes, 1)

		rows = [
			[
				"git",
				`${VERSIONS}× ${mb(BLOB_BYTES)} MB`,
				mb(seeded.rawBytes),
				mb(git.packBytes),
				secs(gitClone.ms),
				mb(gitClone.peakRss),
				"—",
			],
			[
				"pggit",
				`${VERSIONS}× ${mb(BLOB_BYTES)} MB`,
				mb(seeded.rawBytes),
				mb(packBytes),
				secs(clone.ms),
				mb(clone.peakRss - clone.baseRss),
				`${repack.value.wholes}w+${repack.value.deltas}d, ${deltasServed} served as delta`,
			],
		]
		console.log("# blob deltification gap — served bytes at the client\n")
		console.log(
			table(
				[
					"server",
					"content",
					"raw MB",
					"served pack MB",
					"clone s",
					"peak RSS MB (server-side for pggit)",
					"encodings",
				],
				rows,
			),
		)
		console.log(
			`\ngit clone objects on disk: ${mb(gitCloneBytes)} MB · pggit served ${ratio.toFixed(1)}× more bytes than git`,
		)
	} finally {
		await db.drop()
	}

	console.log(
		`\nFAIL CONDITION: pggit's served pack > ${SIZE_RATIO_LIMIT}× git's pack for the same objects.`,
	)
	if (ratio > SIZE_RATIO_LIMIT) {
		console.log(
			"RESULT: BROKEN — every version of a large file ships whole, on every clone.",
		)
		process.exitCode = 1
	}
	rmSync(src, { force: true, recursive: true })
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

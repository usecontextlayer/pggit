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
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { readPack } from "@/pack/read-pack"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { allObjectOids, loadGitObjects, revParse } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"
import {
	cleanupTmp,
	mb,
	mkTmp,
	PG_URL,
	positiveIntegerFlag,
	secs,
	seedRepo,
	table,
	timedSpawn,
	withPeakRss,
} from "./_perf-util"
import { canonicalV2Pack, indexRawPack, postPggitV2Pack } from "./_realrepo-util"

const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const REPO_ID = "probe/blobs"

/** Versions of the big file, and its size. 20 × 4 MB ≈ what a month of a daily
 * regenerated artifact looks like. */
const VERSIONS = positiveIntegerFlag("versions", 20)
const BLOB_BYTES = positiveIntegerFlag("bytes", 4_000_000)
/** Ratio of pggit's served pack to git's at which this is called broken. */
const SIZE_RATIO_LIMIT = 3

if (VERSIONS < 2) throw new Error("--versions must be at least 2")
const LAST_EDIT_END = (VERSIONS - 1) * 1000 + 200
if (BLOB_BYTES < LAST_EDIT_END) {
	throw new Error(
		`--bytes must be at least ${LAST_EDIT_END} for ${VERSIONS} distinct version edits`,
	)
}
if (BLOB_BYTES >= MAX_INLINE_BYTEA_BYTES) {
	throw new Error(
		`--bytes must stay below the ${MAX_INLINE_BYTEA_BYTES}-byte repack eligibility ceiling`,
	)
}

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

	// --- git's own clone answer ---------------------------------------------
	const gitClonedTo = join(mkTmp("blobs-clone-git"), "c")
	const gitClone = await timedSpawn(
		"git",
		["clone", "-q", "--no-local", `file://${src}`, gitClonedTo],
		"/tmp",
	)
	if (gitClone.code !== 0) throw new Error(`canonical git clone exited ${gitClone.code}`)
	await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: gitClonedTo })
	const expectedOids = await allObjectOids(src)
	const expectedTip = await revParse(src, "refs/heads/main")
	const expectedObjects = await loadGitObjects(src, expectedOids)
	const blobObjects = expectedObjects.filter((object) => object.type === "blob")
	const commitObjects = expectedObjects.filter((object) => object.type === "commit")
	if (blobObjects.length !== VERSIONS || commitObjects.length !== VERSIONS) {
		throw new Error(
			`fixture produced ${blobObjects.length} blobs and ${commitObjects.length} commits for ${VERSIONS} versions`,
		)
	}
	const gitCloneOids = await allObjectOids(gitClonedTo)
	if (
		gitCloneOids.length !== expectedOids.length ||
		gitCloneOids.some((oid, i) => oid !== expectedOids[i])
	) {
		throw new Error("canonical clone did not reproduce the source object set")
	}
	const gitCloneBytes = dirBytes(join(gitClonedTo, ".git", "objects"))

	// --- pggit's answer -----------------------------------------------------
	const db = await createIsolatedSchema(PG_URL)
	let rows: (string | number)[][] = []
	let ratio = 0
	try {
		const seeded = await seedRepo(db.sql, REPO_ID, src)
		const repack = await withPeakRss(() => createRepack(db.sql).repack(REPO_ID))
		if (seeded.objects !== expectedOids.length) {
			throw new Error(`seeded ${seeded.objects} objects, expected ${expectedOids.length}`)
		}
		if (repack.value.wholes + repack.value.deltas !== seeded.objects) {
			throw new Error(
				`repack covered ${repack.value.wholes + repack.value.deltas}/${seeded.objects} objects`,
			)
		}
		const server = await serveOnPort(
			createGitApp(createGitDeps(db.sql), { instrument: true }),
			0,
		)
		const url = `http://127.0.0.1:${server.port}/${REPO_ID}`
		const request = fetchRequest({ done: true, wants: [expectedTip] })
		let clone: Awaited<ReturnType<typeof withPeakRss>>
		let pggitPack: Buffer
		let gitPack: Buffer
		let run: ReturnType<typeof collectedRuns>[number] | undefined
		const dest = join(mkTmp("blobs-clone-pggit"), "c")
		try {
			resetCollected()
			;[pggitPack, gitPack] = await Promise.all([
				postPggitV2Pack(url, request),
				canonicalV2Pack(src, request),
			])
			const rawRuns = collectedRuns().filter((candidate) => candidate.label === "fetch")
			run = rawRuns[0]
			if (rawRuns.length !== 1 || run === undefined) {
				throw new Error(
					`expected one raw-fetch instrumentation run, got ${rawRuns.length}`,
				)
			}
			resetCollected()
			clone = await withPeakRss(async () => {
				await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
			})
		} finally {
			await server.close()
		}
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
		const cloneOids = await allObjectOids(dest)
		const cloneTip = await revParse(dest, "refs/heads/main")
		if (
			cloneTip !== expectedTip ||
			cloneOids.length !== expectedOids.length ||
			cloneOids.some((oid, i) => oid !== expectedOids[i])
		) {
			throw new Error("pggit clone refs/object set diverged from canonical git")
		}
		if (run === undefined) throw new Error("missing raw-fetch instrumentation run")
		const packBytes = run.counters.get("packBytes")
		const deltasServed = run.counters.get("deltasServed")
		const objectsServed = run.counters.get("objectsServed")
		if (packBytes === undefined || packBytes <= 0) {
			throw new Error(`missing/nonpositive packBytes counter: ${String(packBytes)}`)
		}
		if (packBytes !== pggitPack.length) {
			throw new Error(
				`packBytes counter ${packBytes} != captured pack ${pggitPack.length}`,
			)
		}
		if (objectsServed !== expectedOids.length) {
			throw new Error(
				`objectsServed ${String(objectsServed)} != expected ${expectedOids.length}`,
			)
		}
		if (deltasServed === undefined || deltasServed <= 0) {
			throw new Error(`missing/nonpositive deltasServed counter: ${String(deltasServed)}`)
		}
		const [pggitRawObjects, gitRawObjects] = await Promise.all([
			readPack(pggitPack),
			readPack(gitPack),
		])
		const pggitRawOids = pggitRawObjects.map((object) => object.oid).sort()
		const gitRawOids = gitRawObjects.map((object) => object.oid).sort()
		if (
			JSON.stringify(pggitRawOids) !== JSON.stringify(expectedOids) ||
			JSON.stringify(gitRawOids) !== JSON.stringify(expectedOids)
		) {
			throw new Error(
				`raw response object sets differ from source (${pggitRawOids.length}/${gitRawOids.length}/${expectedOids.length})`,
			)
		}
		const pggitIndexDir = join(mkTmp("blobs-pggit-pack"), "r.git")
		const gitIndexDir = join(mkTmp("blobs-git-pack"), "r.git")
		await spawnGit(["init", "-q", "--bare", pggitIndexDir])
		await spawnGit(["init", "-q", "--bare", gitIndexDir])
		const [pggitIndex, gitIndex] = await Promise.all([
			indexRawPack(pggitIndexDir, pggitPack, false),
			indexRawPack(gitIndexDir, gitPack, false),
		])
		const pggitBlobDeltas = pggitIndex.entries.filter(
			(object) => object.type === "blob" && object.kind === "delta",
		).length
		const gitBlobDeltas = gitIndex.entries.filter(
			(object) => object.type === "blob" && object.kind === "delta",
		).length
		if (pggitBlobDeltas !== 0 || gitBlobDeltas === 0) {
			throw new Error(
				`named delta precondition failed: pggit blob deltas=${pggitBlobDeltas}, git blob deltas=${gitBlobDeltas}`,
			)
		}
		ratio = pggitPack.length / gitPack.length

		rows = [
			[
				"git",
				`${VERSIONS}× ${mb(BLOB_BYTES)} MB`,
				mb(seeded.rawBytes),
				mb(gitPack.length),
				secs(gitClone.ms),
				mb(gitClone.peakRss),
				"—",
			],
			[
				"pggit",
				`${VERSIONS}× ${mb(BLOB_BYTES)} MB`,
				mb(seeded.rawBytes),
				mb(pggitPack.length),
				secs(clone.ms),
				mb(clone.peakRss - clone.baseRss),
				`${repack.value.wholes}w+${repack.value.deltas}d, blob deltas ${pggitBlobDeltas}/${gitBlobDeltas} pggit/git`,
			],
		]
		console.log("# blob deltification gap — raw response PACK bytes\n")
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
			`\ngit clone objects on disk: ${mb(gitCloneBytes)} MB · pggit sent ${ratio.toFixed(1)}× more raw PACK bytes than git`,
		)
	} finally {
		await db.drop()
	}

	console.log(
		`\nFAIL CONDITION: pggit's raw response PACK > ${SIZE_RATIO_LIMIT}× git's for the same request and object set.`,
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

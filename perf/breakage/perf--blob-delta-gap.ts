/**
 * PROBE: what does "blobs are never deltified" cost on the raw fetch wire,
 * against canonical git answering the identical protocol-v2 request?
 *
 * The repack tier only ever deltas TREES (phase 1 walks tree pairs; phase 2 ships
 * everything else whole). A repo whose weight is successive near-identical
 * versions of one large file — a lockfile, a build artifact, a checked-in dataset,
 * a snapshot of generated output — therefore ships every version WHOLE, forever,
 * while `git` deltas them to nearly nothing.
 *
 * The size verdict compares the two raw response PACKs before either client can
 * rewrite them. Both are decoded to prove their exact object sets and to establish
 * the named blob-delta split. Real clones remain as correctness/RSS oracles: each
 * is fsck'd, and pggit's server RSS is sampled while its pack is materialized.
 *
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--blob-delta-gap.ts
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--blob-delta-gap.ts --pg=postgres://…
 */
import { execSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	assertGitReachableObjects,
	canonicalStoreRefsOf,
	loadGitObjects,
	repackEligibleObjects,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"
import { parseArgs, pgUrlArg, positiveIntegerArg } from "../args"
import { requiredCollector, requiredPositiveCounter } from "../collector-evidence"
import { table } from "../table"
import {
	cleanupTmp,
	mb,
	mkTmp,
	rewrittenArtifactStream,
	secs,
	seedRepo,
	timedSpawn,
	withPeakRss,
} from "./_perf-util"
import { canonicalV2Pack, indexRawPack, postPggitV2Pack } from "./_realrepo-util"

const REPO_ID = "probe/blobs"

/** Versions of the big file, and its size. 20 × 4 MB ≈ what a month of a daily
 * regenerated artifact looks like. */
const {
	bytes: BLOB_BYTES,
	pg: PG_URL,
	versions: VERSIONS,
} = parseArgs(
	z
		.object({
			bytes: positiveIntegerArg.max(MAX_INLINE_BYTEA_BYTES - 1).default(4_000_000),
			pg: pgUrlArg,
			versions: positiveIntegerArg.min(2).default(20),
		})
		.strict()
		.superRefine(({ bytes, versions }, context) => {
			const requiredBytes = (versions - 1) * 1000 + 200
			if (bytes < requiredBytes) {
				context.addIssue({
					code: "custom",
					message: `must be at least ${requiredBytes} for ${versions} distinct version edits`,
					path: ["bytes"],
				})
			}
		}),
)
/** Ratio of pggit's served pack to git's at which this is called broken. */
const SIZE_RATIO_LIMIT = 3

function allocatedDiskBytes(dir: string): number {
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
	await spawnGit(["fast-import", "--quiet"], {
		cwd: src,
		input: rewrittenArtifactStream({ blobBytes: BLOB_BYTES, versions: VERSIONS }),
	})

	// --- git's own clone answer ---------------------------------------------
	const gitClonedTo = join(mkTmp("blobs-clone-git"), "c")
	const gitClone = await timedSpawn(
		"git",
		["clone", "-q", "--no-local", `file://${src}`, gitClonedTo],
		"/tmp",
	)
	if (gitClone.ms <= 0 || gitClone.peakRss <= 0) {
		throw new Error(
			`canonical clone measurement invalid: ms=${gitClone.ms}, peak=${gitClone.peakRss}`,
		)
	}
	const expectedOids = await allObjectOids(src)
	await assertGitReachableObjects(gitClonedTo, expectedOids, "canonical clone")
	const expectedTip = await revParse(src, "refs/heads/main")
	const expectedObjects = await loadGitObjects(src, expectedOids)
	const blobObjects = expectedObjects.filter((object) => object.type === "blob")
	const commitObjects = expectedObjects.filter((object) => object.type === "commit")
	if (blobObjects.length !== VERSIONS || commitObjects.length !== VERSIONS) {
		throw new Error(
			`fixture produced ${blobObjects.length} blobs and ${commitObjects.length} commits for ${VERSIONS} versions`,
		)
	}
	const gitCloneBytes = allocatedDiskBytes(join(gitClonedTo, ".git", "objects"))

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
		if (repack.value.wholes + repack.value.deltas !== seeded.eligibleObjects) {
			throw new Error(
				`repack covered ${repack.value.wholes + repack.value.deltas}/${seeded.eligibleObjects} eligible objects`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "exact", objects: repackEligibleObjects(expectedObjects) },
			objects: expectedObjects,
			refs: await canonicalStoreRefsOf(src),
		})
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
			run = requiredCollector(collectedRuns(), "fetch", "blob-delta raw fetch")
			resetCollected()
			clone = await withPeakRss(async () => {
				await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
			})
		} finally {
			await server.close()
		}
		await assertGitReachableObjects(dest, expectedOids, "pggit clone")
		if (clone.ms <= 0 || clone.peakRss <= clone.baseRss) {
			throw new Error(
				`pggit clone measurement invalid: ms=${clone.ms}, base=${clone.baseRss}, peak=${clone.peakRss}`,
			)
		}
		const cloneTip = await revParse(dest, "refs/heads/main")
		if (cloneTip !== expectedTip) {
			throw new Error("pggit clone ref tip diverged from canonical git")
		}
		if (run === undefined) throw new Error("missing raw-fetch instrumentation run")
		const packBytes = requiredPositiveCounter(run, "packBytes", "blob-delta raw fetch")
		requiredPositiveCounter(run, "deltasServed", "blob-delta raw fetch")
		const objectsServed = requiredPositiveCounter(
			run,
			"objectsServed",
			"blob-delta raw fetch",
		)
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
		const pggitIndexDir = join(mkTmp("blobs-pggit-pack"), "r.git")
		const gitIndexDir = join(mkTmp("blobs-git-pack"), "r.git")
		await spawnGit(["init", "-q", "--bare", pggitIndexDir])
		await spawnGit(["init", "-q", "--bare", gitIndexDir])
		const [pggitIndex, gitIndex] = await Promise.all([
			indexRawPack(pggitIndexDir, pggitPack, "complete"),
			indexRawPack(gitIndexDir, gitPack, "complete"),
		])
		const pggitRawOids = pggitIndex.entries.map((object) => object.oid).sort()
		const gitRawOids = gitIndex.entries.map((object) => object.oid).sort()
		if (
			JSON.stringify(pggitRawOids) !== JSON.stringify(expectedOids) ||
			JSON.stringify(gitRawOids) !== JSON.stringify(expectedOids)
		) {
			throw new Error(
				`raw response object sets differ from source (${pggitRawOids.length}/${gitRawOids.length}/${expectedOids.length})`,
			)
		}
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

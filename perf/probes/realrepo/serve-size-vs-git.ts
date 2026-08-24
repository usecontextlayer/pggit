/**
 * FINDING: on a real source repository the repacked serve path ships a pack many
 * times larger than git's, and `git verify-pack -v` says exactly where the bytes go.
 *
 * The delta tier deltifies TREES only (repack.ts phase 1 walks tree lineages; phase 2
 * sweeps everything else whole). git's window search deltifies BLOBS too. On the
 * motivating append-only workload that costs nothing — each commit adds NEW blobs,
 * which have no useful base — but on an ordinary source repo, where large text files
 * (lockfiles, generated types, long markdown) are REWRITTEN commit after commit, the
 * blob side is where git wins and pggit pays full deflate for every version.
 *
 * Black-box setup remains real `git push` over the wire followed by `createRepack().repack()`. Measurement sends one identical no-have v2 request to pggit and canonical `git upload-pack`, captures the raw band-1 PACK bytes before client indexing can append thin bases, proves the transmitted OID sets are identical, and only then indexes those captured packs for strict `verify-pack -v` attribution. Separate mirror clones prove exact refs, object bytes, and fsck state.
 *
 * A perf harness rather than a vitest e2e test on both counts: the verdict is a MEASURED size ratio, and the corpus is a REAL local repository selected at run time (`--repo=` or `--mirror=`), which no committed fixture can stand in for.
 *
 *   npx tsx perf/probes/realrepo/serve-size-vs-git.ts --repo=/path/to/checkout --slug=<name>
 *
 * Exit 0 = the served pack is within the configured `--max-ratio` (default 3.0).
 * Exit 1 = reproduced: the ratio is past that, with the per-type attribution printed.
 */
import { join } from "node:path"
import { nonemptyStringArg, parseArgs, pgUrlArg, positiveNumberArg } from "@perf/args"
import { table } from "@perf/probes/_table"
import {
	assertCanonicalRealRepoStore,
	canonicalV2Pack,
	createScratch,
	indexRawPack,
	mb,
	mirrorSourceFromArgs,
	postPggitV2Pack,
	prepareMirror,
	repackExactly,
} from "@perf/probes/realrepo/_util"
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import type { Oid } from "@/object/oid"
import { readPack } from "@/pack/read-pack"
import { serveOnPort } from "@/server"
import {
	allRefsOf,
	compareMirrorClones,
	type VerifyPackObject,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

const args = parseArgs(
	z
		.object({
			"max-ratio": positiveNumberArg.default(3),
			mirror: nonemptyStringArg.optional(),
			pg: pgUrlArg,
			repo: nonemptyStringArg.optional(),
			slug: nonemptyStringArg.default("repo"),
		})
		.strict()
		.transform(({ mirror, repo, ...values }) => ({
			...values,
			source: mirrorSourceFromArgs({ mirror, repo }),
		})),
)
const SLUG = args.slug
const MAX_RATIO = args["max-ratio"]
const PG_URL = args.pg

const scratch = createScratch(`serve-size-${SLUG}`)

type Attribution = Map<string, { n: number; packed: number; deltified: number }>

/** Per-type bytes-in-packfile, straight from `git verify-pack -v`: the authoritative
 * account of what a pack actually spent, including whether each entry is a delta. */
function attribute(
	entries: readonly VerifyPackObject[],
	source: string,
): { by: Attribution; total: number } {
	const by: Attribution = new Map()
	let total = 0
	for (const object of entries) {
		const slot = by.get(object.type) ?? { deltified: 0, n: 0, packed: 0 }
		slot.n++
		slot.packed += object.packedSize
		if (object.kind === "delta") slot.deltified++
		by.set(object.type, slot)
		total += object.packedSize
	}
	if (total === 0 || by.size === 0) {
		throw new Error(`${source}: verify-pack attributed zero objects or bytes`)
	}
	return { by, total }
}

async function wantedRefOids(dir: string): Promise<Oid[]> {
	const wants = [...new Set((await allRefsOf(dir)).map(({ oid }) => oid))]
	if (wants.length === 0) throw new Error(`${dir}: zero ref wants`)
	return wants
}

function printAttribution(label: string, a: { by: Attribution; total: number }): void {
	console.log(`\n### ${label} — ${mb(a.total)} of pack entries`)
	console.log(
		table(
			["type", "objects", "bytes in pack", "entries stored as deltas"],
			["commit", "tree", "blob", "tag"].flatMap((type) => {
				const stats = a.by.get(type)
				return stats === undefined
					? []
					: [
							[
								type,
								stats.n,
								mb(stats.packed),
								`${stats.deltified} (${((stats.deltified / stats.n) * 100).toFixed(0)}%)`,
							],
						]
			}),
		),
	)
}

async function main(): Promise<void> {
	const MIRROR = await prepareMirror(scratch, args.source)
	console.log(`# serve-size vs git — ${SLUG}\n  mirror ${MIRROR}`)
	const repoId = `sizecheck/${SLUG}`
	const db = await createIsolatedSchema(PG_URL)
	const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	const url = `http://127.0.0.1:${server.port}/${repoId}`
	try {
		await spawnGit(["push", url, "--mirror"], { cwd: MIRROR })
		const r = await repackExactly(db.sql, repoId)
		if (r.deltas === 0) {
			throw new Error(
				`serve-size fixture did not exercise the delta tier (${r.wholes} wholes, ${r.deltas} deltas)`,
			)
		}
		console.log(`  repack: ${r.wholes} wholes + ${r.deltas} deltas`)

		// git's own answer over the SAME object set: replay the same push into a plain
		// file:// bare remote and gc it.
		const oracle = join(scratch.mk("oracle"), "o.git")
		await spawnGit(["init", "-q", "-b", "main", "--bare", oracle])
		await spawnGit(["push", `file://${oracle}`, "--mirror"], { cwd: MIRROR })
		await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: oracle })
		await assertCanonicalRealRepoStore(db.sql, repoId, oracle, { kind: "repacked" })

		const pggitDir = join(scratch.mk("pggit"), "c.git")
		const gitDir = join(scratch.mk("git"), "g.git")
		const comparison = await compareMirrorClones(
			{ dest: pggitDir, url },
			{ dest: gitDir, url: `file://${oracle}` },
		)
		if (
			comparison.served.fsck !== "" ||
			comparison.oracle.fsck !== "" ||
			comparison.objects.onlyServed.length > 0 ||
			comparison.objects.onlyOracle.length > 0 ||
			comparison.served.digest !== comparison.oracle.digest ||
			JSON.stringify(comparison.served.refs) !== JSON.stringify(comparison.oracle.refs)
		) {
			throw new Error(
				`serve-size clone prerequisite diverged (served-only ${comparison.objects.onlyServed.length}, oracle-only ${comparison.objects.onlyOracle.length}, refs ${comparison.served.refs.length}/${comparison.oracle.refs.length}, fsck ${JSON.stringify(comparison.served.fsck)}/${JSON.stringify(comparison.oracle.fsck)})`,
			)
		}

		const request = fetchRequest({
			done: true,
			includeTag: true,
			wants: await wantedRefOids(oracle),
		})
		const [pggitPack, gitPack] = await Promise.all([
			postPggitV2Pack(url, request),
			canonicalV2Pack(oracle, request),
		])
		const [pggitObjects, gitObjects] = await Promise.all([
			readPack(pggitPack),
			readPack(gitPack),
		])
		const pggitOids = pggitObjects.map((object) => object.oid).sort()
		const gitOids = gitObjects.map((object) => object.oid).sort()
		if (gitOids.length === 0 || JSON.stringify(pggitOids) !== JSON.stringify(gitOids)) {
			throw new Error(
				`serve-size raw pack prerequisite failed (${pggitOids.length}/${gitOids.length} transmitted objects)`,
			)
		}

		const pggitIndexed = join(scratch.mk("pggit-raw-pack"), "p.git")
		const gitIndexed = join(scratch.mk("git-raw-pack"), "g.git")
		await spawnGit(["init", "-q", "--bare", pggitIndexed])
		await spawnGit(["init", "-q", "--bare", gitIndexed])
		const [pggitIndex, gitIndex] = await Promise.all([
			indexRawPack(pggitIndexed, pggitPack, "complete"),
			indexRawPack(gitIndexed, gitPack, "complete"),
		])

		const p = attribute(pggitIndex.entries, "pggit raw pack")
		const g = attribute(gitIndex.entries, "canonical raw pack")
		if (p.total > pggitPack.length || g.total > gitPack.length) {
			throw new Error(
				`verify-pack entry bytes exceed raw pack length (pggit ${p.total}/${pggitPack.length}, git ${g.total}/${gitPack.length})`,
			)
		}
		printAttribution("pggit raw response pack", p)
		printAttribution("git raw response pack (gc --aggressive)", g)

		const ratio = pggitPack.length / gitPack.length
		console.log(`\n### where the gap is`)
		const gapRows: (string | number)[][] = []
		for (const t of ["commit", "tree", "blob", "tag"]) {
			const ps = p.by.get(t)
			const gs = g.by.get(t)
			if (!ps || !gs) continue
			gapRows.push([
				t,
				mb(ps.packed),
				mb(gs.packed),
				`${(ps.packed / gs.packed).toFixed(2)}x`,
			])
		}
		gapRows.push([
			"**raw pack**",
			`**${mb(pggitPack.length)}**`,
			`**${mb(gitPack.length)}**`,
			`**${ratio.toFixed(2)}x**`,
		])
		console.log(table(["type", "pggit", "git", "pggit / git"], gapRows))

		const pggitBlobs = p.by.get("blob")
		const gitBlobs = g.by.get("blob")
		const pggitTrees = p.by.get("tree")
		const gitTrees = g.by.get("tree")
		if (
			pggitBlobs === undefined ||
			gitBlobs === undefined ||
			pggitTrees === undefined ||
			gitTrees === undefined ||
			pggitBlobs.n === 0 ||
			gitBlobs.n !== pggitBlobs.n ||
			pggitBlobs.deltified !== 0 ||
			gitBlobs.deltified === 0
		) {
			throw new Error(
				`blob-delta prerequisite failed: pggit=${JSON.stringify(pggitBlobs)}, git=${JSON.stringify(gitBlobs)}`,
			)
		}
		const blobP = pggitBlobs.packed
		const blobG = gitBlobs.packed
		const treeP = pggitTrees.packed
		const treeG = gitTrees.packed
		const gap = pggitPack.length - gitPack.length
		if (gap > 0) {
			console.log(
				`\nof the ${mb(gap)} gap: ${(((blobP - blobG) / gap) * 100).toFixed(0)}% is blobs, ` +
					`${(((treeP - treeG) / gap) * 100).toFixed(0)}% is trees`,
			)
		} else {
			console.log(`\npggit has no positive raw-pack gap to attribute (${mb(gap)}).`)
		}
		console.log(
			`blob entries stored as deltas — pggit ${pggitBlobs.deltified} / git ${gitBlobs.deltified}`,
		)

		if (ratio > MAX_RATIO) {
			console.log(
				`\nREPRODUCED: ${SLUG} serves ${ratio.toFixed(2)}x git's raw pack (${mb(pggitPack.length)} vs ${mb(gitPack.length)}), ` +
					`past the configured ${MAX_RATIO}x bar.`,
			)
			process.exitCode = 1
		} else {
			console.log(`\nOK: ${ratio.toFixed(2)}x is within the ${MAX_RATIO}x bar.`)
		}
	} finally {
		await server.close()
		await db.drop()
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})

/**
 * pg-bloat--topology-growth — the growth curve of the topology surface, measured
 * against the packfile for the same history. The FLIPPED successor of
 * `pg-bloat--git-edge-quadratic` (spine slice S2): that harness measured
 * `git_edge` growing as N²/2 on the append-only shape (exponent 1.99 at komal)
 * and exit-1'd on super-linearity; the spine deleted the table, so this run is
 * the standing regression guard that the topology surface — `git_commit` +
 * `git_tag` rows — stays LINEAR in history, and that no `git_edge` relation
 * exists to quietly resurrect the old curve.
 *
 * EXIT NON-ZERO when the measured growth exponent exceeds `EXPONENT_LIMIT`
 * (super-linear: doubling a repo's age more than doubles its topology bytes), or
 * when a `git_edge` table exists in the schema at all.
 *
 *   npx tsx perf/breakage/pg-bloat--topology-growth.ts --lengths=100,200,400,800,1600
 */
import { z } from "zod"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	deterministicFiller,
	FAST_IMPORT_COMMITTER,
	uuidFromSeed,
} from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	loadAllReachableObjects,
	packFileBytes,
	requiredAt,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { increasingIntegerListArg, parseArgs, pgUrlArg } from "../args"
import { mb, pad, padr, scratchRoot, sizeOf } from "./_pg-bloat-util"

/** growth exponent (log-log slope) above which the surface is super-linear */
const EXPONENT_LIMIT = 1.35

const { lengths: LENGTHS, pg: PG_URL } = parseArgs(
	z
		.object({
			lengths: increasingIntegerListArg([100, 200, 400, 800, 1600]),
			pg: pgUrlArg,
		})
		.strict(),
)

function buildStream(commits: number): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (c: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(c)}\n${c}\n`)
		return m
	}
	const seeded: string[] = []
	for (let i = 0; i < 20; i++) {
		const m = blob(`# doc ${i}\n${deterministicFiller(`doc-${i}`, 800)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	for (let i = 0; i < commits; i++) {
		const dir = uuidFromSeed(`topology-run-${i}`)
		const record = blob(
			`{"run":"${dir}","p":"${deterministicFiller(`rec-${i}`, 700)}"}\n`,
		)
		const stderr = blob(`${deterministicFiller(`err-${i}`, 200)}\n`)
		const cm = next()
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nrun\nfrom :${prev}\n` +
				`M 100644 :${record} .engine/runs/planner-updates/${dir}/record.json\n` +
				`M 100644 :${stderr} .engine/runs/planner-updates/${dir}/stderr\n`,
		)
		prev = cm
	}
	return out.join("")
}

type Point = {
	commits: number
	objects: number
	commitRows: number
	topoTotal: number
	objTotal: number
	packBytes: number
	edgeTableExists: boolean
}

async function measure(
	commits: number,
	scratch: ReturnType<typeof scratchRoot>,
): Promise<Point> {
	const src = scratch.dir(`src-${commits}`)
	await spawnGit(["init", "-q", "-b", "main", src])
	await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream(commits) })

	const gcDir = scratch.dir(`gc-${commits}`)
	await spawnGit(["clone", "-q", "--mirror", src, gcDir])
	await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: gcDir })
	const packBytes = await packFileBytes(gcDir)
	if (packBytes <= 0) throw new Error(`canonical git pack size is ${packBytes}`)

	const objects = await loadAllReachableObjects(src)
	const db = await createIsolatedSchema(PG_URL)
	try {
		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		await store.putPack("r/topology", objects)
		const tip = await revParse(src, "refs/heads/main")
		await refs.setRef("r/topology", "refs/heads/main", tip)
		await refs.setSymref("r/topology", "HEAD", "refs/heads/main")

		const commitSize = await sizeOf(db.sql, "git_commit")
		const tagSize = await sizeOf(db.sql, "git_tag")
		const obj = await sizeOf(db.sql, "git_object")
		const [c] = await db.sql<{ n: string }[]>`select count(*)::text as n from git_commit`
		const [o] = await db.sql<{ n: string }[]>`select count(*)::text as n from git_object`
		const [t] = await db.sql<{ n: string }[]>`select count(*)::text as n from git_tag`
		const [edge] = await db.sql<{ n: string }[]>`
			select count(*)::text as n from information_schema.tables
			where table_schema = ${db.schema} and table_name = 'git_edge'`
		if (!c || !o || !t || !edge) throw new Error("topology census returned no row")
		if (
			Number(c.n) !== commits + 1 ||
			Number(o.n) !== objects.length ||
			Number(t.n) !== 0
		) {
			throw new Error(
				`topology prerequisite mismatch: commits=${c.n}/${commits + 1}, objects=${o.n}/${objects.length}, tags=${t.n}/0`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, "r/topology", {
			encodings: { kind: "unchecked" },
			objects,
			refs: await canonicalStoreRefsOf(src),
		})
		return {
			commitRows: Number(c.n),
			commits,
			edgeTableExists: Number(edge.n) > 0,
			objects: objects.length,
			objTotal: obj.total,
			packBytes,
			topoTotal: commitSize.total + tagSize.total,
		}
	} finally {
		await db.drop()
	}
}

/** log-log slope of the last two points: the growth exponent. */
function exponent(a: Point, b: Point, pick: (p: Point) => number): number {
	const va = pick(a)
	const vb = pick(b)
	if (va <= 0 || vb <= 0 || a.commits <= 0 || b.commits <= a.commits) {
		throw new Error(`invalid exponent inputs: ${a.commits}/${va} -> ${b.commits}/${vb}`)
	}
	return Math.log(vb / va) / Math.log(b.commits / a.commits)
}

async function main(): Promise<void> {
	const scratch = scratchRoot("topology")
	try {
		console.log(`# topology-surface growth against the packfile for the same history\n`)
		console.log(
			`Shape: an append-only \`.engine/runs/planner-updates/\` directory gaining one\n` +
				`run-uuid subdirectory per commit — the shape that grew \`git_edge\` as N²/2\n` +
				`before spine S2 dropped it. The topology surface is now one \`git_commit\`\n` +
				`row per commit (+ \`git_tag\` per annotated tag): linear by construction,\n` +
				`asserted here so it stays that way.\n`,
		)

		const points: Point[] = []
		for (const n of LENGTHS) points.push(await measure(n, scratch))

		console.log(
			`${padr("commits", 9)} ${pad("objects", 8)} ${pad("commit rows", 12)} ${pad("rows/commit", 12)} ` +
				`${pad("topo MB", 9)} ${pad("object MB", 10)} ${pad("git pack MB", 12)} ${pad("topo/pack", 10)}`,
		)
		for (const p of points) {
			console.log(
				`${padr(p.commits, 9)} ${pad(p.objects, 8)} ${pad(p.commitRows, 12)} ` +
					`${pad((p.commitRows / p.commits).toFixed(2), 12)} ${pad(mb(p.topoTotal), 9)} ` +
					`${pad(mb(p.objTotal), 10)} ${pad(mb(p.packBytes), 12)} ` +
					`${pad((p.topoTotal / p.packBytes).toFixed(2), 10)}`,
			)
		}

		const last = requiredAt(points, points.length - 1, "largest topology measurement")
		const prev = requiredAt(points, points.length - 2, "previous topology measurement")
		const expRows = exponent(prev, last, (p) => p.commitRows)
		const expBytes = exponent(prev, last, (p) => p.topoTotal)
		const expPack = exponent(prev, last, (p) => p.packBytes)
		console.log(
			`\ngrowth exponents over the last doubling (1.0 = linear in history, 2.0 = quadratic):\n` +
				`  git_commit rows      ${expRows.toFixed(2)}\n` +
				`  topology bytes       ${expBytes.toFixed(2)}\n` +
				`  git packfile         ${expPack.toFixed(2)}`,
		)

		console.log(
			`\nheadline: ${last.commits} commits of this shape cost the topology surface ` +
				`${mb(last.topoTotal)} MB (one row per commit) where pre-S2 \`git_edge\` paid ` +
				`quadratically; git's packfile for the same history is ${mb(last.packBytes)} MB.`,
		)

		if (points.some((p) => p.edgeTableExists)) {
			console.log(
				`\nFAIL: a git_edge table exists — the dropped quadratic surface is back.`,
			)
			process.exitCode = 1
		}
		if (expBytes > EXPONENT_LIMIT) {
			console.log(
				`\nFAIL: topology bytes grew super-linearly (exponent ${expBytes.toFixed(2)} > ${EXPONENT_LIMIT}).`,
			)
			process.exitCode = 1
		}
	} finally {
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

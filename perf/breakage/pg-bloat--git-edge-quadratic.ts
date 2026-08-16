/**
 * pg-bloat--git-edge-quadratic — the growth curve of the DAG index, measured
 * against the packfile for the same history.
 *
 * `git_edge` stores kind-3 (tree→subtree) rows for every subdirectory of every
 * version of every tree. On an append-only directory — one new subdirectory per
 * commit, which is exactly the shape pggit's motivating tenant produces — the Nth
 * commit's version of that directory holds N subdirectories, so commit N writes N
 * edge rows and the table grows as N²/2. Git pays nothing comparable: its packfile
 * stores each tree version once, delta-compressed against its predecessor, so the
 * same growth costs it a few bytes per commit.
 *
 * The delta-pack work made the SERVED bytes small and left this untouched (design
 * W5). This harness turns "quadratic" from an adjective into a curve: rows, heap
 * bytes and index bytes per history length, beside git's packfile for the same
 * objects, with the per-commit marginal cost that makes the exponent visible.
 *
 * It also decomposes the table, because the shape of the cost decides the fix:
 * rows by edge kind, and heap versus the `git_edge_walk` covering index (which
 * duplicates every column of the row it indexes, so it costs MORE than the heap).
 *
 * EXIT NON-ZERO when the measured growth exponent exceeds `EXPONENT_LIMIT` — i.e.
 * the table is super-linear in history length, so doubling a repo's age more than
 * doubles this table.
 *
 *   npx tsx perf/breakage/pg-bloat--git-edge-quadratic.ts --lengths=100,200,400,800,1600
 */
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	COMMITTER,
	DEFAULT_PG_URL,
	duBytes,
	filler,
	flag,
	mb,
	pad,
	padr,
	rawIndexSizes,
	reachableObjects,
	runDirName,
	scratchRoot,
	sizeOf,
} from "./_pg-bloat-util"

/** growth exponent (log-log slope) above which the table is super-linear */
const EXPONENT_LIMIT = 1.35

const PG_URL = flag("pg", DEFAULT_PG_URL)
const LENGTHS = flag("lengths", "100,200,400,800,1600").split(",").map(Number)

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
		const m = blob(`# doc ${i}\n${filler(`doc-${i}`, 800)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	for (let i = 0; i < commits; i++) {
		const dir = runDirName("edge", i)
		const record = blob(`{"run":"${dir}","p":"${filler(`rec-${i}`, 700)}"}\n`)
		const stderr = blob(`${filler(`err-${i}`, 200)}\n`)
		const cm = next()
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata 3\nrun\nfrom :${prev}\n` +
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
	edgeRows: number
	edgeHeap: number
	edgeIdx: number
	edgeTotal: number
	objTotal: number
	packBytes: number
	kinds: Record<number, number>
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
	const packBytes = await duBytes(gcDir)

	const objects = await reachableObjects(src)
	const db = await createIsolatedSchema(PG_URL)
	try {
		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		let batch: typeof objects = []
		let bytes = 0
		const flush = async () => {
			if (batch.length === 0) return
			await store.putPack(
				"r/edge",
				batch.map((o) => ({ content: o.content, type: o.type })),
			)
			batch = []
			bytes = 0
		}
		for (const o of objects) {
			batch.push(o)
			bytes += o.content.length
			if (bytes >= 16_000_000) await flush()
		}
		await flush()
		const tip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: src })
		).stdout.trim()
		await refs.setRef("r/edge", "refs/heads/main", tip)

		const edge = await sizeOf(db.sql, "git_edge")
		const obj = await sizeOf(db.sql, "git_object")
		const [c] = await db.sql<{ n: string }[]>`select count(*)::text as n from git_edge`
		const kindRows = await db.sql<{ kind: number; n: string }[]>`
			select kind, count(*)::text as n from git_edge group by kind order by kind`
		const kinds: Record<number, number> = {}
		for (const k of kindRows) kinds[k.kind] = Number(k.n)
		return {
			commits,
			edgeHeap: edge.heap,
			edgeIdx: edge.indexes,
			edgeRows: Number(c?.n ?? 0),
			edgeTotal: edge.total,
			kinds,
			objects: objects.length,
			objTotal: obj.total,
			packBytes,
		}
	} finally {
		await db.drop()
	}
}

/** log-log slope of the last two points: the growth exponent. */
function exponent(a: Point, b: Point, pick: (p: Point) => number): number {
	const va = pick(a)
	const vb = pick(b)
	if (va <= 0 || vb <= 0 || a.commits <= 0 || b.commits <= 0) return 0
	return Math.log(vb / va) / Math.log(b.commits / a.commits)
}

async function main(): Promise<void> {
	const scratch = scratchRoot("edge")
	try {
		console.log(`# \`git_edge\` growth against the packfile for the same history\n`)
		console.log(
			`Shape: an append-only \`.engine/runs/planner-updates/\` directory gaining one\n` +
				`run-uuid subdirectory per commit — the tenant shape the delta-pack work was\n` +
				`built for. Each commit rewrites that directory's tree, and every version's\n` +
				`entire subdirectory list is re-emitted as kind-3 rows.\n`,
		)

		const points: Point[] = []
		for (const n of LENGTHS) points.push(await measure(n, scratch))

		console.log(
			`${padr("commits", 9)} ${pad("objects", 8)} ${pad("edge rows", 11)} ${pad("rows/commit", 12)} ` +
				`${pad("heap MB", 9)} ${pad("index MB", 9)} ${pad("edge MB", 9)} ${pad("object MB", 10)} ` +
				`${pad("git pack MB", 12)} ${pad("edge/pack", 10)}`,
		)
		for (const p of points) {
			console.log(
				`${padr(p.commits, 9)} ${pad(p.objects, 8)} ${pad(p.edgeRows, 11)} ${pad((p.edgeRows / p.commits).toFixed(1), 12)} ` +
					`${pad(mb(p.edgeHeap), 9)} ${pad(mb(p.edgeIdx), 9)} ${pad(mb(p.edgeTotal), 9)} ${pad(mb(p.objTotal), 10)} ` +
					`${pad(mb(p.packBytes), 12)} ${pad((p.edgeTotal / Math.max(p.packBytes, 1)).toFixed(1), 10)}`,
			)
		}

		console.log(`\n## marginal cost of the Nth commit\n`)
		console.log(
			`${padr("range", 16)} ${pad("edge rows added", 16)} ${pad("per commit", 11)} ${pad("edge MB added", 14)} ` +
				`${pad("kB/commit", 10)} ${pad("pack kB/commit", 15)}`,
		)
		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1] as Point
			const b = points[i] as Point
			const dc = b.commits - a.commits
			console.log(
				`${padr(`${a.commits}→${b.commits}`, 16)} ${pad(b.edgeRows - a.edgeRows, 16)} ` +
					`${pad(((b.edgeRows - a.edgeRows) / dc).toFixed(1), 11)} ${pad(mb(b.edgeTotal - a.edgeTotal), 14)} ` +
					`${pad(((b.edgeTotal - a.edgeTotal) / dc / 1000).toFixed(2), 10)} ` +
					`${pad(((b.packBytes - a.packBytes) / dc / 1000).toFixed(2), 15)}`,
			)
		}

		const last = points[points.length - 1] as Point
		const prev = points[points.length - 2] as Point
		const expRows = exponent(prev, last, (p) => p.edgeRows)
		const expBytes = exponent(prev, last, (p) => p.edgeTotal)
		const expPack = exponent(prev, last, (p) => p.packBytes)
		console.log(
			`\ngrowth exponents over the last doubling (1.0 = linear in history, 2.0 = quadratic):\n` +
				`  git_edge rows   ${expRows.toFixed(2)}\n` +
				`  git_edge bytes  ${expBytes.toFixed(2)}\n` +
				`  git packfile    ${expPack.toFixed(2)}`,
		)

		console.log(`\n## what the rows are, and where the bytes sit\n`)
		const kindName: Record<number, string> = {
			1: "commit→tree",
			2: "commit→parent",
			3: "tree→subtree",
			5: "tag→target",
		}
		for (const [k, n] of Object.entries(last.kinds)) {
			console.log(
				`  kind ${k} (${kindName[Number(k)] ?? "?"}): ${pad(n, 9)} rows ` +
					`= ${((n / last.edgeRows) * 100).toFixed(1)}% of the table`,
			)
		}

		// The covering index duplicates every column of the row it indexes.
		const db = await createIsolatedSchema(PG_URL)
		try {
			const idx = await rawIndexSizes(db.sql, "git_edge")
			console.log(
				`\nindexes on git_edge: ${idx.length} physical relations per 16 partitions ` +
					`(${[...new Set(idx.map((i) => i.name.replace(/_p\d+.*/, "")))].join(", ")}).`,
			)
		} finally {
			await db.drop()
		}
		console.log(
			`at ${last.commits} commits the index side is ${mb(last.edgeIdx)} MB against ${mb(last.edgeHeap)} MB of heap ` +
				`(${((last.edgeIdx / last.edgeTotal) * 100).toFixed(0)}% of the table): the PK is (repo_id, parent, child)\n` +
				`and \`git_edge_walk\` is (repo_id, parent) INCLUDE (child, kind) — between them every column\n` +
				`of every row is stored three times.`,
		)
		console.log(
			`\nheadline: ${last.commits} commits of this shape cost git ${mb(last.packBytes)} MB and cost ` +
				`\`git_edge\` alone ${mb(last.edgeTotal)} MB — ` +
				`${(last.edgeTotal / Math.max(last.packBytes, 1)).toFixed(0)}×, and the ratio grows with history.`,
		)
		if (expBytes > EXPONENT_LIMIT) process.exitCode = 1
	} finally {
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

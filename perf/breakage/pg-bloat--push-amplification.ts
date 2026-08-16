/**
 * pg-bloat--push-amplification — what one push costs pggit versus what it costs
 * git, as a function of tree SHAPE.
 *
 * A git push writes, on disk, roughly the deflated bytes of the objects it
 * carries. pggit writes those objects as rows, plus a `git_edge` row per
 * structural reference, plus a full rewrite of the `repo_file` projection for the
 * branch, plus the WAL for all of it, plus (on the next drain) an encoding row
 * per object. This harness measures the ratio on identical pushes, over tree
 * shapes chosen to separate the three cost drivers:
 *
 *   - **depth D** — a commit touching one file rewrites D+1 trees.
 *   - **width W** — a rewritten tree costs its whole entry list again, and emits
 *     one `git_edge` kind-3 row per SUBDIRECTORY it holds.
 *   - **files F** — how many leaves the commit touches.
 *
 * The pathological point is the wide-flat directory: W large, D small. Git pays
 * it too (git also rewrites the whole tree object) — so the interesting number is
 * not that pggit is expensive there, it is the RATIO, which isolates what
 * Postgres adds on top of git's own cost.
 *
 * The `repo_file` projection is the amplifier nobody sees: it is deleted and
 * re-inserted IN FULL for the pushed branch on every push, so a one-file commit
 * to an N-file tree writes N rows and deletes N rows regardless of F.
 *
 * WHAT IT PRINTS, per shape and per F: rows written per table, bytes on disk per
 * table, WAL bytes, and the same push's cost in a bare git repo (`du` delta),
 * with the amplification ratios.
 *
 * EXIT NON-ZERO when the `repo_file` rows written by a one-file commit exceed
 * `AMP_LIMIT`× the number of files the commit actually changed — the projection's
 * rewrite-everything contract turning an O(F) push into an O(N) write.
 *
 *   npx tsx perf/breakage/pg-bloat--push-amplification.ts
 */
import { syncRefSnapshot } from "@/repo-view/rebuild"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	backendWal,
	COMMITTER,
	DEFAULT_PG_URL,
	duBytes,
	filler,
	flag,
	flushStats,
	kb,
	objectsBetween,
	pad,
	padr,
	scratchRoot,
	sizesAll,
	TABLES,
	taggedPool,
	walBytes,
} from "./_pg-bloat-util"

/**
 * The pushes under test run on their own tagged pool: `pg_current_wal_lsn()` is
 * cluster-wide (it counts every other tenant of this Postgres), so the honest WAL
 * number is the per-backend one summed over exactly these connections (PG 18's
 * `pg_stat_get_backend_wal`). Both are printed — their gap is the noise floor.
 */
const PUSH_APP = "pgbloat-push-under-test"

/** rows the projection may write per file actually changed, before it is a defect */
const AMP_LIMIT = 50

const PG_URL = flag("pg", DEFAULT_PG_URL)

type Shape = { name: string; files: number; depth: number; width: number }

const SHAPES: Shape[] = [
	{ depth: 0, files: 4096, name: "wide-flat", width: 4096 },
	{ depth: 1, files: 4096, name: "d1-w64", width: 64 },
	{ depth: 2, files: 4096, name: "d2-w16", width: 16 },
	{ depth: 6, files: 4096, name: "deep-narrow", width: 4 },
]
const TOUCH = [1, 16]

/** file `i`'s path: `depth` nested dirs of `width` fanout, then the file. */
function filePath(i: number, s: Shape): string {
	const parts: string[] = []
	let n = i
	for (let d = 0; d < s.depth; d++) {
		parts.push(`d${n % s.width}`)
		n = Math.floor(n / s.width)
	}
	parts.push(`f${i}.md`)
	return parts.join("/")
}

function baseStream(s: Shape): string {
	const out: string[] = []
	let mark = 0
	const lines: string[] = []
	for (let i = 0; i < s.files; i++) {
		const content = `# f${i}\n${filler(`${s.name}-f${i}-v0`, 400)}\n`
		const m = ++mark
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		lines.push(`M 100644 :${m} ${filePath(i, s)}`)
	}
	const cm = ++mark
	out.push(
		`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata 4\nbase\n${lines.join("\n")}\n`,
	)
	return out.join("")
}

/** One follow-up commit touching `n` files, spread so it hits `n` distinct leaf dirs. */
function touchStream(
	s: Shape,
	n: number,
	gen: number,
): { stream: string; bytes: number } {
	const out: string[] = []
	let mark = 0
	const lines: string[] = []
	let bytes = 0
	const stride = Math.max(1, Math.floor(s.files / n))
	for (let k = 0; k < n; k++) {
		const i = (k * stride) % s.files
		const content = `# f${i}\n${filler(`${s.name}-f${i}-v${gen}`, 400)}\n`
		bytes += Buffer.byteLength(content)
		const m = ++mark
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		lines.push(`M 100644 :${m} ${filePath(i, s)}`)
	}
	const cm = ++mark
	out.push(
		`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata 5\ntouch\nfrom refs/heads/main^0\n${lines.join("\n")}\n`,
	)
	return { bytes, stream: out.join("") }
}

async function main(): Promise<void> {
	const scratch = scratchRoot("amp")
	console.log(`# Per-push amplification: pggit rows/bytes vs git bytes, by tree shape\n`)
	console.log(
		`Each row is ONE commit pushed on top of an identical 4096-file base tree.\n` +
			`"git" is the byte delta of a bare repo receiving the same push (packed).\n`,
	)

	let failures = 0
	const table: string[] = []
	const breakdown: string[] = [
		`${padr("shape / F", 20)} ${pad("object kB", 10)} ${pad("edge kB", 10)} ${pad("encode kB", 10)} ` +
			`${pad("file kB", 10)} ${pad("ref+repo kB", 10)} ${pad("total kB", 10)}`,
	]
	table.push(
		`${padr("shape", 13)} ${padr("D", 3)} ${pad("W", 5)} ${pad("F", 3)} ${pad("content kB", 11)} ` +
			`${pad("git kB", 8)} ${pad("obj rows", 9)} ${pad("edge rows", 10)} ${pad("file rows", 10)} ` +
			`${pad("enc rows", 9)} ${pad("pg kB", 8)} ${pad("ownWAL kB", 9)} ${pad("clusWAL kB", 9)} ` +
			`${pad("pg/git", 7)} ${pad("WAL/git", 8)}`,
	)

	for (const s of SHAPES) {
		const src = scratch.dir(`src-${s.name}`)
		await spawnGit(["init", "-q", "-b", "main", src])
		await spawnGit(["fast-import", "--quiet"], { cwd: src, input: baseStream(s) })

		for (const [idx, F] of TOUCH.entries()) {
			// ── git's own cost for this push ──────────────────────────────────
			const bare = scratch.dir(`bare-${s.name}-${F}`)
			await spawnGit(["init", "-q", "--bare", bare])
			await spawnGit(["push", "-q", bare, "refs/heads/main:refs/heads/main"], {
				cwd: src,
			})
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: bare })
			const gitBefore = await duBytes(bare)
			const baseTip = (
				await spawnGit(["rev-parse", "refs/heads/main"], { cwd: src })
			).stdout.trim()

			const touch = touchStream(s, F, idx + 1)
			await spawnGit(["fast-import", "--quiet"], { cwd: src, input: touch.stream })
			const newTip = (
				await spawnGit(["rev-parse", "refs/heads/main"], { cwd: src })
			).stdout.trim()
			await spawnGit(["push", "-q", bare, "refs/heads/main:refs/heads/main"], {
				cwd: src,
			})
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: bare })
			const gitBytes = (await duBytes(bare)) - gitBefore

			// ── pggit's cost for the same push ────────────────────────────────
			const db = await createIsolatedSchema(PG_URL)
			const app = taggedPool(PG_URL, db.schema, PUSH_APP)
			try {
				const store = createObjectStore(app)
				const refs = createRefStore(app)
				const snapshots = createRepoFileProjection(app)
				const deps = { objects: store, snapshots }
				const repoId = `bench/${s.name}/${F}`

				const baseObjs = await objectsBetween(src, baseTip)
				await store.putPack(
					repoId,
					baseObjs.map((o) => ({ content: o.content, type: o.type })),
				)
				await refs.setRef(repoId, "refs/heads/main", baseTip)
				await syncRefSnapshot(deps, repoId, "refs/heads/main", baseTip)
				await createRepack(app).repack(repoId)

				const before = await sizesAll(db.sql)
				const rowsBefore: Record<string, number> = {}
				for (const t of TABLES) {
					const [c] = await db.sql.unsafe<{ n: string }[]>(
						`select count(*)::text as n from ${t}`,
					)
					rowsBefore[t] = Number(c?.n ?? 0)
				}
				await flushStats(app)
				const [insBefore] = await db.sql<{ n: string }[]>`
					select coalesce(sum(n_tup_ins + n_tup_del),0)::text as n
					from pg_stat_user_tables where schemaname = ${db.schema} and relname like 'repo\\_file%'`
				const wal0 = await walBytes(db.sql)
				const bwal0 = await backendWal(db.sql, PUSH_APP)

				const pushObjs = await objectsBetween(src, newTip, baseTip)
				await store.putPack(
					repoId,
					pushObjs.map((o) => ({ content: o.content, type: o.type })),
				)
				await refs.setRef(repoId, "refs/heads/main", newTip)
				await syncRefSnapshot(deps, repoId, "refs/heads/main", newTip)
				const encRes = await createRepack(app).repack(repoId)

				await flushStats(app)
				const wal = (await walBytes(db.sql)) - wal0
				const bwal = (await backendWal(db.sql, PUSH_APP)) - bwal0
				const after = await sizesAll(db.sql)
				const rowsAfter: Record<string, number> = {}
				for (const t of TABLES) {
					const [c] = await db.sql.unsafe<{ n: string }[]>(
						`select count(*)::text as n from ${t}`,
					)
					rowsAfter[t] = Number(c?.n ?? 0)
				}
				// repo_file NET row count barely moves (delete-all + insert-all), so the
				// honest number is tuples WRITTEN, from the activity counters.
				const [insAfter] = await db.sql<{ n: string }[]>`
					select coalesce(sum(n_tup_ins + n_tup_del),0)::text as n
					from pg_stat_user_tables where schemaname = ${db.schema} and relname like 'repo\\_file%'`
				const fileTouched = Number(insAfter?.n ?? 0) - Number(insBefore?.n ?? 0)

				const delta = (t: string): number =>
					(after[t]?.total ?? 0) - (before[t]?.total ?? 0)
				const pgBytes = TABLES.reduce((n, t) => n + delta(t), 0)
				breakdown.push(
					`${padr(`${s.name} F=${F}`, 20)} ${pad(kb(delta("git_object")), 10)} ${pad(kb(delta("git_edge")), 10)} ` +
						`${pad(kb(delta("git_pack_encoding")), 10)} ${pad(kb(delta("repo_file")), 10)} ` +
						`${pad(kb(delta("git_ref") + delta("repos")), 10)} ${pad(kb(pgBytes), 10)}`,
				)
				const objRows = (rowsAfter.git_object ?? 0) - (rowsBefore.git_object ?? 0)
				const edgeRows = (rowsAfter.git_edge ?? 0) - (rowsBefore.git_edge ?? 0)
				const encRows = encRes.wholes + encRes.deltas

				table.push(
					`${padr(s.name, 13)} ${padr(s.depth, 3)} ${pad(s.width, 5)} ${pad(F, 3)} ` +
						`${pad(kb(touch.bytes), 11)} ${pad(kb(gitBytes), 8)} ${pad(objRows, 9)} ${pad(edgeRows, 10)} ` +
						`${pad(fileTouched, 10)} ${pad(encRows, 9)} ${pad(kb(pgBytes), 8)} ${pad(kb(bwal), 9)} ` +
						`${pad(kb(wal), 9)} ${pad((pgBytes / Math.max(gitBytes, 1)).toFixed(0), 7)} ` +
						`${pad((bwal / Math.max(gitBytes, 1)).toFixed(0), 8)}`,
				)
				if (fileTouched > AMP_LIMIT * F) failures++
			} finally {
				await app.end()
				await db.drop()
			}
		}
	}

	console.log(table.join("\n"))
	console.log(
		`\nlegend: content = new blob bytes the commit introduces · git = bare-repo du delta after gc ·\n` +
			`obj/edge rows = net new rows · file rows = repo_file TUPLES WRITTEN (inserts + deletes) ·\n` +
			`enc rows = encoding rows the repack pass wrote · pg = on-disk delta across all five tables ·\n` +
			`ownWAL = WAL charged to THESE backends (pg_stat_get_backend_wal) · clusWAL = cluster LSN\n` +
			`delta over the same window, which includes every other tenant of this instance.\n` +
			`Ratios use ownWAL. A large clusWAL/ownWAL gap is measurement noise, not pggit's cost.\n`,
	)
	console.log(`## where the bytes go — on-disk delta per table, same pushes\n`)
	console.log(breakdown.join("\n"))
	console.log(
		`\nThe \`file rows\` column is the projection contract: a push is O(tree), never O(changed).\n` +
			`It does not vary with F, and it does not vary with depth — only with total file count.\n` +
			`The breakdown says the same thing in bytes: the git object tables cost what git costs;\n` +
			`the projection is where the order of magnitude is spent.`,
	)
	scratch.cleanup()
	if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

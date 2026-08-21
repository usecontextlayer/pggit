/**
 * pg-bloat/push-amplification — what one push costs pggit versus what it costs
 * git, as a function of tree SHAPE.
 *
 * A git push writes, on disk, roughly the deflated bytes of the objects it
 * carries. pggit writes those objects as rows, plus one `git_commit` row per
 * commit (spine chunk 1 — the old per-reference `git_edge` rows are gone), plus
 * the incremental `repo_file` changes for the branch, plus the WAL for all of it,
 * plus (when repack runs) an encoding row per new object. This harness
 * measures the ratio on identical pushes, over tree shapes chosen to separate
 * the three cost drivers:
 *
 *   - **depth D** — a commit touching one file rewrites D+1 trees.
 *   - **width W** — a rewritten tree costs its whole entry list again.
 *   - **files F** — how many leaves the commit touches.
 *
 * The pathological point is the wide-flat directory: W large, D small. Git pays
 * it too (git also rewrites the whole tree object) — so the interesting number is
 * not that pggit is expensive there, it is the RATIO, which isolates what
 * Postgres adds on top of git's own cost.
 *
 * The derived-state spine replaced the former delete-all/reinsert-all projection
 * with a persisted basis and tree diff. The gate now proves that a push touching
 * F files writes O(F) projection tuples; a retired full rewrite cannot return
 * unnoticed.
 *
 * WHAT IT PRINTS, per shape and per F: rows written per table, bytes on disk per
 * table, WAL bytes, and the same push's cost in a bare git repo (`du` delta),
 * with the amplification ratios.
 *
 * EXIT NON-ZERO when the `repo_file` rows written by a one-file commit exceed
 * `AMP_LIMIT`× the number of files the commit actually changed — evidence that
 * the retired rewrite-everything behavior has returned and turned an O(F) push into an O(N) write.
 *
 *   npx tsx perf/probes/pg-bloat/push-amplification.ts
 */

import { parseArgs, pgUrlArg } from "@perf/args"
import {
	backendWal,
	flushStats,
	kb,
	objectsBetween,
	pad,
	padr,
	requiredCount,
	type Sizes,
	scratchRoot,
	sizesAll,
	TABLES,
	taggedPool,
	walBytes,
} from "@perf/probes/pg-bloat/_util"
import { z } from "zod"
import { syncRefSnapshot } from "@/repo-view/rebuild"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { deterministicFiller, FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import { directoryBytes } from "@/testing/directory-size"
import {
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	repackEligibleObjects,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/**
 * The pushes under test run on their own tagged pool: `pg_current_wal_lsn()` is
 * cluster-wide (it counts every other tenant of this Postgres), so the honest WAL
 * number is the per-backend one summed over exactly these connections (PG 18's
 * `pg_stat_get_backend_wal`). Both are printed — their gap is the noise floor.
 */
const PUSH_APP = "pgbloat-push-under-test"

/** rows the projection may write per file actually changed, before it is a defect */
const AMP_LIMIT = 50

const { pg: PG_URL } = parseArgs(z.object({ pg: pgUrlArg }).strict())

type Shape = { name: string; files: number; depth: number; width: number }

function requiredSize(sizes: Record<string, Sizes>, table: string, phase: string): Sizes {
	const value = sizes[table]
	if (!value) throw new Error(`${phase}: size census omitted ${table}`)
	return value
}

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
		const content = `# f${i}\n${deterministicFiller(`${s.name}-f${i}-v0`, 400)}\n`
		const m = ++mark
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		lines.push(`M 100644 :${m} ${filePath(i, s)}`)
	}
	const cm = ++mark
	out.push(
		`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nbase\n${lines.join("\n")}\n`,
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
		const content = `# f${i}\n${deterministicFiller(`${s.name}-f${i}-v${gen}`, 400)}\n`
		bytes += Buffer.byteLength(content)
		const m = ++mark
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		lines.push(`M 100644 :${m} ${filePath(i, s)}`)
	}
	const cm = ++mark
	out.push(
		`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 5\ntouch\nfrom refs/heads/main^0\n${lines.join("\n")}\n`,
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
		`${padr("shape / F", 20)} ${pad("object kB", 10)} ${pad("topology kB", 10)} ${pad("encode kB", 10)} ` +
			`${pad("file kB", 10)} ${pad("ref+repo kB", 10)} ${pad("total kB", 10)}`,
	]
	table.push(
		`${padr("shape", 13)} ${padr("D", 3)} ${pad("W", 5)} ${pad("F", 3)} ${pad("content kB", 11)} ` +
			`${pad("git kB", 8)} ${pad("obj rows", 9)} ${pad("commit rows", 11)} ${pad("file writes", 11)} ` +
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
			const gitBefore = await directoryBytes(bare)
			const baseTip = await revParse(src, "refs/heads/main")

			const touch = touchStream(s, F, idx + 1)
			await spawnGit(["fast-import", "--quiet"], { cwd: src, input: touch.stream })
			const newTip = await revParse(src, "refs/heads/main")
			await spawnGit(["push", "-q", bare, "refs/heads/main:refs/heads/main"], {
				cwd: src,
			})
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: bare })
			const gitBytes = (await directoryBytes(bare)) - gitBefore

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
				if (baseObjs.length === 0) throw new Error(`${s.name} F=${F}: empty base fixture`)
				const eligibleBaseObjs = repackEligibleObjects(baseObjs)
				await store.putPack(
					repoId,
					baseObjs.map((o) => ({ content: o.content, type: o.type })),
				)
				await refs.setRef(repoId, "refs/heads/main", baseTip)
				await refs.setSymref(repoId, "HEAD", "refs/heads/main")
				await syncRefSnapshot(deps, repoId, "refs/heads/main", baseTip)
				const baseRepack = await createRepack(app).repack(repoId)
				if (baseRepack.wholes + baseRepack.deltas !== eligibleBaseObjs.length) {
					throw new Error(`${s.name} F=${F}: incomplete base repack`)
				}
				await assertCanonicalStoreFixture(app, repoId, {
					encodings: { kind: "exact", objects: eligibleBaseObjs },
					objects: baseObjs,
					refs: [
						{ kind: "direct", name: "refs/heads/main", oid: baseTip },
						{ kind: "symbolic", name: "HEAD", target: "refs/heads/main" },
					],
				})

				const before = await sizesAll(db.sql)
				for (const t of TABLES) requiredSize(before, t, "before push")
				const rowsBefore = new Map<string, number>()
				for (const t of TABLES) {
					const [c] = await db.sql.unsafe<{ n: string }[]>(
						`select count(*)::text as n from ${t}`,
					)
					if (!c) throw new Error(`missing before count for ${t}`)
					rowsBefore.set(t, Number(c.n))
				}
				await flushStats(app)
				const [insBefore] = await db.sql<{ n: string }[]>`
					select coalesce(sum(n_tup_ins + n_tup_del + n_tup_upd),0)::text as n
					from pg_stat_user_tables where schemaname = ${db.schema} and relname like 'repo\\_file%'`
				const wal0 = await walBytes(db.sql)
				const bwal0 = await backendWal(db.sql, PUSH_APP)

				const pushObjs = await objectsBetween(src, newTip, baseTip)
				if (pushObjs.length === 0 || gitBytes <= 0) {
					throw new Error(`${s.name} F=${F}: missing pushed objects/git byte delta`)
				}
				const eligiblePushObjs = repackEligibleObjects(pushObjs)
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
				for (const t of TABLES) requiredSize(after, t, "after push")
				const rowsAfter = new Map<string, number>()
				for (const t of TABLES) {
					const [c] = await db.sql.unsafe<{ n: string }[]>(
						`select count(*)::text as n from ${t}`,
					)
					if (!c) throw new Error(`missing after count for ${t}`)
					rowsAfter.set(t, Number(c.n))
				}
				// Net row counts barely move for updates, so the honest number is tuples
				// WRITTEN, from the activity counters.
				const [insAfter] = await db.sql<{ n: string }[]>`
					select coalesce(sum(n_tup_ins + n_tup_del + n_tup_upd),0)::text as n
					from pg_stat_user_tables where schemaname = ${db.schema} and relname like 'repo\\_file%'`
				if (!insBefore || !insAfter)
					throw new Error("repo_file activity census returned no row")
				const fileTouched = Number(insAfter.n) - Number(insBefore.n)

				const delta = (t: string): number =>
					requiredSize(after, t, "after push").total -
					requiredSize(before, t, "before push").total
				const pgBytes = TABLES.reduce((n, t) => n + delta(t), 0)
				breakdown.push(
					`${padr(`${s.name} F=${F}`, 20)} ${pad(kb(delta("git_object")), 10)} ${pad(kb(delta("git_commit")), 10)} ` +
						`${pad(kb(delta("git_pack_encoding")), 10)} ${pad(kb(delta("repo_file")), 10)} ` +
						`${pad(kb(delta("git_ref") + delta("repos")), 10)} ${pad(kb(pgBytes), 10)}`,
				)
				const objRows =
					requiredCount(rowsAfter, "git_object", "after push") -
					requiredCount(rowsBefore, "git_object", "before push")
				const commitRows =
					requiredCount(rowsAfter, "git_commit", "after push") -
					requiredCount(rowsBefore, "git_commit", "before push")
				const encRows = encRes.wholes + encRes.deltas
				const expectedFinalObjects = await objectsBetween(src, newTip)
				await assertCanonicalStoreFixture(app, repoId, {
					encodings: {
						kind: "exact",
						objects: repackEligibleObjects(expectedFinalObjects),
					},
					objects: expectedFinalObjects,
					refs: await canonicalStoreRefsOf(src),
				})
				if (
					wal <= 0 ||
					bwal <= 0 ||
					objRows !== pushObjs.length ||
					commitRows !== 1 ||
					encRows !== eligiblePushObjs.length ||
					fileTouched !== F
				) {
					throw new Error(
						`${s.name} F=${F}: objects ${objRows}/${pushObjs.length}, commits ${commitRows}/1, encodings ${encRows}/${eligiblePushObjs.length} eligible, projection writes ${fileTouched}/${F}`,
					)
				}

				table.push(
					`${padr(s.name, 13)} ${padr(s.depth, 3)} ${pad(s.width, 5)} ${pad(F, 3)} ` +
						`${pad(kb(touch.bytes), 11)} ${pad(kb(gitBytes), 8)} ${pad(objRows, 9)} ${pad(commitRows, 10)} ` +
						`${pad(fileTouched, 10)} ${pad(encRows, 9)} ${pad(kb(pgBytes), 8)} ${pad(kb(bwal), 9)} ` +
						`${pad(kb(wal), 9)} ${pad((pgBytes / gitBytes).toFixed(0), 7)} ` +
						`${pad((bwal / gitBytes).toFixed(0), 8)}`,
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
			`obj/commit rows = net new rows · file writes = repo_file inserts + deletes + updates ·\n` +
			`enc rows = encoding rows the repack pass wrote · pg = on-disk delta across all seven measured tables ·\n` +
			`ownWAL = WAL charged to THESE backends (pg_stat_get_backend_wal) · clusWAL = cluster LSN\n` +
			`delta over the same window, which includes every other tenant of this instance.\n` +
			`Ratios use ownWAL. A large clusWAL/ownWAL gap is measurement noise, not pggit's cost.\n`,
	)
	console.log(`## where the bytes go — on-disk delta per table, same pushes\n`)
	console.log(breakdown.join("\n"))
	console.log(
		`\nThe \`file writes\` column is the incremental projection contract: one changed file\n` +
			`produces one row change. It scales with F, not with the branch's total file count.`,
	)
	scratch.cleanup()
	if (failures > 0) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

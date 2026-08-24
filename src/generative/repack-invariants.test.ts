import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { assertNever } from "@/lang"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import {
	deterministicFiller,
	FAST_IMPORT_COMMITTER,
	uuidFromSeed,
} from "@/testing/append-only-repo"
import { cyclicAt, mirrorClone } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

const REPO = "workspace/probe/repack-invariants"
const REFSPEC = "refs/heads/*:refs/heads/*"

/** The directories the edit commands target. `runs/` is the WIDE one (the seed
 * commit fills it), so its successive tree versions are what the delta tier
 * encodes; `docs/` is narrow; `deep/x/y/` starts empty and only `deepPath` fills it. */
const DIRS = ["runs", "docs", "deep/x/y"] as const
/** Entries the seed commit lays into `runs/` — enough that a one-entry edit's delta
 * beats the whole form (a ~30-entry tree is ~2.5 KB; the delta is a few dozen bytes). */
const SEED_WIDTH = 30

// ── the generated edit language ─────────────────────────────────────────────
// Every command carries its own parameters; indices wrap into the model's live
// path list, so a shrunk sequence stays replayable (the `cyclicAt` discipline from
// generative/commands.ts).

type Edit =
	| { kind: "append"; dir: number }
	| { kind: "rewrite"; idx: number }
	| { kind: "delete"; idx: number }
	| { kind: "modeSwap"; idx: number; mode: number }
	| { kind: "fileToDir"; idx: number }
	| { kind: "widenDir"; dir: number; count: number }
	| { kind: "deepPath"; depth: number }
	| { kind: "orphanRoot" }
	| { kind: "moveBack"; steps: number }

const editArb: fc.Arbitrary<Edit> = fc.oneof(
	// Weighted toward the edits that produce successive versions of one tree — the
	// lineage the delta encoder walks. The rarer shapes (orphan root, force-move
	// back) stay reachable but do not dominate.
	{
		arbitrary: fc.record({
			dir: fc.nat(),
			kind: fc.constant<"append">("append"),
		}),
		weight: 4,
	},
	{
		arbitrary: fc.record({ idx: fc.nat(), kind: fc.constant<"rewrite">("rewrite") }),
		weight: 3,
	},
	{
		arbitrary: fc.record({ idx: fc.nat(), kind: fc.constant<"delete">("delete") }),
		weight: 2,
	},
	{
		arbitrary: fc.record({
			idx: fc.nat(),
			kind: fc.constant<"modeSwap">("modeSwap"),
			mode: fc.nat(),
		}),
		weight: 2,
	},
	{
		arbitrary: fc.record({ idx: fc.nat(), kind: fc.constant<"fileToDir">("fileToDir") }),
		weight: 1,
	},
	{
		arbitrary: fc.record({
			count: fc.integer({ max: 6, min: 2 }),
			dir: fc.nat(),
			kind: fc.constant<"widenDir">("widenDir"),
		}),
		weight: 2,
	},
	{
		arbitrary: fc.record({
			depth: fc.integer({ max: 5, min: 1 }),
			kind: fc.constant<"deepPath">("deepPath"),
		}),
		weight: 1,
	},
	{ arbitrary: fc.constant<Edit>({ kind: "orphanRoot" }), weight: 1 },
	{
		arbitrary: fc.record({ kind: fc.constant<"moveBack">("moveBack"), steps: fc.nat() }),
		weight: 1,
	},
)

/** Which of the rarer shapes a candidate actually realized — floored after the run
 * so a generator regression cannot silently empty the corpus (GAP-3 discipline). */
type Shape = {
	modeSwap: boolean
	fileToDir: boolean
	orphanRoot: boolean
	moveBack: boolean
	symlink: boolean
}

type Entry = { mode: string; content: string }
/** One committed state of `refs/heads/main`: its fast-import mark and its tree. */
type Snapshot = { mark: number; files: Map<string, Entry> }

/**
 * Replay an edit sequence into a real repo through ONE `fast-import` stream, and
 * report which shapes it realized. The model tracks the tree of `refs/heads/main`
 * so every emitted command is valid (no rewrite of an absent path, no mode swap to
 * the mode it already has) — invalid draws are skipped silently, exactly like
 * `generative/commands.ts`, and the floors below are what keep that honest.
 */
async function buildRepo(dir: string, edits: Edit[]): Promise<Shape> {
	const stream: string[] = []
	const files = new Map<string, Entry>()
	const history: Snapshot[] = []
	const shape: Shape = {
		fileToDir: false,
		modeSwap: false,
		moveBack: false,
		orphanRoot: false,
		symlink: false,
	}
	let mark = 0
	let seq = 0
	let orphans = 0

	const blob = (content: string): number => {
		const m = ++mark
		stream.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return m
	}
	/** Emit one commit; `from` is null only for an orphan root. */
	const commit = (branch: string, from: number | null, ops: string[]): number => {
		const m = ++mark
		const msg = `c${seq++}` // unique per commit: the clock is pinned, the message is not
		stream.push(
			`commit refs/heads/${branch}\nmark :${m}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${msg.length}\n${msg}\n` +
				(from === null ? "" : `from :${from}\n`) +
				`${ops.join("\n")}\n`,
		)
		return m
	}
	/** Commit `ops` onto main and snapshot the resulting tree. */
	const commitMain = (ops: string[]): void => {
		if (ops.length === 0) return
		const tip = history.at(-1)
		const m = commit("main", tip === undefined ? null : tip.mark, ops)
		history.push({ files: new Map(files), mark: m })
	}
	/** Write one entry (creating or replacing it) and return the fast-import op. */
	const write = (path: string, mode: string, content: string): string => {
		files.set(path, { content, mode })
		return `M ${mode} :${blob(content)} ${path}`
	}
	/** Live paths in a stable order — the index space the edit commands address. */
	const paths = (): string[] => [...files.keys()].sort()

	// The seed commit: a WIDE directory (where deltas win) plus a few docs.
	const seedOps = [
		...Array.from({ length: SEED_WIDTH }, (_, i) =>
			write(`runs/${uuidFromSeed(`seed-${i}`)}.json`, "100644", `{"run":${i}}\n`),
		),
		...Array.from({ length: 4 }, (_, i) =>
			write(
				`docs/doc-${i}.md`,
				"100644",
				`# doc ${i}\n\n${deterministicFiller(`doc-${i}`, 400)}\n`,
			),
		),
	]
	commitMain(seedOps)

	for (const edit of edits) {
		const live = paths()
		switch (edit.kind) {
			case "append": {
				const path = `${cyclicAt(DIRS, edit.dir)}/${uuidFromSeed(`a-${seq}-${mark}`)}.json`
				if (files.has(path)) break
				commitMain([
					write(
						path,
						"100644",
						`{"payload":"${deterministicFiller(`a-${seq}`, 200)}"}\n`,
					),
				])
				break
			}
			case "rewrite": {
				if (live.length === 0) break
				const path = cyclicAt(live, edit.idx)
				const entry = files.get(path)
				if (entry === undefined)
					throw new Error(`rewrite: live path missing from model: ${path}`)
				commitMain([
					write(
						path,
						entry.mode,
						`${entry.content}${deterministicFiller(`r-${seq}`, 64)}\n`,
					),
				])
				break
			}
			case "delete": {
				if (live.length === 0) break
				const path = cyclicAt(live, edit.idx)
				files.delete(path)
				commitMain([`D ${path}`])
				break
			}
			case "modeSwap": {
				if (live.length === 0) break
				const path = cyclicAt(live, edit.idx)
				const entry = files.get(path)
				if (entry === undefined)
					throw new Error(`modeSwap: live path missing from model: ${path}`)
				const mode = cyclicAt(["100644", "100755", "120000"], edit.mode)
				if (mode === entry.mode) break
				// A symlink blob IS its target path; swapping back leaves that text as
				// ordinary file content, which is exactly what git does.
				const content = mode === "120000" ? `docs/doc-0.md` : entry.content
				shape.modeSwap = true
				if (mode === "120000") shape.symlink = true
				commitMain([write(path, mode, content)])
				break
			}
			case "fileToDir": {
				if (live.length === 0) break
				const path = cyclicAt(live, edit.idx)
				if (!files.has(path))
					throw new Error(`fileToDir: live path missing from model: ${path}`)
				// blob → tree at the SAME name: the tree-diff pairing that repack must
				// refuse to delta across (a tree paired with a blob is not a lineage).
				files.delete(path)
				shape.fileToDir = true
				commitMain([
					`D ${path}`,
					write(`${path}/inner.json`, "100644", `{"was":"file"}\n`),
				])
				break
			}
			case "widenDir": {
				const dir = cyclicAt(DIRS, edit.dir)
				const ops = Array.from({ length: edit.count }, (_, i) =>
					write(
						`${dir}/${uuidFromSeed(`w-${seq}-${mark}-${i}`)}.json`,
						"100644",
						`{"w":${i}}\n`,
					),
				)
				commitMain(ops)
				break
			}
			case "deepPath": {
				const segments = Array.from({ length: edit.depth }, (_, i) => `n${i}`).join("/")
				const path = `deep/${segments}/${uuidFromSeed(`d-${seq}-${mark}`)}.json`
				if (files.has(path)) break
				commitMain([write(path, "100644", `{"deep":${edit.depth}}\n`)])
				break
			}
			case "orphanRoot": {
				// A root commit on its own branch: no first parent, so its whole tree
				// enters repack's phase-2 sweep rather than any lineage.
				// The orphan's own tree is not main's, so `files` (which models main)
				// is deliberately left alone.
				const branch = `orphan${orphans++}`
				const op = `M 100644 :${blob(`{"orphan":"${branch}"}\n`)} ${branch}/root.json`
				shape.orphanRoot = true
				commit(branch, null, [op])
				break
			}
			case "moveBack": {
				// Force the branch back onto an ancestor: the commits after it become
				// unreachable and are never pushed, and the next commit re-diverges from
				// the older tree — a force-push history, without a non-FF wire push.
				if (history.length < 2) break
				const target = cyclicAt(history.slice(0, -1), edit.steps)
				const idx = history.indexOf(target)
				history.length = idx + 1
				files.clear()
				for (const [path, entry] of target.files) files.set(path, entry)
				shape.moveBack = true
				stream.push(`reset refs/heads/main\nfrom :${target.mark}\n`)
				break
			}
			default:
				assertNever(edit)
		}
	}

	await spawnGit(["init", "-q", "-b", "main", dir])
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: stream.join("") })
	return shape
}

/** The tier's whole shape: one row per encoded object, with its base (null = whole). */
async function encodingRows(
	db: IsolatedDb,
): Promise<{ oid: string; base: string | null }[]> {
	return db.sql<{ oid: string; base: string | null }[]>`
		select encode(oid,'hex') as oid, encode(base_oid,'hex') as base from git_pack_encoding`
}

/** Coverage counts over the one repo this schema holds. */
async function coverage(db: IsolatedDb): Promise<{
	objects: number
	encodings: number
	uncovered: number
}> {
	const [row] = await db.sql<{ objects: number; encodings: number; uncovered: number }[]>`
		select
			(select count(*) from git_object)::int as objects,
			(select count(*) from git_pack_encoding)::int as encodings,
			(select count(*) from git_object o where not exists (
				select 1 from git_pack_encoding e where e.repo_id = o.repo_id and e.oid = o.oid
			))::int as uncovered`
	if (!row) throw new Error("coverage query returned no row")
	return row
}

/** I1–I3 as a list of violations, read from the topology alone. */
function topologyViolations(rows: { oid: string; base: string | null }[]): string[] {
	const base = new Map(rows.map((r) => [r.oid, r.base]))
	const bad: string[] = []
	for (const row of rows) {
		if (row.base === null) continue
		if (row.base === row.oid) bad.push(`self-delta ${row.oid}`)
		const baseOfBase = base.get(row.base)
		if (baseOfBase === undefined)
			bad.push(`${row.oid}: base ${row.base} has no encoding row`)
		else if (baseOfBase !== null)
			bad.push(`${row.oid}: base ${row.base} is ITSELF a delta`)
	}
	return bad
}

/**
 * Corpus floors — each is what the pinned seed (424_242) MEASURABLY realizes at
 * `NUM_RUNS`, so they are deterministic; a broader run only exceeds them.
 * `deltaRows` is the load-bearing one: with zero delta rows the star-topology
 * claim holds vacuously and a repack that only ever wrote whole encodings would
 * satisfy every other assertion here.
 */
const FLOORS = {
	deltaRows: {
		floor: 378,
		why: "repack emitted no DELTA — the topology claim is vacuous",
	},
	fileToDir: { floor: 11, why: "no candidate replaced a blob with a tree at one name" },
	modeSwap: { floor: 11, why: "no candidate swapped an entry's mode" },
	moveBack: { floor: 11, why: "no candidate forced the branch back onto an ancestor" },
	orphanRoot: { floor: 10, why: "no candidate added an orphan root commit" },
	symlink: { floor: 8, why: "no candidate produced a symlink entry" },
} as const

const NUM_RUNS = 12

describe("§8.4 generative — repack invariants over random edit sequences", () => {
	it("covers every object, keeps depth ≤ 1, converges, and stays invisible", async () => {
		const baseUrl = inject("pgBaseUrl")
		const realized = {
			deltaRows: 0,
			fileToDir: 0,
			modeSwap: 0,
			moveBack: 0,
			orphanRoot: 0,
			symlink: 0,
		}

		await fc.assert(
			fc.asyncProperty(
				fc.array(editArb, { maxLength: 60, minLength: 20 }),
				async (edits) => {
					await withTempDir("pggit-repack-inv-", async (root) => {
						const src = join(root, "src")
						const control = join(root, "control.git")
						const isolated = await createIsolatedSchema(baseUrl)
						let server: GitServer | undefined
						try {
							const shape = await buildRepo(src, edits)
							if (shape.fileToDir) realized.fileToDir++
							if (shape.modeSwap) realized.modeSwap++
							if (shape.moveBack) realized.moveBack++
							if (shape.orphanRoot) realized.orphanRoot++
							if (shape.symlink) realized.symlink++

							// The control: a plain bare remote holding the SAME history, which is
							// what "invisible" is measured against.
							await spawnGit(["init", "-q", "--bare", "-b", "main", control])
							await spawnGit(["push", "-q", control, REFSPEC], { cwd: src })

							server = await serveOnPort(createGitApp(createGitDeps(isolated.sql)), 0)
							const url = `http://127.0.0.1:${server.port}/${REPO}`
							await spawnGit(["push", "-q", url, REFSPEC], { cwd: src })

							const repack = createRepack(isolated.sql)
							const first = await repack.repack(REPO)
							expect(
								first.wholes + first.deltas,
								"the pass encoded NOTHING — every later claim is vacuous",
							).toBeGreaterThan(0)
							realized.deltaRows += first.deltas

							// 1. Coverage: every object row carries exactly one encoding row.
							const cov = await coverage(isolated)
							expect({ encodings: cov.encodings, uncovered: cov.uncovered }).toEqual({
								encodings: cov.objects,
								uncovered: 0,
							})

							// 2. Star topology (D2/D9): every delta's base is a WHOLE encoding.
							expect(topologyViolations(await encodingRows(isolated))).toEqual([])

							// 3. Idempotence (D4): the second pass finds nothing pending.
							expect(await repack.repack(REPO)).toEqual({ deltas: 0, wholes: 0 })

							// 4. Invisibility: the client sees the file:// control, byte for byte.
							const served = await mirrorClone(url, join(root, "from-pggit"))
							const oracle = await mirrorClone(
								`file://${control}`,
								join(root, "from-file"),
							)
							expect(served.fsck).toBe("")
							expect({
								digest: served.digest,
								objects: served.objects,
								refs: served.refs,
							}).toEqual({
								digest: oracle.digest,
								objects: oracle.objects,
								refs: oracle.refs,
							})
						} finally {
							await server?.close()
							await isolated.drop()
						}
					})
				},
			),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)

		// The corpus the run actually drew. Carried in every floor's failure message
		// too: vitest shows a passing test's stdout only under a verbose reporter, so
		// the message is what a maintainer reads when a floor breaks.
		const corpus = JSON.stringify(realized)
		console.log(`[repack-invariants corpus] ${corpus}`)
		for (const [shape, { floor, why }] of Object.entries(FLOORS)) {
			expect(
				realized[shape as keyof typeof realized],
				`${why} — corpus ${corpus}`,
			).toBeGreaterThanOrEqual(floor)
		}
	})
})

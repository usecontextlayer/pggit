/**
 * PROBE: `encodeDelta` indexes the base by 16-byte block and keeps only the FIRST
 * 64 offsets per block value (CHAIN_LIMIT, "first-kept, so deterministic"). A
 * tree whose entries share one blob oid — a directory of identical stub files,
 * empty `.gitkeep`s, repeated generated headers, a vendored tree of duplicated
 * placeholders — has one block value repeating thousands of times, so the
 * correct match for anything past the 64th occurrence is not in the candidate
 * list at all.
 *
 * A/B with everything else held fixed: the SAME directory width, the SAME entry
 * names (so the SAME tree byte length), the SAME commit count — only whether the
 * W files' contents are distinct. Measured: repack wall, how many trees the
 * encoder could delta, the served pack at a real clone, and `git repack -adf` on
 * both repos as the anchor. Each arm's clone is `git fsck --strict`-ed, so a
 * cheap-but-wrong pack cannot win the A/B.
 *
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--delta-duplicate-oids.ts [--width=20000] [--commits=50]
 */
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
	importRepo,
	mb,
	mkTmp,
	PG_URL,
	secs,
	seedRepo,
	table,
} from "./_perf-util"

const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const WIDTH = Number(flag("width", "20000"))
const COMMITS = Number(flag("commits", "50"))
/** Slowdown/size ratio between the two arms at which this is called broken. */
const ARM_RATIO_LIMIT = 3

/** 4-hex-char names ⇒ every tree entry is exactly 32 bytes, so the 20-byte oid's
 * tail lands on a 16-byte-aligned block — the encoder's index key. */
const name = (i: number): string => i.toString(16).padStart(4, "0")

function stream(distinct: boolean): string {
	const out: string[] = []
	let mark = 0
	const changes: string[] = []
	const shared = ++mark
	if (!distinct) out.push(`blob\nmark :${shared}\ndata 6\nstub\n\n`)
	for (let i = 0; i < WIDTH; i++) {
		if (distinct) {
			const m = ++mark
			const body = `stub ${i}\n`
			out.push(`blob\nmark :${m}\ndata ${body.length}\n${body}\n`)
			changes.push(`M 100644 :${m} w/${name(i)}`)
		} else {
			changes.push(`M 100644 :${shared} w/${name(i)}`)
		}
	}
	let prev = ++mark
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${changes.join("\n")}\n`,
	)
	// Each commit rewrites ONE file, far past the 64th entry, with fresh content.
	for (let c = 0; c < COMMITS; c++) {
		const m = ++mark
		const body = `edit ${c}\n`
		out.push(`blob\nmark :${m}\ndata ${body.length}\n${body}\n`)
		const cm = ++mark
		const msg = `c${c}`
		const target = (c * 977) % WIDTH
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${prev}\n` +
				`M 100644 :${m} w/${name(target)}\n`,
		)
		prev = cm
	}
	return out.join("")
}

type Arm = {
	label: string
	objects: number
	treeMb: number
	repackMs: number
	wholes: number
	deltas: number
	packBytes: number
	gitMs: number
	gitPack: number
}

async function arm(distinct: boolean): Promise<Arm> {
	const label = distinct ? "distinct blobs" : "one shared blob"
	const dir = await importRepo(distinct ? "dup-distinct" : "dup-shared", stream(distinct))
	try {
		const git = await gitRepack(dir, distinct ? "dup-git-d" : "dup-git-s")
		const db = await createIsolatedSchema(PG_URL)
		try {
			const objs = await seedRepo(db.sql, "probe/dup", dir)
			const t0 = Date.now()
			const r = await createRepack(db.sql).repack("probe/dup")
			const repackMs = Date.now() - t0
			const server = await serveOnPort(
				createGitApp(createGitDeps(db.sql), { instrument: true }),
				0,
			)
			resetCollected()
			const dest = join(mkTmp("dup-clone"), "c")
			mkdirSync(dest, { recursive: true })
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--bare",
				`http://127.0.0.1:${server.port}/probe/dup`,
				dest,
			])
			await server.close()
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			const run = collectedRuns().find((r2) => r2.label === "fetch")
			const treeBytes = Number(
				(
					await db.sql<{ n: string }[]>`
						select coalesce(sum(size),0)::text as n from git_object where type = 2`
				)[0]?.n ?? 0,
			)
			return {
				deltas: r.deltas,
				gitMs: git.ms,
				gitPack: git.packBytes,
				label,
				objects: objs.objects,
				packBytes: run?.counters.get("packBytes") ?? 0,
				repackMs,
				treeMb: treeBytes,
				wholes: r.wholes,
			}
		} finally {
			await db.drop()
		}
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

async function main(): Promise<void> {
	const a = await arm(true)
	const b = await arm(false)

	console.log(
		`# delta candidate-chain cap — ${WIDTH}-entry flat dir, ${COMMITS} single-file edits\n`,
	)
	console.log(
		table(
			[
				"arm",
				"objects",
				"tree MB",
				"repack s",
				"encodings",
				"delta share",
				"served pack MB",
				"git repack s",
				"git pack MB",
				"pggit/git pack",
			],
			[a, b].map((r) => [
				r.label,
				r.objects,
				mb(r.treeMb),
				secs(r.repackMs),
				`${r.wholes}w+${r.deltas}d`,
				`${((r.deltas / (r.wholes + r.deltas)) * 100).toFixed(0)}%`,
				mb(r.packBytes),
				secs(r.gitMs),
				mb(r.gitPack),
				`${(r.packBytes / Math.max(r.gitPack, 1)).toFixed(1)}×`,
			]),
		),
	)

	const timeRatio = b.repackMs / Math.max(a.repackMs, 1)
	const packRatio = b.packBytes / Math.max(a.packBytes, 1)
	console.log(
		`\nshared-blob arm vs distinct-blob arm: repack ${timeRatio.toFixed(2)}× the wall, ${packRatio.toFixed(2)}× the served bytes` +
			` (tree bytes identical by construction: ${mb(a.treeMb)} vs ${mb(b.treeMb)} MB)`,
	)
	console.log(
		`\nFAIL CONDITION: duplicated oids cost > ${ARM_RATIO_LIMIT}× the wall or the served bytes of the distinct arm.`,
	)
	if (timeRatio > ARM_RATIO_LIMIT || packRatio > ARM_RATIO_LIMIT) process.exitCode = 1
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

/**
 * The WARM path, which the delta work never measured: an incremental `git fetch` by a
 * client that already has most of the history.
 *
 * Serve emits a stored delta as REF_DELTA only when its base is ALSO in the served set
 * (design D8). On an incremental fetch the served set is closure(want) MINUS
 * closure(have) — and a tree's anchor is, by construction, an EARLIER version of the
 * same path, i.e. exactly the kind of object the client already has. So on the warm
 * path the anchor is subtracted, the delta is unusable, and the object ships WHOLE.
 * The design records this as W3 ("thin-pack propagation… correct, just not
 * delta-optimal") but never put a number on it against real history.
 *
 * This does: replay a real repo checkpoint by checkpoint, and for every round measure
 * the pack pggit actually puts on the wire for the incremental fetch against the pack
 * plain git puts on the wire for the identical fetch. `fetch.unpackLimit=1` forces git
 * to keep the received pack on disk, so the number is the transferred pack itself.
 *
 * A perf harness rather than a vitest e2e test on both counts: the verdict is a
 * MEASURED size ratio, and the corpus is a REAL local repository handed in at run
 * time (`--repo=`), which no committed fixture can stand in for.
 *
 *   npx tsx perf/breakage/realrepo--incremental-fetch-size.ts --repo=/path/to/checkout --slug=<n>
 *
 * Exit 0 = warm-path transfer is within `--max-ratio` (default 3.0) of git's.
 * Exit 1 = reproduced, with the per-round table printed.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	createScratch,
	DEFAULT_PG_URL,
	flag,
	kb,
	packBytesOnDisk,
	prepareMirror,
} from "./_realrepo-util"

const SLUG = flag("slug", "repo")
const STEP = Number(flag("step", "50"))
const MAX_RATIO = Number(flag("max-ratio", "3.0"))
const PG_URL = flag("pg", DEFAULT_PG_URL)

const scratch = createScratch(`warm-${SLUG}`)

async function main(): Promise<void> {
	const MIRROR = await prepareMirror(scratch)
	console.log(`# incremental (warm) fetch size — ${SLUG}\n  mirror ${MIRROR}`)
	const chain = (
		await spawnGit(["rev-list", "--first-parent", "--reverse", "HEAD"], { cwd: MIRROR })
	).stdout
		.trim()
		.split("\n")
		.filter(Boolean)
	const checkpoints: string[] = []
	for (let i = STEP - 1; i < chain.length; i += STEP) checkpoints.push(chain[i] as string)
	if (checkpoints[checkpoints.length - 1] !== chain[chain.length - 1])
		checkpoints.push(chain[chain.length - 1] as string)
	console.log(`  ${chain.length} first-parent commits → ${checkpoints.length} rounds`)

	const repoId = `warm/${SLUG}`
	const db = await createIsolatedSchema(PG_URL)
	const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	const url = `http://127.0.0.1:${server.port}/${repoId}`
	const oracle = join(scratch.mk("oracle"), "o.git")
	mkdirSync(oracle, { recursive: true })
	await spawnGit(["init", "-q", "--bare", oracle])
	const rows: { round: number; rev: string; pggit: number; git: number }[] = []

	try {
		let pgTrack: string | null = null
		let gitTrack: string | null = null
		let prevPg = 0
		let prevGit = 0
		for (let round = 0; round < checkpoints.length; round++) {
			const rev = checkpoints[round] as string
			await spawnGit(["push", url, `${rev}:refs/heads/main`], { cwd: MIRROR })
			await spawnGit(["push", `file://${oracle}`, `${rev}:refs/heads/main`], {
				cwd: MIRROR,
			})
			await createRepack(db.sql).repack(repoId)
			// git's side gets its own repack too, so both are serving from a packed state
			await spawnGit(["gc", "--prune=now", "-q"], { cwd: oracle })

			if (pgTrack === null) {
				pgTrack = join(scratch.mk("pgtrack"), "t.git")
				gitTrack = join(scratch.mk("gittrack"), "t.git")
				await spawnGit([
					"-c",
					"protocol.version=2",
					"-c",
					"fetch.unpackLimit=1",
					"clone",
					"--bare",
					"-q",
					url,
					pgTrack,
				])
				await spawnGit([
					"-c",
					"fetch.unpackLimit=1",
					"clone",
					"--bare",
					"-q",
					`file://${oracle}`,
					gitTrack,
				])
				prevPg = packBytesOnDisk(pgTrack)
				prevGit = packBytesOnDisk(gitTrack)
				console.log(
					`  round ${round} COLD clone: pggit ${kb(prevPg)} vs git ${kb(prevGit)}`,
				)
				rows.push({ git: prevGit, pggit: prevPg, rev, round })
				continue
			}
			await spawnGit(
				[
					"-c",
					"protocol.version=2",
					"-c",
					"fetch.unpackLimit=1",
					"fetch",
					"-q",
					"origin",
					"+refs/heads/main:refs/heads/main",
				],
				{ cwd: pgTrack },
			)
			await spawnGit(
				[
					"-c",
					"fetch.unpackLimit=1",
					"fetch",
					"-q",
					"origin",
					"+refs/heads/main:refs/heads/main",
				],
				{ cwd: gitTrack as string },
			)
			const nowPg = packBytesOnDisk(pgTrack)
			const nowGit = packBytesOnDisk(gitTrack as string)
			rows.push({ git: nowGit - prevGit, pggit: nowPg - prevPg, rev, round })
			prevPg = nowPg
			prevGit = nowGit
		}
	} finally {
		await server.close()
		await db.drop()
		scratch.cleanup()
	}

	const warm = rows.slice(1)
	const wp = warm.reduce((a, r) => a + r.pggit, 0)
	const wg = warm.reduce((a, r) => a + r.git, 0)
	console.log(`\n### per-round transfer (round 0 is the cold clone)\n`)
	console.log("| round | commit | pggit pack | git pack | ratio |")
	console.log("|---|---|---|---|---|")
	for (const r of rows) {
		console.log(
			`| ${r.round} | ${r.rev.slice(0, 8)} | ${kb(r.pggit)} | ${kb(r.git)} | ${(r.pggit / Math.max(r.git, 1)).toFixed(2)}x |`,
		)
	}
	const ratio = wp / Math.max(wg, 1)
	console.log(
		`\n**warm total (rounds 1..${rows.length - 1}): pggit ${kb(wp)} vs git ${kb(wg)} = ${ratio.toFixed(2)}x**` +
			`  |  cold clone was ${(rows[0] ? rows[0].pggit / Math.max(rows[0].git, 1) : 0).toFixed(2)}x`,
	)
	if (ratio > MAX_RATIO) {
		console.log(
			`\nREPRODUCED: warm incremental fetches cost ${ratio.toFixed(2)}x git's transfer on ${SLUG}. ` +
				`Serve can only emit a delta whose base is in the SAME pack (D8), and on a warm fetch the anchor is\n` +
				`exactly what the client already has — so it is subtracted from the served set and the object ships whole (W3).`,
		)
		process.exitCode = 1
	} else {
		console.log(`\nOK: ${ratio.toFixed(2)}x is within the ${MAX_RATIO}x bar.`)
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})

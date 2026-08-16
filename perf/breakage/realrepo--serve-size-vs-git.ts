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
 * Black-box: real `git push` over the wire → `createRepack().repack()` → real
 * `git clone`. The served pack is the clone's packfile, so `verify-pack -v` on it is
 * a direct, per-object measurement of what pggit actually put on the wire, compared
 * against `git gc --aggressive` over the identical object set.
 *
 * A perf harness rather than a vitest e2e test on both counts: the verdict is a
 * MEASURED size ratio, and the corpus is a REAL local repository handed in at run
 * time (`--repo=`), which no committed fixture can stand in for.
 *
 *   npx tsx perf/breakage/realrepo--serve-size-vs-git.ts --repo=/path/to/checkout --slug=<name>
 *
 * Exit 0 = the served pack is within `--max-ratio` (default 3.0, i.e. the ~2.4x
 * parity the design measured on pggit's own history plus headroom).
 * Exit 1 = reproduced: the ratio is past that, with the per-type attribution printed.
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { createScratch, DEFAULT_PG_URL, flag, mb, prepareMirror } from "./_realrepo-util"

const SLUG = flag("slug", "repo")
const MAX_RATIO = Number(flag("max-ratio", "3.0"))
const PG_URL = flag("pg", DEFAULT_PG_URL)

const scratch = createScratch(`serve-size-${SLUG}`)

type Attribution = Map<string, { n: number; packed: number; deltified: number }>

/** Per-type bytes-in-packfile, straight from `git verify-pack -v`: the authoritative
 * account of what a pack actually spent, including whether each entry is a delta. */
async function attribute(bareDir: string): Promise<{ by: Attribution; total: number }> {
	const packDir = join(bareDir, "objects", "pack")
	const idx = readdirSync(packDir).filter((f) => f.endsWith(".idx"))
	const by: Attribution = new Map()
	let total = 0
	for (const f of idx) {
		const out = await spawnGit(["verify-pack", "-v", join(packDir, f)], { cwd: bareDir })
		for (const line of out.stdout.split("\n")) {
			const parts = line.trim().split(/\s+/)
			if (parts.length < 5 || !/^[0-9a-f]{40}$/.test(parts[0] as string)) continue
			const type = parts[1] as string
			const packed = Number(parts[3])
			if (!Number.isFinite(packed)) continue
			const slot = by.get(type) ?? { deltified: 0, n: 0, packed: 0 }
			slot.n++
			slot.packed += packed
			if (parts.length >= 7) slot.deltified++
			by.set(type, slot)
			total += packed
		}
	}
	return { by, total }
}

function table(label: string, a: { by: Attribution; total: number }): void {
	console.log(`\n### ${label} — ${mb(a.total)} of pack entries`)
	console.log("| type | objects | bytes in pack | entries stored as deltas |")
	console.log("|---|---|---|---|")
	for (const t of ["commit", "tree", "blob", "tag"]) {
		const s = a.by.get(t)
		if (!s) continue
		console.log(
			`| ${t} | ${s.n} | ${mb(s.packed)} | ${s.deltified} (${((s.deltified / s.n) * 100).toFixed(0)}%) |`,
		)
	}
}

async function main(): Promise<void> {
	const MIRROR = await prepareMirror(scratch)
	console.log(`# serve-size vs git — ${SLUG}\n  mirror ${MIRROR}`)
	const repoId = `sizecheck/${SLUG}`
	const db = await createIsolatedSchema(PG_URL)
	const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	const url = `http://127.0.0.1:${server.port}/${repoId}`
	try {
		await spawnGit(["push", url, "--mirror"], { cwd: MIRROR })
		const r = await createRepack(db.sql).repack(repoId)
		console.log(`  repack: ${r.wholes} wholes + ${r.deltas} deltas`)

		const pggitDir = join(scratch.mk("pggit"), "c.git")
		await spawnGit(["-c", "protocol.version=2", "clone", "--mirror", "-q", url, pggitDir])
		await spawnGit(["fsck", "--strict"], { cwd: pggitDir })

		// git's own answer over the SAME object set: replay the same push into a plain
		// file:// bare remote, gc it, clone it.
		const oracle = join(scratch.mk("oracle"), "o.git")
		await spawnGit(["init", "-q", "--bare", oracle])
		await spawnGit(["push", `file://${oracle}`, "--mirror"], { cwd: MIRROR })
		await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: oracle })
		const gitDir = join(scratch.mk("git"), "g.git")
		await spawnGit(["clone", "--mirror", "-q", `file://${oracle}`, gitDir])

		const p = await attribute(pggitDir)
		const g = await attribute(gitDir)
		table("pggit (repacked, served over the wire)", p)
		table("git (gc --aggressive, same objects)", g)

		const ratio = p.total / Math.max(g.total, 1)
		console.log(`\n### where the gap is`)
		console.log("| type | pggit | git | pggit / git |")
		console.log("|---|---|---|---|")
		for (const t of ["commit", "tree", "blob", "tag"]) {
			const ps = p.by.get(t)
			const gs = g.by.get(t)
			if (!ps || !gs) continue
			console.log(
				`| ${t} | ${mb(ps.packed)} | ${mb(gs.packed)} | ${(ps.packed / Math.max(gs.packed, 1)).toFixed(2)}x |`,
			)
		}
		console.log(
			`| **total** | **${mb(p.total)}** | **${mb(g.total)}** | **${ratio.toFixed(2)}x** |`,
		)

		const blobP = p.by.get("blob")?.packed ?? 0
		const blobG = g.by.get("blob")?.packed ?? 0
		const treeP = p.by.get("tree")?.packed ?? 0
		const treeG = g.by.get("tree")?.packed ?? 0
		const gap = p.total - g.total
		console.log(
			`\nof the ${mb(gap)} gap: ${(((blobP - blobG) / Math.max(gap, 1)) * 100).toFixed(0)}% is blobs, ` +
				`${(((treeP - treeG) / Math.max(gap, 1)) * 100).toFixed(0)}% is trees`,
		)
		console.log(
			`blob entries stored as deltas — pggit ${p.by.get("blob")?.deltified ?? 0} / git ${g.by.get("blob")?.deltified ?? 0}`,
		)

		if (ratio > MAX_RATIO) {
			console.log(
				`\nREPRODUCED: ${SLUG} serves ${ratio.toFixed(2)}x git's pack (${mb(p.total)} vs ${mb(g.total)}), ` +
					`past the ${MAX_RATIO}x bar set by the design's measured ~2.4x parity.`,
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

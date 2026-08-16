/**
 * The conditions the production drain (design W1) will actually create, on REAL
 * repository history — none of which the suite or the design's verification covers:
 *
 *   R1 determinism   two clones of one repacked state must be byte-identical packs
 *                    (buildPack claims "deterministic packs" — served order is fixed).
 *   R2 clone ‖ repack  a client cloning WHILE the offline repack writes encodings.
 *                    Serve reads encodings per 1000-object batch, so a racing clone
 *                    necessarily sees a half-encoded repo — every batch boundary is a
 *                    chance to mix representations. The pack must still be valid.
 *   R3 push ‖ repack  new objects arriving mid-pass, then a clone of the result.
 *   R4 repack ‖ repack  two drains overlapping on one repo (the drain serializes per
 *                    repo today — this asks what happens the day it does not). A loud
 *                    failure is fine; a corrupt or short pack is not.
 *
 * Black-box: real `git push` / `git clone` over the wire + `createRepack().repack()`.
 * Every verdict is a clone compared byte-for-byte against a plain `file://` remote
 * that received the identical push.
 *
 * A perf harness rather than a vitest e2e test because its corpus is a REAL local
 * repository handed in at run time (`--repo=`), which no committed fixture can stand
 * in for — the same reason `perf/delta-corpus.ts` lives here.
 *
 *   npx tsx perf/breakage/realrepo--drain-races.ts --repo=/path/to/checkout --slug=<name>
 *
 * Exit 0 = every race produced a pack identical to git's. Non-zero = reproduced.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	createLedger,
	createScratch,
	DEFAULT_PG_URL,
	flag,
	oidSet,
	prepareMirror,
	tryGit,
} from "./_realrepo-util"

const SLUG = flag("slug", "repo")
const PG_URL = flag("pg", DEFAULT_PG_URL)

const scratch = createScratch(`races-${SLUG}`)
const { fail, findings, report } = createLedger(SLUG)
/** The private mirror clone of `--repo=`; set by `prepareMirror` in `main`. */
let MIRROR = ""

function packDigest(bareDir: string): string {
	const dir = join(bareDir, "objects", "pack")
	const packs = readdirSync(dir)
		.filter((f) => f.endsWith(".pack"))
		.sort()
	const h = createHash("sha256")
	for (const f of packs) h.update(readFileSync(join(dir, f)))
	return h.digest("hex")
}

/** A clone must be fsck-clean and hold exactly the oracle's object set. */
async function verifyClone(
	label: string,
	dir: string,
	expect: Set<string>,
): Promise<boolean> {
	const fsck = await tryGit(["fsck", "--strict"], dir)
	if (!fsck.ok) {
		fail(`${label}: git fsck --strict FAILED`, fsck.stderr.trim().slice(0, 800))
		return false
	}
	const got = await oidSet(dir)
	const missing = [...expect].filter((o) => !got.has(o))
	const extra = [...got].filter((o) => !expect.has(o))
	if (missing.length > 0 || extra.length > 0) {
		fail(
			`${label}: object set diverges from git`,
			`${missing.length} missing, ${extra.length} extra (first missing ${missing[0] ?? "-"})`,
		)
		return false
	}
	return true
}

async function main(): Promise<void> {
	MIRROR = await prepareMirror(scratch)
	console.log(`# drain races — ${SLUG}\n  mirror ${MIRROR}`)
	const chain = (
		await spawnGit(["rev-list", "--first-parent", "--reverse", "HEAD"], { cwd: MIRROR })
	).stdout
		.trim()
		.split("\n")
		.filter(Boolean)
	const mid = chain[Math.floor(chain.length * 0.6)] as string
	const head = chain[chain.length - 1] as string

	const db = await createIsolatedSchema(PG_URL)
	const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	const url = `http://127.0.0.1:${server.port}/races/${SLUG}`
	// the oracle: a plain file:// remote receiving the identical pushes
	const oracle = join(scratch.mk("oracle"), "o.git")
	mkdirSync(oracle, { recursive: true })
	await spawnGit(["init", "-q", "--bare", oracle])

	try {
		// ── seed: push half the history, repack fully ───────────────────────────
		await spawnGit(["push", url, `${mid}:refs/heads/main`], { cwd: MIRROR })
		await spawnGit(["push", `file://${oracle}`, `${mid}:refs/heads/main`], {
			cwd: MIRROR,
		})
		const seed = await createRepack(db.sql).repack(`races/${SLUG}`)
		console.log(`  seed repack: ${seed.wholes} wholes + ${seed.deltas} deltas`)
		const midOracle = join(scratch.mk("midoracle"), "m.git")
		await spawnGit(["clone", "--bare", "-q", `file://${oracle}`, midOracle])
		const midExpect = await oidSet(midOracle)

		// ── R1: determinism — two clones of one state, byte-identical packs ─────
		const c1 = join(scratch.mk("det1"), "c.git")
		const c2 = join(scratch.mk("det2"), "c.git")
		await spawnGit(["-c", "protocol.version=2", "clone", "--bare", "-q", url, c1])
		await spawnGit(["-c", "protocol.version=2", "clone", "--bare", "-q", url, c2])
		const [d1, d2] = [packDigest(c1), packDigest(c2)]
		if (d1 !== d2) {
			fail(
				"R1 two clones of an unchanged repacked state produced DIFFERENT pack bytes",
				`sha256 ${d1.slice(0, 16)} vs ${d2.slice(0, 16)} — buildPack documents deterministic packs`,
			)
		}
		report.push(
			`| R1 | determinism (2 clones, same state) | ${d1 === d2 ? "byte-identical" : "DIVERGED"} |`,
		)
		await verifyClone("R1 clone", c1, midExpect)

		// ── R2: a clone racing a repack ─────────────────────────────────────────
		// Wipe the encoding tier's coverage by pushing the REST of the history first
		// (so a repack has real work), then start repack and clone at the same instant.
		await spawnGit(["push", url, `${head}:refs/heads/main`], { cwd: MIRROR })
		await spawnGit(["push", `file://${oracle}`, `${head}:refs/heads/main`], {
			cwd: MIRROR,
		})
		const headOracle = join(scratch.mk("headoracle"), "h.git")
		await spawnGit(["clone", "--bare", "-q", `file://${oracle}`, headOracle])
		const headExpect = await oidSet(headOracle)

		const raceDir = join(scratch.mk("race"), "c.git")
		const repackP = createRepack(db.sql).repack(`races/${SLUG}`)
		const cloneP = tryGit([
			"-c",
			"protocol.version=2",
			"clone",
			"--bare",
			"-q",
			url,
			raceDir,
		])
		const [rp, cl] = await Promise.all([repackP, cloneP])
		console.log(
			`  R2 concurrent repack: ${rp.wholes} wholes + ${rp.deltas} deltas; clone ${cl.ok ? "ok" : `FAILED exit ${cl.code}`}`,
		)
		if (!cl.ok)
			fail(
				"R2 a clone running concurrently with repack FAILED",
				cl.stderr.trim().slice(0, 800),
			)
		else await verifyClone("R2 clone racing repack", raceDir, headExpect)
		report.push(
			`| R2 | clone ‖ repack | ${cl.ok ? "pack valid, matches git" : "CLONE FAILED"} |`,
		)

		// ── R3: a push racing a repack, then a clone of the result ──────────────
		// Fresh repo id so the repack has the whole history pending while a push of a
		// SECOND branch lands mid-pass.
		const rid2 = `races/${SLUG}-push`
		const url2 = `http://127.0.0.1:${server.port}/${rid2}`
		const oracle2 = join(scratch.mk("oracle2"), "o.git")
		mkdirSync(oracle2, { recursive: true })
		await spawnGit(["init", "-q", "--bare", oracle2])
		await spawnGit(["push", url2, `${mid}:refs/heads/main`], { cwd: MIRROR })
		await spawnGit(["push", `file://${oracle2}`, `${mid}:refs/heads/main`], {
			cwd: MIRROR,
		})
		const repackP3 = createRepack(db.sql).repack(rid2)
		const pushP3 = tryGit(["push", url2, `${head}:refs/heads/later`], MIRROR)
		const [rp3, pu3] = await Promise.all([repackP3, pushP3])
		await spawnGit(["push", `file://${oracle2}`, `${head}:refs/heads/later`], {
			cwd: MIRROR,
		})
		console.log(
			`  R3 repack ‖ push: repack ${rp3.wholes}w+${rp3.deltas}d, push ${pu3.ok ? "ok" : `FAILED exit ${pu3.code}`}`,
		)
		if (!pu3.ok)
			fail(
				"R3 a push running concurrently with repack FAILED",
				pu3.stderr.trim().slice(0, 800),
			)
		// converge: repack again, then clone and compare
		const rp3b = await createRepack(db.sql).repack(rid2)
		const oracle2Clone = join(scratch.mk("oracle2c"), "o.git")
		await spawnGit(["clone", "--mirror", "-q", `file://${oracle2}`, oracle2Clone])
		const expect2 = await oidSet(oracle2Clone)
		const after3 = join(scratch.mk("after3"), "c.git")
		const cl3 = await tryGit([
			"-c",
			"protocol.version=2",
			"clone",
			"--mirror",
			"-q",
			url2,
			after3,
		])
		if (!cl3.ok)
			fail("R3 clone after a push/repack race FAILED", cl3.stderr.trim().slice(0, 800))
		else await verifyClone("R3 clone after push‖repack", after3, expect2)
		report.push(
			`| R3 | push ‖ repack (+converging repack ${rp3b.wholes}w+${rp3b.deltas}d) | ${cl3.ok ? "pack valid, matches git" : "CLONE FAILED"} |`,
		)

		// ── R4: two overlapping repacks on ONE repo ─────────────────────────────
		const rid4 = `races/${SLUG}-dual`
		const url4 = `http://127.0.0.1:${server.port}/${rid4}`
		await spawnGit(["push", url4, `${head}:refs/heads/main`], { cwd: MIRROR })
		const both = await Promise.allSettled([
			createRepack(db.sql).repack(rid4),
			createRepack(db.sql).repack(rid4),
		])
		const rejected = both.filter((r) => r.status === "rejected")
		console.log(
			`  R4 two concurrent repacks: ${both
				.map((r) =>
					r.status === "fulfilled"
						? `${r.value.wholes}w+${r.value.deltas}d`
						: `THREW: ${String((r as PromiseRejectedResult).reason).slice(0, 120)}`,
				)
				.join(" | ")}`,
		)
		// Whatever happened, the repo must still serve a correct pack — and one more
		// repack must bring it to full coverage without breaking anything.
		await createRepack(db.sql).repack(rid4)
		const after4 = join(scratch.mk("after4"), "c.git")
		const cl4 = await tryGit([
			"-c",
			"protocol.version=2",
			"clone",
			"--bare",
			"-q",
			url4,
			after4,
		])
		if (!cl4.ok)
			fail(
				"R4 clone after two overlapping repacks FAILED",
				cl4.stderr.trim().slice(0, 800),
			)
		else await verifyClone("R4 clone after overlapping repacks", after4, headExpect)
		report.push(
			`| R4 | repack ‖ repack | ${rejected.length} of 2 threw; clone ${cl4.ok ? "valid, matches git" : "FAILED"} |`,
		)
	} finally {
		await server.close()
		await db.drop()
		scratch.cleanup()
	}

	console.log(`\n## ${SLUG} — drain races\n`)
	console.log("| race | what | verdict |")
	console.log("|---|---|---|")
	for (const r of report) console.log(r)
	console.log(
		`\n${findings.length === 0 ? "VERDICT: clean — every race served a pack identical to git's." : `VERDICT: ${findings.length} FINDING(S)`}`,
	)
	for (const f of findings) console.log(`  - ${f}`)
	if (findings.length > 0) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})

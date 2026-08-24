/**
 * Race conditions created by directly driving a host-serialized maintenance sequence on real repository history.
 *
 * R1 checks that two identical raw v2 fetches of the same unchanged repacked state produce byte-identical wire packs. R2 starts a clone only after observing committed partial encoding coverage while repack is still unsettled. R3 starts a push at that same proven partial-coverage seam, then converges and clones the result. Promise co-start is not evidence of overlap, so both race cases fail as unmet fixture preconditions unless the intermediate state is observed.
 *
 * Black-box behavior remains real `git push` / `git clone` over the wire plus direct `createRepack().repack()` calls. Every successful clone must be fsck-clean and match a plain `file://` oracle exactly in refs and objects. Concurrent repack-vs-repack is deliberately absent because this harness models one host serializing its maintenance calls; it makes no claim about cross-host serialization.
 *
 * A perf harness rather than a vitest e2e test because its corpus is a REAL local repository selected at run time (`--repo=` or `--mirror=`), which no committed fixture can stand in for — the same reason `perf/probes/delta-corpus.ts` lives here.
 *
 *   npx tsx perf/probes/realrepo/drain-races.ts --repo=/path/to/checkout --slug=<name>
 *
 * Exit 0 = every established race produced canonical refs and objects. Non-zero = divergence or an unestablished named precondition.
 */
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { nonemptyStringArg, parseArgs, pgUrlArg } from "@perf/args"
import { table } from "@perf/probes/_table"
import {
	assertCanonicalRealRepoStore,
	createLedger,
	createScratch,
	type EncodingCoverage,
	encodingCoverage,
	mirrorSourceFromArgs,
	oidSet,
	postPggitV2Pack,
	prepareMirror,
} from "@perf/probes/realrepo/_util"
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { parseRevListObjectOids, requiredAt, typedRefsOf } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

const args = parseArgs(
	z
		.object({
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
const PG_URL = args.pg

const scratch = createScratch(`races-${SLUG}`)
const { fail, findings, report } = createLedger(SLUG)
/** The private mirror clone of the selected source; set by `prepareMirror` in `main`. */
let MIRROR = ""

async function verifyCanonicalClone(
	label: string,
	dir: string,
	expect: { oids: Set<string>; refs: string },
): Promise<boolean> {
	const fsck = await attemptGit(["fsck", "--strict"], dir)
	if (!fsck.ok) {
		fail(`${label}: git fsck --strict FAILED`, fsck.stderr.trim().slice(0, 800))
		return false
	}
	const got = await oidSet(dir)
	const missing = [...expect.oids].filter((o) => !got.has(o))
	const extra = [...got].filter((o) => !expect.oids.has(o))
	if (missing.length > 0 || extra.length > 0) {
		fail(
			`${label}: object set diverges from git`,
			`${missing.length} missing, ${extra.length} extra (first missing ${missing[0] ?? "-"})`,
		)
		return false
	}
	const refs = (await typedRefsOf(dir))
		.map(({ name, oid, type }) => `${name} ${oid} ${type}`)
		.join("\n")
	if (refs !== expect.refs) {
		fail(
			`${label}: ref set diverges from git`,
			`${refs || "<none>"} != ${expect.refs || "<none>"}`,
		)
		return false
	}
	return true
}

async function oracleState(dir: string): Promise<{ oids: Set<string>; refs: string }> {
	const oids = await oidSet(dir)
	if (oids.size === 0) throw new Error(`oracle ${dir} contains zero objects`)
	const refs = (await typedRefsOf(dir))
		.map(({ name, oid, type }) => `${name} ${oid} ${type}`)
		.join("\n")
	if (!refs) throw new Error(`oracle ${dir} contains zero refs`)
	return { oids, refs }
}

async function waitForPartialCoverage(
	db: Awaited<ReturnType<typeof createIsolatedSchema>>,
	repo: string,
	before: EncodingCoverage,
	isSettled: () => boolean,
): Promise<void> {
	const pending = before.eligible - before.encoded
	if (pending <= 1000) {
		throw new Error(
			`${repo}: race fixture has ${pending} pending encodings; need more than one 1000-row flush`,
		)
	}
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		const current = await encodingCoverage(db.sql, repo)
		if (
			current.eligible === before.eligible &&
			current.encoded > before.encoded &&
			current.encoded < current.eligible &&
			!isSettled()
		) {
			return
		}
		if (isSettled()) break
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	throw new Error(
		`${repo}: repack never exposed committed partial encoding coverage while unsettled`,
	)
}

async function main(): Promise<void> {
	MIRROR = await prepareMirror(scratch, args.source)
	console.log(`# drain races — ${SLUG}\n  mirror ${MIRROR}`)
	const chain = parseRevListObjectOids(
		(
			await spawnGit(["rev-list", "--first-parent", "--reverse", "HEAD"], {
				cwd: MIRROR,
			})
		).stdout,
	)
	if (chain.length < 3)
		throw new Error(`drain-race fixture needs at least 3 commits, got ${chain.length}`)
	const mid = requiredAt(chain, Math.floor(chain.length * 0.6), "mid-history commit")
	const head = requiredAt(chain, chain.length - 1, "head commit")
	if (mid === head)
		throw new Error("drain-race fixture mid and head revisions are identical")

	const db = await createIsolatedSchema(PG_URL)
	const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	const url = `http://127.0.0.1:${server.port}/races/${SLUG}`
	// the oracle: a plain file:// remote receiving the identical pushes
	const oracle = join(scratch.mk("oracle"), "o.git")
	mkdirSync(oracle, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main", "--bare", oracle])

	try {
		// ── seed: push half the history, repack fully ───────────────────────────
		await spawnGit(["push", url, `${mid}:refs/heads/main`], { cwd: MIRROR })
		await spawnGit(["push", `file://${oracle}`, `${mid}:refs/heads/main`], {
			cwd: MIRROR,
		})
		const seed = await createRepack(db.sql).repack(`races/${SLUG}`)
		if (seed.wholes + seed.deltas === 0 || seed.deltas === 0) {
			throw new Error(
				`seed repack did not exercise deltas (${seed.wholes} wholes, ${seed.deltas} deltas)`,
			)
		}
		await assertCanonicalRealRepoStore(db.sql, `races/${SLUG}`, oracle, {
			kind: "repacked",
		})
		console.log(`  seed repack: ${seed.wholes} wholes + ${seed.deltas} deltas`)
		const midOracle = join(scratch.mk("midoracle"), "m.git")
		await spawnGit(["clone", "--bare", "-q", `file://${oracle}`, midOracle])
		const midExpect = await oracleState(midOracle)

		// ── R1: determinism — two raw fetches of one state, byte-identical packs ─
		const midWants = [...new Set((await typedRefsOf(midOracle)).map(({ oid }) => oid))]
		if (midWants.length === 0) throw new Error("R1 fixture has no canonical ref wants")
		const request = fetchRequest({ done: true, includeTag: true, wants: midWants })
		const [raw1, raw2] = await Promise.all([
			postPggitV2Pack(url, request),
			postPggitV2Pack(url, request),
		])
		const d1 = createHash("sha256").update(raw1).digest("hex")
		const d2 = createHash("sha256").update(raw2).digest("hex")
		if (raw1.length === 0 || raw2.length === 0) {
			throw new Error("R1 raw fetch returned an empty pack")
		}
		if (d1 !== d2) {
			fail(
				"R1 two identical raw fetches of an unchanged repacked state produced DIFFERENT wire packs",
				`sha256 ${d1.slice(0, 16)} vs ${d2.slice(0, 16)} — buildPack documents deterministic packs`,
			)
		}
		report.push([
			"R1",
			"determinism (2 raw v2 fetches, same state)",
			d1 === d2 ? "byte-identical" : "DIVERGED",
		])

		// Independent client correctness: both clones must accept that state.
		const c1 = join(scratch.mk("det1"), "c.git")
		const c2 = join(scratch.mk("det2"), "c.git")
		await spawnGit(["-c", "protocol.version=2", "clone", "--bare", "-q", url, c1])
		await spawnGit(["-c", "protocol.version=2", "clone", "--bare", "-q", url, c2])
		await Promise.all([
			verifyCanonicalClone("R1 clone 1", c1, midExpect),
			verifyCanonicalClone("R1 clone 2", c2, midExpect),
		])

		// ── R2: a clone racing a repack ─────────────────────────────────────────
		// Wipe the encoding tier's coverage by pushing the REST of the history first
		// (so a repack has real work), then start repack and clone at the same instant.
		await spawnGit(["push", url, `${head}:refs/heads/main`], { cwd: MIRROR })
		await spawnGit(["push", `file://${oracle}`, `${head}:refs/heads/main`], {
			cwd: MIRROR,
		})
		const headOracle = join(scratch.mk("headoracle"), "h.git")
		await spawnGit(["clone", "--bare", "-q", `file://${oracle}`, headOracle])
		const headExpect = await oracleState(headOracle)

		const raceDir = join(scratch.mk("race"), "c.git")
		const beforeR2 = await encodingCoverage(db.sql, `races/${SLUG}`)
		const repackP = createRepack(db.sql).repack(`races/${SLUG}`)
		let repackSettled = false
		void repackP.then(
			() => {
				repackSettled = true
			},
			() => {
				repackSettled = true
			},
		)
		await waitForPartialCoverage(db, `races/${SLUG}`, beforeR2, () => repackSettled)
		const cloneP = attemptGit([
			"-c",
			"protocol.version=2",
			"clone",
			"--bare",
			"-q",
			url,
			raceDir,
		])
		const [rp, cl] = await Promise.all([repackP, cloneP])
		if (rp.wholes + rp.deltas !== beforeR2.eligible - beforeR2.encoded) {
			throw new Error(
				`R2 repack covered ${rp.wholes + rp.deltas}/${beforeR2.eligible - beforeR2.encoded} pending objects`,
			)
		}
		const afterR2 = await encodingCoverage(db.sql, `races/${SLUG}`)
		if (afterR2.encoded !== afterR2.eligible) {
			throw new Error(
				`R2 repack left encoding coverage ${afterR2.encoded}/${afterR2.eligible}`,
			)
		}
		await assertCanonicalRealRepoStore(db.sql, `races/${SLUG}`, oracle, {
			kind: "repacked",
		})
		console.log(
			`  R2 concurrent repack: ${rp.wholes} wholes + ${rp.deltas} deltas; clone ${cl.ok ? "ok" : `FAILED exit ${cl.code}`}`,
		)
		if (!cl.ok)
			fail(
				"R2 a clone running concurrently with repack FAILED",
				cl.stderr.trim().slice(0, 800),
			)
		else await verifyCanonicalClone("R2 clone racing repack", raceDir, headExpect)
		report.push([
			"R2",
			"clone ‖ repack",
			cl.ok ? "pack valid, matches git" : "CLONE FAILED",
		])

		// ── R3: a push racing a repack, then a clone of the result ──────────────
		// Fresh repo id so the repack has the whole history pending while a push of a
		// SECOND branch lands mid-pass.
		const rid2 = `races/${SLUG}-push`
		const url2 = `http://127.0.0.1:${server.port}/${rid2}`
		const oracle2 = join(scratch.mk("oracle2"), "o.git")
		mkdirSync(oracle2, { recursive: true })
		await spawnGit(["init", "-q", "-b", "main", "--bare", oracle2])
		await spawnGit(["push", url2, `${mid}:refs/heads/main`], { cwd: MIRROR })
		await spawnGit(["push", `file://${oracle2}`, `${mid}:refs/heads/main`], {
			cwd: MIRROR,
		})
		const beforeR3 = await encodingCoverage(db.sql, rid2)
		const repackP3 = createRepack(db.sql).repack(rid2)
		let repack3Settled = false
		void repackP3.then(
			() => {
				repack3Settled = true
			},
			() => {
				repack3Settled = true
			},
		)
		await waitForPartialCoverage(db, rid2, beforeR3, () => repack3Settled)
		const pushP3 = attemptGit(["push", url2, `${head}:refs/heads/later`], MIRROR)
		const [rp3, pu3] = await Promise.all([repackP3, pushP3])
		if (rp3.wholes + rp3.deltas !== beforeR3.eligible - beforeR3.encoded) {
			throw new Error(
				`R3 repack covered ${rp3.wholes + rp3.deltas}/${beforeR3.eligible - beforeR3.encoded} pending objects`,
			)
		}
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
		// converge: repack every object the racing push added, then clone and compare
		const beforeConverge = await encodingCoverage(db.sql, rid2)
		const rp3b = await createRepack(db.sql).repack(rid2)
		if (rp3b.wholes + rp3b.deltas !== beforeConverge.eligible - beforeConverge.encoded) {
			throw new Error(
				`R3 converging repack covered ${rp3b.wholes + rp3b.deltas}/${beforeConverge.eligible - beforeConverge.encoded} pending objects`,
			)
		}
		const afterConverge = await encodingCoverage(db.sql, rid2)
		if (afterConverge.encoded !== afterConverge.eligible) {
			throw new Error(
				`R3 convergence left encoding coverage ${afterConverge.encoded}/${afterConverge.eligible}`,
			)
		}
		if (pu3.ok) {
			await assertCanonicalRealRepoStore(db.sql, rid2, oracle2, { kind: "repacked" })
		}
		const oracle2Clone = join(scratch.mk("oracle2c"), "o.git")
		await spawnGit(["clone", "--mirror", "-q", `file://${oracle2}`, oracle2Clone])
		const expect2 = await oracleState(oracle2Clone)
		const after3 = join(scratch.mk("after3"), "c.git")
		const cl3 = await attemptGit([
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
		else await verifyCanonicalClone("R3 clone after push‖repack", after3, expect2)
		report.push([
			"R3",
			`push ‖ repack (+converging repack ${rp3b.wholes}w+${rp3b.deltas}d)`,
			cl3.ok ? "pack valid, matches git" : "CLONE FAILED",
		])
	} finally {
		await server.close()
		await db.drop()
		scratch.cleanup()
	}

	console.log(`\n## ${SLUG} — drain races\n`)
	console.log(table(["race", "what", "verdict"], report))
	console.log(
		`\n${findings.length === 0 ? "VERDICT: clean — every established race matched git's refs and objects." : `VERDICT: ${findings.length} FINDING(S)`}`,
	)
	for (const f of findings) console.log(`  - ${f}`)
	if (findings.length > 0) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})

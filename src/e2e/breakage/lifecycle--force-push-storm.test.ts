/**
 * Lifecycle breakage — force-push storm: N rounds of
 *   advance → repack → force-move main back onto a divergent lineage (setRef)
 *   → delete staging ref → gc(0) → repack → clone/fsck/compare.
 * Half the rounds invert the gc/repack order.
 *
 * Converted from `breakage/lifecycle--force-push-storm.ts` (exploration 2),
 * mechanically and at full scale — 200 seed commits, six rounds, a 45-commit
 * divergent lineage per round off six different branch points. The oracle is a
 * plain `file://` bare remote driven through the same sequence; every round's
 * mirror clone must be fsck-clean and BYTE-identical (every reachable object's
 * raw bytes, hashed in oid order), not merely oid-identical. The source exits 1
 * when the bug reproduces; the assertions here state the correct outcome, so a
 * reproduction is a RED test.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { ZERO_OID } from "@/oid"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack, type RepackResult } from "@/store/repack"
import { parseRevListObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/storm"
const ROUNDS = 6
/** Each round's divergent lineage branches from a different point of main. */
const BRANCH_POINTS = [150, 100, 60, 170, 30, 120]
/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const RUNS_DIR = ".engine/runs/planner-updates"

/** Deterministic filler of a given length (hex, so it is poorly compressible). */
function filler(salt: string, len: number): string {
	let out = ""
	while (out.length < len) {
		out += createHash("sha1").update(`${salt}-${out.length}`).digest("hex")
	}
	return out.slice(0, len)
}

/** A uuid-shaped run directory name — 36 chars, so a tree entry costs ~63 bytes. */
function uuidName(seed: string): string {
	const h = createHash("sha1").update(seed).digest("hex")
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * Build a real git repo whose shape makes the delta tier bite: a flat,
 * append-only `.engine/runs/planner-updates` directory gaining one subdir per
 * commit (so the same tree path has `main+1` successive versions — many segments
 * at ANCHOR_EVERY=32).
 */
async function buildSource(dir: string, mainCommits: number): Promise<void> {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (content: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return m
	}

	const seeded: string[] = []
	for (let i = 0; i < 6; i++) {
		const m = blob(`# doc ${i}\n\n${filler(`doc-${i}-v0`, 600)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	for (let i = 0; i < mainCommits; i++) {
		const d = uuidName(`m-run-${i}`)
		const record = blob(`{"run":"${d}","payload":"${filler(`m-rec-${i}`, 400)}"}\n`)
		const stderr = blob(`${filler(`m-err-${i}`, 120)}\n`)
		const cm = next()
		const msg = `main run ${i}`
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${prev}\n` +
				`M 100644 :${record} ${RUNS_DIR}/${d}/record.json\n` +
				`M 100644 :${stderr} ${RUNS_DIR}/${d}/stderr\n`,
		)
		prev = cm
	}

	await spawnGit(["init", "-q", "-b", "main", dir])
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: out.join("") })
}

/** Append `count` append-only commits onto `fromSha`, on branch `branch`. */
async function lineage(
	dir: string,
	branch: string,
	fromSha: string,
	salt: string,
	count: number,
): Promise<void> {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (content: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return m
	}
	let prev: string | number = fromSha
	for (let i = 0; i < count; i++) {
		const d = uuidName(`${salt}-${i}`)
		const record = blob(`{"run":"${d}","payload":"${filler(`${salt}-rec-${i}`, 400)}"}\n`)
		const stderr = blob(`${filler(`${salt}-err-${i}`, 120)}\n`)
		const cm = next()
		const msg = `${salt} ${i}`
		out.push(
			`commit refs/heads/${branch}\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\n` +
				`from ${typeof prev === "string" ? prev : `:${prev}`}\n` +
				`M 100644 :${record} ${RUNS_DIR}/${d}/record.json\n` +
				`M 100644 :${stderr} ${RUNS_DIR}/${d}/stderr\n`,
		)
		prev = cm
	}
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: out.join("") })
}

async function revList(dir: string, rev: string): Promise<string[]> {
	const out = await spawnGit(["rev-list", "--reverse", rev], { cwd: dir })
	return out.stdout.trim().split("\n").filter(Boolean)
}

async function revParse(dir: string, rev: string): Promise<string> {
	return (await spawnGit(["rev-parse", rev], { cwd: dir })).stdout.trim()
}

type MirrorState = { refs: string[]; objects: string[]; fsck: string }

/** Mirror-clone `url` into `dest`, fsck --strict, and return the observable state. */
async function mirrorClone(url: string, dest: string): Promise<MirrorState> {
	await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
	const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
	// `for-each-ref`, not `show-ref`: show-ref exits 1 on a repo with no refs,
	// which spawnGit turns into a rejection and a false "clone failed".
	const refs = (
		await spawnGit(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: dest })
	).stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.sort()
	// `git fsck` exits 0 and prints `notice: ...` lines for non-problems (e.g.
	// "No default references" on a ref-less repo) — those are not defects.
	const fsckLines = `${fsck.stdout}${fsck.stderr}`
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("notice:"))
	const objects = parseRevListObjectOids(
		(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dest })).stdout,
	).sort()
	return { fsck: fsckLines.join("\n"), objects, refs }
}

/**
 * A byte-exact digest of a repo's whole reachable object set: one `cat-file
 * --batch` pass, hashing every object's `<oid> <type> <size>\n<raw bytes>` in
 * oid order. Two repos agree here iff every reachable object is byte-identical.
 */
async function objectBytesDigest(dir: string): Promise<string> {
	const unique = [
		...new Set(
			parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })).stdout,
			),
		),
	].sort()
	if (unique.length === 0) return "empty"
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${unique.join("\n")}\n`,
	})
	return createHash("sha256").update(res.stdoutBytes).digest("hex")
}

function diffLists(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
	const sa = new Set(a)
	const sb = new Set(b)
	return { onlyA: a.filter((x) => !sb.has(x)), onlyB: b.filter((x) => !sa.has(x)) }
}

/** Index into a fixture list, loudly (`noUncheckedIndexedAccess`). */
function at<T>(xs: T[], i: number): T {
	const v = xs[i]
	if (v === undefined) throw new Error(`fixture too short: index ${i} of ${xs.length}`)
	return v
}

type RoundResult = {
	round: number
	order: "gc→repack" | "repack→gc"
	stagingDeleteAccepted: boolean
	cloneError: string | null
	objectsOnlyPg: number
	objectsOnlyRef: number
	refsPg: string[]
	refsRef: string[]
	fsck: string
	bytesMatch: boolean
	converged: RepackResult | null
}

describe("lifecycle breakage — force-push storm", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const rounds: RoundResult[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-storm-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildSource(src, 200)
		const commits = await revList(src, "main")

		for (let r = 0; r < ROUNDS; r++) {
			await lineage(src, `alt${r}`, at(commits, at(BRANCH_POINTS, r)), `alt${r}`, 45)
		}

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])

		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = createRefStore(db.sql)

		// Seed: full main.
		const tip0 = at(commits, commits.length - 1)
		await spawnGit(["push", "-q", url, `${tip0}:refs/heads/main`], { cwd: src })
		await spawnGit(["push", "-q", ref, `${tip0}:refs/heads/main`], { cwd: src })
		await repack.repack(REPO)

		for (let r = 0; r < ROUNDS; r++) {
			const altTip = await revParse(src, `alt${r}`)
			const stage = `refs/heads/stage${r}`
			// 1. deliver the divergent objects under a staging ref (a create — allowed)
			await spawnGit(["push", "-q", url, `${altTip}:${stage}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${altTip}:${stage}`], { cwd: src })
			// 2. force-move main onto it (the platform's ref-move path)
			await refs.setRef(REPO, "refs/heads/main", altTip)
			await spawnGit(["update-ref", "refs/heads/main", altTip], { cwd: ref })
			// 3. retire the staging ref
			const okDel = await refs.applyRefUpdates(
				REPO,
				[{ newOid: ZERO_OID, oldOid: altTip, ref: stage }],
				false,
			)
			await spawnGit(["update-ref", "-d", stage, altTip], { cwd: ref })

			// 4/5. gc + repack, order alternating per round
			const gcFirst = r % 2 === 0
			if (gcFirst) {
				await gc.gc(REPO, { graceSeconds: 0 })
				await repack.repack(REPO)
			} else {
				await repack.repack(REPO)
				await gc.gc(REPO, { graceSeconds: 0 })
			}
			await repack.repack(REPO)
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })

			const a = dir(`pg-${r}`)
			const b = dir(`ref-${r}`)
			const base = {
				order: (gcFirst ? "gc→repack" : "repack→gc") as RoundResult["order"],
				round: r,
				stagingDeleteAccepted: at(okDel, 0),
			}
			let pgc: MirrorState
			try {
				pgc = await mirrorClone(url, a)
			} catch (err) {
				rounds.push({
					...base,
					bytesMatch: true,
					cloneError: (err as Error).message.slice(0, 400),
					converged: null,
					fsck: "",
					objectsOnlyPg: 0,
					objectsOnlyRef: 0,
					refsPg: [],
					refsRef: [],
				})
				continue
			}
			const refc = await mirrorClone(`file://${ref}`, b)
			const objDiff = diffLists(pgc.objects, refc.objects)
			// byte-exact: every reachable object's raw bytes, hashed in oid order
			const [dPg, dRef] = [await objectBytesDigest(a), await objectBytesDigest(b)]
			// a second repack must be a no-op after convergence
			rounds.push({
				...base,
				bytesMatch: dPg === dRef,
				cloneError: null,
				converged: await repack.repack(REPO),
				fsck: pgc.fsck,
				objectsOnlyPg: objDiff.onlyA.length,
				objectsOnlyRef: objDiff.onlyB.length,
				refsPg: pgc.refs,
				refsRef: refc.refs,
			})
			rmSync(a, { force: true, recursive: true })
			rmSync(b, { force: true, recursive: true })
		}
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("accepts the staging-ref delete in every round", () => {
		expect(
			rounds.filter((r) => !r.stagingDeleteAccepted).map((r) => `round ${r.round}`),
		).toEqual([])
	})

	it("serves a clonable repo after every force-push round", () => {
		expect(
			rounds
				.filter((r) => r.cloneError !== null)
				.map((r) => `round ${r.round} (${r.order}): ${r.cloneError}`),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			rounds
				.filter((r) => r.objectsOnlyPg > 0 || r.objectsOnlyRef > 0)
				.map(
					(r) =>
						`round ${r.round}: onlyPG=${r.objectsOnlyPg} onlyREF=${r.objectsOnlyRef}`,
				),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(rounds.map((r) => ({ refs: r.refsPg, round: r.round }))).toEqual(
			rounds.map((r) => ({ refs: r.refsRef, round: r.round })),
		)
	})

	it("serves byte-identical objects to the oracle", () => {
		expect(rounds.filter((r) => !r.bytesMatch).map((r) => `round ${r.round}`)).toEqual([])
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			rounds.filter((r) => r.fsck.length > 0).map((r) => `round ${r.round}: ${r.fsck}`),
		).toEqual([])
	})

	it("converges the repack in every round, in either gc/repack order", () => {
		expect(
			rounds
				.filter((r) => r.converged !== null)
				.filter((r) => r.converged?.deltas !== 0 || r.converged?.wholes !== 0)
				.map((r) => `round ${r.round} (${r.order}): ${JSON.stringify(r.converged)}`),
		).toEqual([])
	})
})

/**
 * Lifecycle breakage — the anchor-dies-delta-survives shape (design N3), iterated:
 * an orphan commit on a side ref reuses a MID-history tree, main rewinds, gc(0)
 * must sweep the now-dangling delta, and the tier must repair over many cycles.
 *
 * Converted from `breakage/lifecycle--anchor-death-cycles.ts` (exploration 3),
 * mechanically and at full scale — 200 seed commits, 5 cycles, a 50-commit
 * divergent lineage per cycle. The oracle is a plain `file://` bare remote
 * replaying exactly the same visible history: every mirror clone taken from pggit
 * must be `fsck --strict` clean and carry precisely the oracle's object set and
 * refs. The source script exits 1 when the bug reproduces; here the assertions
 * encode the CORRECT outcome, so a live reproduction shows up as a RED test.
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
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/anchor"
const CYCLES = 5
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

/** A uuid-shaped run directory name — 36 chars, so a tree entry costs ~63 bytes,
 * which is what the motivating repo measures. */
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

/** Sorted oids of every object reachable from any ref. */
async function objectsIn(dir: string): Promise<string[]> {
	return (await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })).stdout
		.split("\n")
		.map((l) => l.slice(0, 40))
		.filter((o) => /^[0-9a-f]{40}$/.test(o))
		.sort()
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
	return { fsck: fsckLines.join("\n"), objects: await objectsIn(dest), refs }
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

type CloneCheck = {
	tag: string
	cloneError: string | null
	objectsOnlyPg: number
	objectsOnlyRef: number
	refsPg: string[]
	refsRef: string[]
	fsck: string
}

describe("lifecycle breakage — anchor death cycles", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const checks: CloneCheck[] = []
	const convergence: { cycle: number; second: RepackResult }[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-anchor-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildSource(src, 200)
		const commits = await revList(src, "main")

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])

		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = createRefStore(db.sql)

		const check = async (tag: string): Promise<void> => {
			const a = dir(`pg-${tag}`)
			const b = dir(`rf-${tag}`)
			let pgc: MirrorState
			try {
				pgc = await mirrorClone(url, a)
			} catch (err) {
				checks.push({
					cloneError: (err as Error).message.slice(0, 400),
					fsck: "",
					objectsOnlyPg: 0,
					objectsOnlyRef: 0,
					refsPg: [],
					refsRef: [],
					tag,
				})
				return
			}
			const rfc = await mirrorClone(`file://${ref}`, b)
			const od = diffLists(pgc.objects, rfc.objects)
			checks.push({
				cloneError: null,
				fsck: pgc.fsck,
				objectsOnlyPg: od.onlyA.length,
				objectsOnlyRef: od.onlyB.length,
				refsPg: pgc.refs,
				refsRef: rfc.refs,
				tag,
			})
			rmSync(a, { force: true, recursive: true })
			rmSync(b, { force: true, recursive: true })
		}

		// seed the full main history on both sides
		const seedTip = at(commits, commits.length - 1)
		await spawnGit(["push", "-q", url, `${seedTip}:refs/heads/main`], { cwd: src })
		await spawnGit(["push", "-q", ref, `${seedTip}:refs/heads/main`], { cwd: src })
		await repack.repack(REPO)

		for (let c = 0; c < CYCLES; c++) {
			// 1. orphan commit reusing a MID-history tree, parked on its own ref
			const midTree = await revParse(src, `${at(commits, 100 + c * 7)}^{tree}`)
			const orphan = (
				await spawnGit(["commit-tree", midTree, "-m", `keep-${c}`], { cwd: src })
			).stdout.trim()
			const keepRef = `refs/heads/keep${c}`
			await spawnGit(["push", "-q", url, `${orphan}:${keepRef}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${orphan}:${keepRef}`], { cwd: src })

			// 2. rewind main hard to the seed commit — the anchors die, the orphan's
			//    mid-history trees survive.
			const rewindTo = at(commits, 0)
			await refs.setRef(REPO, "refs/heads/main", rewindTo)
			await spawnGit(["update-ref", "refs/heads/main", rewindTo], { cwd: ref })

			// 3. gc(0): the dangling-base sweep must fire here
			await gc.gc(REPO, { graceSeconds: 0 })
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })

			// 4. clone with the tier in its post-sweep (holed) state
			await check(`c${c}-postgc`)

			// 5. repair pass, then clone again; convergence must be immediate
			await repack.repack(REPO)
			convergence.push({ cycle: c, second: await repack.repack(REPO) })
			await check(`c${c}-postrepack`)

			// 6. advance main differently, re-using paths whose anchors were swept
			await lineage(src, `re${c}`, rewindTo, `re${c}`, 50)
			const newTip = await revParse(src, `re${c}`)
			await spawnGit(["push", "-q", url, `${newTip}:refs/heads/main`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${newTip}:refs/heads/main`], { cwd: src })
			await repack.repack(REPO)
			await check(`c${c}-advanced`)

			// 7. retire the keep ref so the next cycle's garbage is real garbage
			await refs.applyRefUpdates(
				REPO,
				[{ newOid: ZERO_OID, oldOid: orphan, ref: keepRef }],
				false,
			)
			await spawnGit(["update-ref", "-d", keepRef, orphan], { cwd: ref })
		}
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("serves a clonable repo at every point of every cycle", () => {
		expect(
			checks.filter((c) => c.cloneError !== null).map((c) => `${c.tag}: ${c.cloneError}`),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			checks
				.filter((c) => c.objectsOnlyPg > 0 || c.objectsOnlyRef > 0)
				.map((c) => `${c.tag}: onlyPG=${c.objectsOnlyPg} onlyREF=${c.objectsOnlyRef}`),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(checks.map((c) => ({ refs: c.refsPg, tag: c.tag }))).toEqual(
			checks.map((c) => ({ refs: c.refsRef, tag: c.tag })),
		)
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			checks.filter((c) => c.fsck.length > 0).map((c) => `${c.tag}: ${c.fsck}`),
		).toEqual([])
	})

	it("repack converges immediately after the dangling-base sweep", () => {
		expect(
			convergence
				.filter((c) => c.second.deltas !== 0 || c.second.wholes !== 0)
				.map((c) => `cycle ${c.cycle}: ${JSON.stringify(c.second)}`),
		).toEqual([])
	})
})

/**
 * Repack is idempotent across an incremental push chain: a 200-commit
 * append-only history delivered in five widening slices (40, 80, 120, 160, 201
 * commits), each followed by two repack passes and a mirror clone compared
 * against a plain `file://` bare remote carrying the same visible history.
 *
 * THE CONTRACT, per round: the FIRST repack does real work — each slice adds at
 * least 40 commits of genuinely new objects, and without that floor a repack
 * that permanently encoded nothing would satisfy every assertion here while the
 * clones quietly came off the undeltified raw path — and the SECOND is a strict
 * no-op, because the tier is derived and a pass over an already-covered repo has
 * nothing to write. Every round's clone must then be fsck-clean and carry exactly
 * the oracle's object set and refs.
 *
 * Originated as exploration-1 probe
 * `lifecycle--incremental-repack-idempotence.ts` (exit 1 when the second pass
 * wrote anything), which reproduced non-idempotent repack; fixed.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack, type RepackResult } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/probe"
/** Commit counts of each successive push — the last one is the whole history. */
const SLICES = [40, 80, 120, 160, 201]
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

async function revList(dir: string, rev: string): Promise<string[]> {
	const out = await spawnGit(["rev-list", "--reverse", rev], { cwd: dir })
	return out.stdout.trim().split("\n").filter(Boolean)
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

type RoundResult = {
	commits: number
	first: RepackResult
	second: RepackResult
	objectsOnlyPg: number
	objectsOnlyRef: number
	refsPg: string[]
	refsRef: string[]
	fsck: string
}

describe("lifecycle breakage — incremental repack idempotence", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const rounds: RoundResult[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-incr-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildSource(src, 200)
		const commits = await revList(src, "main")

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])

		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const repack = createRepack(db.sql)

		for (const [round, upto] of SLICES.entries()) {
			const tip = at(commits, upto - 1)
			await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${tip}:refs/heads/main`], { cwd: src })
			const first = await repack.repack(REPO)
			const second = await repack.repack(REPO)

			const a = dir(`pg-${round}`)
			const b = dir(`ref-${round}`)
			const pgc = await mirrorClone(url, a)
			const refc = await mirrorClone(`file://${ref}`, b)
			const objDiff = diffLists(pgc.objects, refc.objects)
			rounds.push({
				commits: upto,
				first,
				fsck: pgc.fsck,
				objectsOnlyPg: objDiff.onlyA.length,
				objectsOnlyRef: objDiff.onlyB.length,
				refsPg: pgc.refs,
				refsRef: refc.refs,
				second,
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

	it("does real encoding work in every incremental round", () => {
		// The floor under the no-op claim below: every slice adds at least 40 commits
		// of new objects, so a first pass that encoded nothing is a broken repack —
		// and one that permanently encodes nothing passes every other test in this
		// file, serving every clone off the raw path.
		expect(
			rounds
				.filter((r) => r.first.wholes + r.first.deltas === 0)
				.map((r) => `${r.commits} commits`),
		).toEqual([])
	})

	it("makes the second repack of every incremental round a strict no-op", () => {
		expect(
			rounds
				.filter((r) => r.second.deltas !== 0 || r.second.wholes !== 0)
				.map((r) => `${r.commits} commits: ${JSON.stringify(r.second)}`),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			rounds
				.filter((r) => r.objectsOnlyPg > 0 || r.objectsOnlyRef > 0)
				.map(
					(r) =>
						`${r.commits} commits: onlyPG=${r.objectsOnlyPg} onlyREF=${r.objectsOnlyRef}`,
				),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(rounds.map((r) => ({ commits: r.commits, refs: r.refsPg }))).toEqual(
			rounds.map((r) => ({ commits: r.commits, refs: r.refsRef })),
		)
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			rounds
				.filter((r) => r.fsck.length > 0)
				.map((r) => `${r.commits} commits: ${r.fsck}`),
		).toEqual([])
	})
})

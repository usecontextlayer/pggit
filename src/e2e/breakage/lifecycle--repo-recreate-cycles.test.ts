/**
 * Lifecycle breakage — repo deletion and recreation, five cycles, with components
 * built FRESH each cycle (so the stale-resolver defect covered by
 * `lifecycle--repo-recreate-silent-noop-repack` is out of the way and only
 * data-level resurrection is under test).
 *
 * Asks: does anything from a previous incarnation survive the cascade and attach
 * itself to the new repo? Same wire name, same object OIDs, new `repos.id` — an
 * encoding row (or edge, or ref) that outlived its repo would either FK-fail on
 * write or serve stale bytes. Each cycle ends with a clone compared byte-for-byte
 * against a file:// reference remote holding the same visible history.
 *
 * Full scale: 90 seed commits, five delete/recreate cycles.
 *
 * Originated as breakage probe `lifecycle--repo-recreate-cycles.ts` (exit 1 when
 * a cycle resurrected state from a previous incarnation); fixed.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack, type RepackResult } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/cycled"
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

/**
 * A byte-exact digest of a repo's whole reachable object set: one `cat-file
 * --batch` pass, hashing every object's `<oid> <type> <size>\n<raw bytes>` in
 * oid order. Two repos agree here iff every reachable object is byte-identical.
 */
async function objectBytesDigest(dir: string): Promise<string> {
	const unique = [...new Set(await objectsIn(dir))]
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

type CycleResult = {
	cycle: number
	first: RepackResult
	converged: RepackResult
	cloneError: string | null
	objectsOnlyPg: number
	objectsOnlyRef: number
	refsPg: string[]
	refsRef: string[]
	fsck: string
	bytesMatch: boolean
}

describe("lifecycle breakage — repo recreate cycles", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const cycles: CycleResult[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-cycles-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildSource(src, 90)
		const commits = await revList(src, "main")
		const tip = at(commits, commits.length - 1)
		const mid = at(commits, 45)

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
		await spawnGit(["push", "-q", ref, `${tip}:refs/heads/main`], { cwd: src })

		const deps = createGitDeps(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		for (let c = 0; c < CYCLES; c++) {
			// FRESH components each cycle — the documented-safe usage
			const repack = createRepack(db.sql)
			const gc = createGc(db.sql)
			const refs = createRefStore(db.sql)

			await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
			const first = await repack.repack(REPO)
			// churn: rewind, gc, advance again, repack
			await refs.setRef(REPO, "refs/heads/main", mid)
			await gc.gc(REPO, { batchLimit: 1_000_000, graceSeconds: 0 })
			await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
			await repack.repack(REPO)
			const converged = await repack.repack(REPO)

			const a = dir(`pg-${c}`)
			const b = dir(`rf-${c}`)
			let pgc: MirrorState
			try {
				pgc = await mirrorClone(url, a)
			} catch (err) {
				cycles.push({
					bytesMatch: true,
					cloneError: (err as Error).message.slice(0, 250),
					converged,
					cycle: c,
					first,
					fsck: "",
					objectsOnlyPg: 0,
					objectsOnlyRef: 0,
					refsPg: [],
					refsRef: [],
				})
				// No deleteRepo here: the source leaves a failed cycle's incarnation in
				// place, so the next cycle runs against it rather than a fresh repo.
				continue
			}
			const rfc = await mirrorClone(`file://${ref}`, b)
			const od = diffLists(pgc.objects, rfc.objects)
			const [dp, dr] = [await objectBytesDigest(a), await objectBytesDigest(b)]
			cycles.push({
				bytesMatch: dp === dr,
				cloneError: null,
				converged,
				cycle: c,
				first,
				fsck: pgc.fsck,
				objectsOnlyPg: od.onlyA.length,
				objectsOnlyRef: od.onlyB.length,
				refsPg: pgc.refs,
				refsRef: rfc.refs,
			})
			rmSync(a, { force: true, recursive: true })
			rmSync(b, { force: true, recursive: true })

			// tear the whole repo down and let the next cycle recreate it
			await deps.admin.deleteRepo(REPO)
		}
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("encodes a freshly recreated repo from scratch on every cycle", () => {
		expect(
			cycles
				.filter((c) => c.first.wholes + c.first.deltas === 0)
				.map((c) => `cycle ${c.cycle}: ${JSON.stringify(c.first)}`),
		).toEqual([])
	})

	it("converges the repack on every cycle", () => {
		expect(
			cycles
				.filter((c) => c.converged.deltas !== 0 || c.converged.wholes !== 0)
				.map((c) => `cycle ${c.cycle}: ${JSON.stringify(c.converged)}`),
		).toEqual([])
	})

	it("serves a clonable repo on every cycle", () => {
		expect(
			cycles
				.filter((c) => c.cloneError !== null)
				.map((c) => `cycle ${c.cycle}: ${c.cloneError}`),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			cycles
				.filter((c) => c.objectsOnlyPg > 0 || c.objectsOnlyRef > 0)
				.map(
					(c) =>
						`cycle ${c.cycle}: onlyPG=${c.objectsOnlyPg} onlyREF=${c.objectsOnlyRef}`,
				),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(cycles.map((c) => ({ cycle: c.cycle, refs: c.refsPg }))).toEqual(
			cycles.map((c) => ({ cycle: c.cycle, refs: c.refsRef })),
		)
	})

	it("serves byte-identical objects to the oracle", () => {
		expect(cycles.filter((c) => !c.bytesMatch).map((c) => `cycle ${c.cycle}`)).toEqual([])
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			cycles.filter((c) => c.fsck.length > 0).map((c) => `cycle ${c.cycle}: ${c.fsck}`),
		).toEqual([])
	})
})

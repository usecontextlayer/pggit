/**
 * Lifecycle breakage — degenerate ends of the sequence space:
 *  1. delete EVERY ref, gc(0) to zero objects, repack an empty repo, clone it
 *  2. refill with the identical history (same oids, fresh rows) and repack again
 *  3. a ref that points straight at a TREE whose encoding is a delta, with the
 *     anchor kept alive only by a SECOND ref — then that second ref is deleted
 *  4. a tree that becomes EMPTY (the 4b825dc... empty tree object) mid-history
 * Every step is checked against a file:// reference remote replaying the same
 * visible history: clone, fsck --strict, object-set equality, byte digest.
 *
 * Converted from `breakage/lifecycle--drain-to-empty-and-refill.ts`, mechanically
 * and at full scale (60 seed commits). The source exits 1 when a step reproduces
 * the bug; here each assertion states the CORRECT outcome, so a reproduction is a
 * RED test.
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

const REPO = "workspace/slate/degenerate"
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

type CloneCheck = {
	tag: string
	cloneError: string | null
	objectsOnlyPg: number
	objectsOnlyRef: number
	refsPg: string[]
	refsRef: string[]
	fsck: string
	bytesMatch: boolean
}

describe("lifecycle breakage — drain to empty and refill", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const checks: CloneCheck[] = []
	let emptied: RepackResult = { deltas: 0, wholes: 0 }
	let refilled: RepackResult = { deltas: 0, wholes: 0 }
	let refilledSecond: RepackResult = { deltas: 0, wholes: 0 }

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-degen-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildSource(src, 60)
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
					bytesMatch: true,
					cloneError: (err as Error).message.slice(0, 250),
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
			const [dp, dr] = [await objectBytesDigest(a), await objectBytesDigest(b)]
			checks.push({
				bytesMatch: dp === dr,
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
		const pushBoth = async (sha: string, name: string): Promise<void> => {
			await spawnGit(["push", "-q", url, `${sha}:${name}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${sha}:${name}`], { cwd: src })
		}
		const delBoth = async (name: string, old: string): Promise<void> => {
			await refs.applyRefUpdates(
				REPO,
				[{ newOid: ZERO_OID, oldOid: old, ref: name }],
				false,
			)
			await spawnGit(["update-ref", "-d", name, old], { cwd: ref })
		}

		const tip = at(commits, commits.length - 1)
		await pushBoth(tip, "refs/heads/main")
		await repack.repack(REPO)
		await check("seeded")

		// --- 1. drain to empty ------------------------------------------------
		await delBoth("refs/heads/main", tip)
		await gc.gc(REPO, { batchLimit: 1_000_000, graceSeconds: 0 })
		await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
		emptied = await repack.repack(REPO)
		await check("emptied")

		// --- 2. refill with the identical history ------------------------------
		await pushBoth(tip, "refs/heads/main")
		refilled = await repack.repack(REPO)
		refilledSecond = await repack.repack(REPO)
		await check("refilled")

		// --- 3. a ref straight at a TREE, anchor held alive by a second ref -----
		// commit 40's root tree is (with ANCHOR_EVERY=32) a delta against an earlier
		// anchor; park a tag on it while another ref keeps the anchor reachable.
		const midTree = (
			await spawnGit(["rev-parse", `${at(commits, 40)}^{tree}`], { cwd: src })
		).stdout.trim()
		await pushBoth(midTree, "refs/tags/tree40")
		await pushBoth(at(commits, 40), "refs/heads/keep40")
		await repack.repack(REPO)
		await check("tree-ref")

		// drop the branch that kept the anchor reachable, keep the tree tag
		await delBoth("refs/heads/keep40", at(commits, 40))
		await refs.setRef(REPO, "refs/heads/main", at(commits, 10))
		await spawnGit(["update-ref", "refs/heads/main", at(commits, 10)], { cwd: ref })
		await gc.gc(REPO, { batchLimit: 1_000_000, graceSeconds: 0 })
		await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
		await check("tree-ref-orphaned-anchor")
		await repack.repack(REPO)
		await check("tree-ref-repaired")

		// --- 4. a directory that becomes EMPTY --------------------------------
		// git cannot store an empty directory, but `git commit-tree` over a tree
		// that contains the empty-tree object can — exercise the zero-length object
		// through encode + serve.
		const emptyTree = (
			await spawnGit(["hash-object", "-t", "tree", "-w", "--stdin"], {
				cwd: src,
				input: Buffer.alloc(0),
			})
		).stdout.trim()
		const mk = await spawnGit(["mktree"], {
			cwd: src,
			input: `040000 tree ${emptyTree}\tempty\n`,
		})
		const withEmpty = (
			await spawnGit(["commit-tree", mk.stdout.trim(), "-m", "empty dir"], { cwd: src })
		).stdout.trim()
		await pushBoth(withEmpty, "refs/heads/emptydir")
		await repack.repack(REPO)
		await check("empty-tree")
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("serves a clonable repo at every degenerate point", () => {
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

	it("serves byte-identical objects to the oracle", () => {
		expect(checks.filter((c) => !c.bytesMatch).map((c) => c.tag)).toEqual([])
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			checks.filter((c) => c.fsck.length > 0).map((c) => `${c.tag}: ${c.fsck}`),
		).toEqual([])
	})

	it("finds no repack work in a repo with zero objects", () => {
		expect(emptied).toEqual({ deltas: 0, wholes: 0 })
	})

	it("re-encodes a refilled repo, then converges on the second pass", () => {
		expect(refilled.wholes + refilled.deltas).toBeGreaterThan(0)
		expect(refilledSecond).toEqual({ deltas: 0, wholes: 0 })
	})
})

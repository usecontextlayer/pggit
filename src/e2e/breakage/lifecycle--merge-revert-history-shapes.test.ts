/**
 * Lifecycle breakage — histories the commit walk has to work for: merges (2 and 3
 * parents), reverts (a commit whose tree EQUALS an ancestor's tree, so a lineage
 * runs backwards), criss-cross merges, and identical-content branches. Each
 * shape is repacked, gc'd, force-moved and cloned against a file:// oracle.
 *
 * Converted from `breakage/lifecycle--merge-revert-history-shapes.ts`
 * (exploration 9), mechanically and at full scale: a 120-commit append-only seed,
 * two 25-commit feature lineages, an octopus merge, a criss-cross pair, a twin
 * root, then a collapse (every branch force-moved back to commit 10) followed by
 * gc(0) and a repair repack. The source exits 1 on a mismatch; the assertions
 * here state the correct outcome, so a live reproduction is RED.
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

const REPO = "workspace/slate/shapes"
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

/** Append `count` single-file commits onto `fromSha` on `branch`; returns the tip. */
async function lineage(
	dir: string,
	branch: string,
	fromSha: string,
	salt: string,
	count: number,
): Promise<string> {
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
		const record = blob(`{"run":"${d}","payload":"${filler(`${salt}-r-${i}`, 300)}"}\n`)
		const cm = next()
		const msg = `${salt} ${i}`
		out.push(
			`commit refs/heads/${branch}\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\n` +
				`from ${typeof prev === "string" ? prev : `:${prev}`}\n` +
				`M 100644 :${record} ${RUNS_DIR}/${d}/record.json\n`,
		)
		prev = cm
	}
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: out.join("") })
	return (await spawnGit(["rev-parse", branch], { cwd: dir })).stdout.trim()
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

type CloneCheck = {
	tag: string
	cloneError: string | null
	objectsOnlyPg: number
	objectsOnlyRef: number
	refsPg: string[]
	refsRef: string[]
	fsck: string
}

describe("lifecycle breakage — merge, revert and criss-cross history shapes", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const checks: CloneCheck[] = []
	let collapseConverge: RepackResult = { deltas: 0, wholes: 0 }

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-shapes-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildSource(src, 120)
		const commits = await revList(src, "main")
		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = createRefStore(db.sql)

		const tree = async (rev: string): Promise<string> =>
			(await spawnGit(["rev-parse", `${rev}^{tree}`], { cwd: src })).stdout.trim()
		const commitTree = async (
			t: string,
			parents: string[],
			msg: string,
		): Promise<string> =>
			(
				await spawnGit(
					["commit-tree", t, ...parents.flatMap((p) => ["-p", p]), "-m", msg],
					{
						cwd: src,
					},
				)
			).stdout.trim()

		const check = async (tag: string): Promise<void> => {
			const a = dir(`pg-${tag}`)
			const b = dir(`rf-${tag}`)
			let pgc: MirrorState
			try {
				pgc = await mirrorClone(url, a)
			} catch (err) {
				checks.push({
					cloneError: (err as Error).message.slice(0, 300),
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
		const pushBoth = async (sha: string, name: string): Promise<void> => {
			await spawnGit(["push", "-q", url, `${sha}:${name}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${sha}:${name}`], { cwd: src })
		}

		// 1. linear seed
		await pushBoth(at(commits, 119), "refs/heads/main")
		await repack.repack(REPO)

		// 2. REVERT: a commit whose tree equals commit 60's tree, parented on the tip.
		//    The path lineage now runs BACKWARDS through an already-anchored version.
		const revert = await commitTree(
			await tree(at(commits, 60)),
			[at(commits, 119)],
			"revert to 60",
		)
		await pushBoth(revert, "refs/heads/main")
		await repack.repack(REPO)
		await check("revert")

		// 3. MERGES: two feature lineages off different points, merged with the
		//    merge's tree taken from one side (so first-parent diffing sees a big jump).
		const f1 = await lineage(src, "f1", at(commits, 40), "f1", 25)
		const f2 = await lineage(src, "f2", at(commits, 80), "f2", 25)
		await pushBoth(f1, "refs/heads/f1")
		await pushBoth(f2, "refs/heads/f2")
		const merge = await commitTree(await tree(f2), [revert, f1, f2], "octopus merge")
		await pushBoth(merge, "refs/heads/main")
		await repack.repack(REPO)
		await check("octopus")

		// 4. criss-cross: two merges each taking the other's side first
		const m1 = await commitTree(await tree(f1), [f1, f2], "m1")
		const m2 = await commitTree(await tree(f2), [f2, f1], "m2")
		await pushBoth(m1, "refs/heads/x1")
		await pushBoth(m2, "refs/heads/x2")
		const m3 = await commitTree(await tree(m1), [m1, m2], "m3")
		const m4 = await commitTree(await tree(m2), [m2, m1], "m4")
		await pushBoth(m3, "refs/heads/x1")
		await pushBoth(m4, "refs/heads/x2")
		await repack.repack(REPO)
		await check("crisscross")

		// 5. identical-content branch: the same tree under a different commit
		const twin = await commitTree(await tree(at(commits, 100)), [], "twin root")
		await pushBoth(twin, "refs/heads/twin")
		await repack.repack(REPO)
		await check("twin")

		// 6. force-move everything back, gc, repack, clone
		await refs.setRef(REPO, "refs/heads/main", at(commits, 10))
		await spawnGit(["update-ref", "refs/heads/main", at(commits, 10)], { cwd: ref })
		for (const b of ["f1", "f2", "x1", "x2"]) {
			await refs.setRef(REPO, `refs/heads/${b}`, at(commits, 10))
			await spawnGit(["update-ref", `refs/heads/${b}`, at(commits, 10)], { cwd: ref })
		}
		await gc.gc(REPO, { graceSeconds: 0 })
		await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
		await check("collapsed-pre-repack")
		await repack.repack(REPO)
		collapseConverge = await repack.repack(REPO)
		await check("collapsed-post-repack")
	}, 900_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("serves a clonable repo for every history shape", () => {
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

	it("converges the repack after the collapse", () => {
		expect(collapseConverge).toEqual({ deltas: 0, wholes: 0 })
	})
})

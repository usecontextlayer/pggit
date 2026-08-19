/**
 * Lifecycle breakage — 50-round incremental chain against a LONG-LIVED clone:
 * push 3 commits → (sometimes) repack → (sometimes) gc → fetch. Every round the
 * clone must stay fsck-clean and object-identical to a file:// reference remote
 * subjected to the same sequence. Mixed encoded/unencoded serving throughout.
 *
 * Full scale — 160 seed commits, 50 incremental rounds, then 8 rewind rounds
 * where a force-move + gc(0) + repack precedes a forced fetch and a FRESH mirror
 * clone (the real oracle for the SERVED state). Repack runs on 2 of every 3
 * rounds and gc every 7th, so the served pack mixes encoded and unencoded
 * objects.
 *
 * Originated as exploration-6 probe `lifecycle--long-lived-clone-chain.ts` (exit
 * 1 when a round diverged from the reference remote); fixed.
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
import { createRepack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/incr"
const ROUNDS = 50
const REWIND_ROUNDS = 8
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
	label: string
	fetchError: string | null
	objectsOnlyPg: number
	objectsOnlyRef: number
	fsck: string
}

describe("lifecycle breakage — long-lived clone chain", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const incremental: RoundResult[] = []
	const rewinds: RoundResult[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-chain-"))
		const dir = (name: string): string => join(root, name)

		const src = dir("src")
		await buildSource(src, 160)
		const commits = await revList(src, "main")

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])

		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = createRefStore(db.sql)

		// round 0: seed one commit, then two long-lived mirror clones
		await spawnGit(["push", "-q", url, `${at(commits, 0)}:refs/heads/main`], { cwd: src })
		await spawnGit(["push", "-q", ref, `${at(commits, 0)}:refs/heads/main`], { cwd: src })
		await repack.repack(REPO)
		const live = dir("live")
		const liveRef = dir("liveref")
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, live])
		await spawnGit(["clone", "-q", "--mirror", `file://${ref}`, liveRef])

		for (let r = 1; r <= ROUNDS; r++) {
			const upto = Math.min(1 + r * 3, commits.length)
			const tip = at(commits, upto - 1)
			await spawnGit(["push", "-q", url, `${tip}:refs/heads/main`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${tip}:refs/heads/main`], { cwd: src })
			// repack only on 2 out of every 3 rounds: the served pack mixes encoded
			// and unencoded objects.
			const didRepack = r % 3 !== 0
			if (didRepack) await repack.repack(REPO)
			// an occasional gc between push and repack (encodings never existed yet)
			if (r % 7 === 0) await gc.gc(REPO, { graceSeconds: 0 })

			const label = `round ${r} (repack=${didRepack})`
			try {
				await spawnGit(["fetch", "-q", "--prune", "origin"], { cwd: live })
			} catch (err) {
				incremental.push({
					fetchError: (err as Error).message.slice(0, 300),
					fsck: "",
					label,
					objectsOnlyPg: 0,
					objectsOnlyRef: 0,
				})
				continue
			}
			await spawnGit(["fetch", "-q", "--prune", "origin"], { cwd: liveRef })
			const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: live })
			const d = diffLists(await objectsIn(live), await objectsIn(liveRef))
			incremental.push({
				fetchError: null,
				fsck: `${fsck.stdout}${fsck.stderr}`.trim(),
				label,
				objectsOnlyPg: d.onlyA.length,
				objectsOnlyRef: d.onlyB.length,
			})
		}

		// now the same chain but with force-moves interleaved
		for (let r = 0; r < REWIND_ROUNDS; r++) {
			const back = at(commits, 40 + r * 5)
			await refs.setRef(REPO, "refs/heads/main", back)
			await spawnGit(["update-ref", "refs/heads/main", back], { cwd: ref })
			await gc.gc(REPO, { graceSeconds: 0 })
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
			await repack.repack(REPO)
			const forward = at(commits, Math.min(commits.length - 1, 60 + r * 8))
			await spawnGit(["push", "-q", url, `${forward}:refs/heads/main`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${forward}:refs/heads/main`], { cwd: src })
			await repack.repack(REPO)

			const label = `rewind round ${r}`
			try {
				await spawnGit(
					["fetch", "-q", "--prune", "--force", "origin", "+refs/heads/*:refs/heads/*"],
					{ cwd: live },
				)
			} catch (err) {
				rewinds.push({
					fetchError: (err as Error).message.slice(0, 300),
					fsck: "",
					label,
					objectsOnlyPg: 0,
					objectsOnlyRef: 0,
				})
				continue
			}
			// a fresh clone is the real oracle for the SERVED state
			const fresh = dir(`fresh-${r}`)
			const freshRef = dir(`freshref-${r}`)
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, fresh])
			await spawnGit(["clone", "-q", "--mirror", `file://${ref}`, freshRef])
			const f = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: fresh })
			const d = diffLists(await objectsIn(fresh), await objectsIn(freshRef))
			rewinds.push({
				fetchError: null,
				fsck: `${f.stdout}${f.stderr}`.trim(),
				label,
				objectsOnlyPg: d.onlyA.length,
				objectsOnlyRef: d.onlyB.length,
			})
			rmSync(fresh, { force: true, recursive: true })
			rmSync(freshRef, { force: true, recursive: true })
		}
	}, 1_800_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("serves every incremental fetch to the long-lived clone", () => {
		expect(
			incremental
				.filter((r) => r.fetchError !== null)
				.map((r) => `${r.label}: ${r.fetchError}`),
		).toEqual([])
	})

	it("keeps the long-lived clone object-identical to the oracle", () => {
		expect(
			incremental
				.filter((r) => r.objectsOnlyPg > 0 || r.objectsOnlyRef > 0)
				.map((r) => `${r.label}: onlyPG=${r.objectsOnlyPg} onlyREF=${r.objectsOnlyRef}`),
		).toEqual([])
	})

	it("keeps the long-lived clone fsck --strict clean", () => {
		expect(
			incremental.filter((r) => r.fsck.length > 0).map((r) => `${r.label}: ${r.fsck}`),
		).toEqual([])
	})

	it("serves every forced fetch after a rewind + gc + repack", () => {
		expect(
			rewinds
				.filter((r) => r.fetchError !== null)
				.map((r) => `${r.label}: ${r.fetchError}`),
		).toEqual([])
	})

	it("serves a rewound state a fresh clone finds identical to the oracle", () => {
		expect(
			rewinds
				.filter((r) => r.objectsOnlyPg > 0 || r.objectsOnlyRef > 0)
				.map((r) => `${r.label}: onlyPG=${r.objectsOnlyPg} onlyREF=${r.objectsOnlyRef}`),
		).toEqual([])
	})

	it("serves a rewound state that clones fsck --strict clean", () => {
		expect(
			rewinds.filter((r) => r.fsck.length > 0).map((r) => `${r.label}: ${r.fsck}`),
		).toEqual([])
	})
})

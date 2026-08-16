/**
 * Lifecycle breakage — exotic fetch shapes and grace splits, each run against
 * pggit TWICE: once with no encoding tier, once after repack. A difference
 * between the two is the tier's fault; identical failure in both is pre-existing.
 *
 * Converted from `breakage/lifecycle--exotic-fetch-and-grace-split.ts`
 * (exploration 8), mechanically and at full scale: four probes × two tier states
 * over 120-commit repos, then the grace-split sequence over a 140-commit repo.
 * The differential IS the property — the source exits 1 on a DIFF, so the
 * assertion here states the correct outcome (the two runs agree) and a live
 * divergence shows up RED.
 *
 * Each (probe, tier-state) run gets its own isolated schema, exactly as the
 * source did: the no-tier run must never see a repack the tier run performed.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack, type RepackResult } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/exotic"
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

type Probe = { name: string; run: (url: string, dest: string) => Promise<string> }

const PROBES: Probe[] = [
	{
		name: "mirror clone",
		run: async (url, dest) => {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			return `${(await objectsIn(dest)).length} objects`
		},
	},
	{
		name: "partial clone --filter=blob:none + checkout (lazy fetch)",
		run: async (url, dest) => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--filter=blob:none",
				url,
				dest,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			const n = (
				await spawnGit(["rev-list", "--count", "HEAD"], { cwd: dest })
			).stdout.trim()
			return `${n} commits, checkout ok`
		},
	},
	{
		name: "shallow clone --depth=1",
		run: async (url, dest) => {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--depth=1", url, dest])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			return `${(await objectsIn(dest)).length} objects`
		},
	},
	{
		name: "clone then deepen (fetch --unshallow)",
		run: async (url, dest) => {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--depth=5", url, dest])
			await spawnGit(["-c", "protocol.version=2", "fetch", "-q", "--unshallow"], {
				cwd: dest,
			})
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			return `${(await objectsIn(dest)).length} objects`
		},
	},
]

type ProbeOutcome = { name: string; noTier: string; withTier: string }

describe("lifecycle breakage — exotic fetch shapes and grace splits", () => {
	let root = ""
	const outcomes: ProbeOutcome[] = []
	let graceConverge: RepackResult = { deltas: 0, wholes: 0 }
	let graceOnlyPg = 0
	let graceOnlyRef = 0
	let graceFsck = ""

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-exotic-"))
		const dir = (name: string): string => join(root, name)
		const baseUrl = inject("pgBaseUrl")

		/** One (probe × tier-state) run on its own schema; returns the git-visible
		 * result, or the normalised failure reason. */
		const runProbe = async (
			probe: Probe,
			index: number,
			withTier: boolean,
		): Promise<string> => {
			const db = await createIsolatedSchema(baseUrl)
			try {
				const src = dir(`src-${index}-${withTier}`)
				await buildSource(src, 120)
				const commits = await revList(src, "main")
				const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
				const url = `http://127.0.0.1:${server.port}/${REPO}`
				await spawnGit(
					["push", "-q", url, `${at(commits, commits.length - 1)}:refs/heads/main`],
					{ cwd: src },
				)
				if (withTier) await createRepack(db.sql).repack(REPO)
				const dest = dir(`d-${index}-${withTier}`)
				let result: string
				try {
					result = await probe.run(url, dest)
				} catch (err) {
					// normalise the ephemeral port + temp paths out of the message so the
					// two runs are comparable; only the git-visible failure REASON matters
					const raw = (err as Error).message.split("\n").pop() ?? ""
					result = `THREW: ${raw
						.replace(/http:\/\/\S+/g, "<url>")
						.replace(/\/\S*T\/\S+/g, "<tmp>")
						.slice(0, 200)}`
				}
				rmSync(dest, { force: true, recursive: true })
				rmSync(src, { force: true, recursive: true })
				await server.close()
				return result
			} finally {
				await db.drop()
			}
		}

		for (const [index, probe] of PROBES.entries()) {
			outcomes.push({
				name: probe.name,
				noTier: await runProbe(probe, index, false),
				withTier: await runProbe(probe, index, true),
			})
		}

		// --- grace split: some garbage reclaimed, some retained, repack in between ---
		const db = await createIsolatedSchema(baseUrl)
		try {
			const src = dir("gsrc")
			await buildSource(src, 140)
			const commits = await revList(src, "main")
			const ref = dir("gref.git")
			await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
			const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
			const url = `http://127.0.0.1:${server.port}/${REPO}`
			const repack = createRepack(db.sql)
			const gc = createGc(db.sql)
			const refs = createRefStore(db.sql)

			await spawnGit(["push", "-q", url, `${at(commits, 99)}:refs/heads/main`], {
				cwd: src,
			})
			await spawnGit(["push", "-q", ref, `${at(commits, 99)}:refs/heads/main`], {
				cwd: src,
			})
			await repack.repack(REPO)
			await new Promise((r) => setTimeout(r, 2500))
			await spawnGit(["push", "-q", url, `${at(commits, 139)}:refs/heads/main`], {
				cwd: src,
			})
			await spawnGit(["push", "-q", ref, `${at(commits, 139)}:refs/heads/main`], {
				cwd: src,
			})
			await repack.repack(REPO)
			// rewind far back: everything after commit 50 is now garbage, but only the
			// FIRST push's objects are older than the 2s grace.
			await refs.setRef(REPO, "refs/heads/main", at(commits, 50))
			await spawnGit(["update-ref", "refs/heads/main", at(commits, 50)], { cwd: ref })
			await gc.gc(REPO, { graceSeconds: 2 })
			await repack.repack(REPO)
			await gc.gc(REPO, { graceSeconds: 0 })
			await repack.repack(REPO)
			graceConverge = await repack.repack(REPO)
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })

			const a = dir("gpg")
			const b = dir("gref")
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, a])
			await spawnGit(["clone", "-q", "--mirror", `file://${ref}`, b])
			const f = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: a })
			const d = diffLists(await objectsIn(a), await objectsIn(b))
			graceOnlyPg = d.onlyA.length
			graceOnlyRef = d.onlyB.length
			graceFsck = `${f.stdout}${f.stderr}`.trim()
			await server.close()
		} finally {
			await db.drop()
		}
	}, 900_000)

	afterAll(() => {
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("gives every exotic fetch shape the same outcome with and without the tier", () => {
		expect(
			outcomes
				.filter((o) => o.noTier !== o.withTier)
				.map((o) => `${o.name}: no-tier=${o.noTier} | w/ tier=${o.withTier}`),
		).toEqual([])
	})

	it("converges the repack after a grace split", () => {
		expect(graceConverge).toEqual({ deltas: 0, wholes: 0 })
	})

	it("clones the post-grace-split state identically to the file:// oracle", () => {
		expect({ onlyPg: graceOnlyPg, onlyRef: graceOnlyRef }).toEqual({
			onlyPg: 0,
			onlyRef: 0,
		})
	})

	it("clones the post-grace-split state fsck --strict clean", () => {
		expect(graceFsck).toBe("")
	})
})

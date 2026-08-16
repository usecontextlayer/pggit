/**
 * Lifecycle breakage — seeded randomized lifecycle fuzzer.
 *
 * Composes push / force-move (setRef) / ref-delete / orphan-commit / annotated
 * tag / gc(grace ∈ {0, huge}) / repack in random orders, keeping a plain
 * file:// bare remote in exact lockstep as the oracle. After every round: fresh
 * mirror clone from pggit, `fsck --strict`, and object/ref set equality against
 * a mirror clone of the reference.
 *
 * Converted from `breakage/lifecycle--randomized-sequence-fuzz.ts` (exploration
 * 7), mechanically and at full scale: a 140-commit seed and 40 rounds. The
 * source took `--seed=` / `--rounds=` off argv; in the test lane both are pinned
 * constants, the same discipline the generative differentials use so the gate is
 * deterministic. The source exits 1 on any mismatch; the assertions here state
 * the correct outcome, so a live reproduction is RED.
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
import { createRepack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/fuzz"
/** Pinned so the gate is deterministic (the source read these off argv). */
const SEED = 1
const ROUNDS = 40
/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const RUNS_DIR = ".engine/runs/planner-updates"

/** xorshift32 — the source's PRNG, kept verbatim so a seed reproduces a run. */
function rng(seed: number): () => number {
	let s = seed >>> 0 || 1
	return () => {
		s ^= s << 13
		s >>>= 0
		s ^= s >> 17
		s ^= s << 5
		s >>>= 0
		return s / 4294967296
	}
}

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

type RoundResult = {
	round: number
	note: string
	cloneError: string | null
	objectsOnlyPg: number
	objectsOnlyRef: number
	refsPg: string[]
	refsRef: string[]
	fsck: string
	bytesMatch: boolean
}

describe("lifecycle breakage — randomized sequence fuzz", () => {
	let db: IsolatedDb
	let server: GitServer
	let root = ""
	const rounds: RoundResult[] = []
	const opFailures: string[] = []
	const convergenceFailures: string[] = []

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		root = mkdtempSync(join(tmpdir(), `pggit-breakage-fuzz-${SEED}-`))
		const dir = (name: string): string => join(root, name)
		const rand = rng(SEED)
		const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T

		const src = dir("src")
		await buildSource(src, 140)
		const commits = await revList(src, "main")

		const ref = dir("ref.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const repack = createRepack(db.sql)
		const gc = createGc(db.sql)
		const refs = createRefStore(db.sql)

		/** pggit's ref state, mirrored to ref.git on every mutation. */
		const state = new Map<string, string>()
		const setBoth = async (name: string, oid: string): Promise<void> => {
			await refs.setRef(REPO, name, oid)
			await spawnGit(["update-ref", name, oid], { cwd: ref })
			state.set(name, oid)
		}
		const delBoth = async (name: string): Promise<void> => {
			const old = state.get(name)
			if (!old) return
			await refs.applyRefUpdates(
				REPO,
				[{ newOid: ZERO_OID, oldOid: old, ref: name }],
				false,
			)
			await spawnGit(["update-ref", "-d", name, old], { cwd: ref })
			state.delete(name)
		}
		const pushBoth = async (sha: string, name: string): Promise<void> => {
			await spawnGit(["push", "-q", url, `${sha}:${name}`], { cwd: src })
			await spawnGit(["push", "-q", ref, `${sha}:${name}`], { cwd: src })
			state.set(name, sha)
		}
		/** Commits currently reachable in the reference — safe force-move targets. */
		const reachableCommits = async (): Promise<string[]> => {
			const out = await spawnGit(["rev-list", "--all", "--max-count=400"], { cwd: ref })
			return out.stdout.trim().split("\n").filter(Boolean)
		}

		await pushBoth(at(commits, commits.length - 1), "refs/heads/main")
		await repack.repack(REPO)

		let lineageSeq = 0
		let tagSeq = 0
		for (let r = 0; r < ROUNDS; r++) {
			const op = pick([
				"advance",
				"advance",
				"force-move",
				"force-move",
				"delete-ref",
				"orphan",
				"tag",
				"branch",
				"gc0",
				"gc-grace",
				"gc-grace-split",
				"repack",
				"repack",
			])
			let note = op
			try {
				switch (op) {
					case "advance": {
						const base = pick([...state.values()].filter(Boolean))
						if (!base) break
						const br = `l${lineageSeq++}`
						const tip = await lineage(src, br, base, br, 5 + Math.floor(rand() * 40))
						const target = pick(
							[...state.keys()].filter((k) => k.startsWith("refs/heads/")),
						)
						// FF only when it really is one; otherwise a force-move
						const isFF = state.get(target) === base
						if (isFF) await pushBoth(tip, target)
						else {
							await spawnGit(["push", "-q", url, `${tip}:refs/heads/stg${lineageSeq}`], {
								cwd: src,
							})
							await spawnGit(["push", "-q", ref, `${tip}:refs/heads/stg${lineageSeq}`], {
								cwd: src,
							})
							state.set(`refs/heads/stg${lineageSeq}`, tip)
							await setBoth(target, tip)
							await delBoth(`refs/heads/stg${lineageSeq}`)
						}
						note = `advance ${target} (+${br})`
						break
					}
					case "force-move": {
						const target = pick(
							[...state.keys()].filter((k) => k.startsWith("refs/heads/")),
						)
						if (!target) break
						const cands = await reachableCommits()
						if (cands.length === 0) break
						const to = pick(cands)
						await setBoth(target, to)
						note = `force-move ${target} -> ${to.slice(0, 8)}`
						break
					}
					case "delete-ref": {
						const heads = [...state.keys()].filter((k) => k.startsWith("refs/heads/"))
						if (heads.length <= 1) break
						const target = pick(heads)
						await delBoth(target)
						note = `delete ${target}`
						break
					}
					case "orphan": {
						const cands = await reachableCommits()
						if (cands.length === 0) break
						const c = pick(cands)
						const tree = (
							await spawnGit(["rev-parse", `${c}^{tree}`], { cwd: src })
						).stdout.trim()
						const o = (
							await spawnGit(["commit-tree", tree, "-m", `orphan-${r}`], { cwd: src })
						).stdout.trim()
						await pushBoth(o, `refs/heads/orphan${r}`)
						note = `orphan from ${c.slice(0, 8)}`
						break
					}
					case "tag": {
						const cands = await reachableCommits()
						if (cands.length === 0) break
						const c = pick(cands)
						const name = `t${tagSeq++}`
						await spawnGit(["tag", "-a", name, "-m", `tag ${name}`, c], { cwd: src })
						const tagOid = (
							await spawnGit(["rev-parse", name], { cwd: src })
						).stdout.trim()
						await pushBoth(tagOid, `refs/tags/${name}`)
						note = `tag ${name}`
						break
					}
					case "branch": {
						const cands = await reachableCommits()
						if (cands.length === 0) break
						await pushBoth(pick(cands), `refs/heads/b${r}`)
						note = `branch b${r}`
						break
					}
					case "gc0": {
						const g = await gc.gc(REPO, { graceSeconds: 0 })
						await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
						note = `gc0 obj=${g.deletedObjects} enc=${g.deletedEncodings}`
						break
					}
					case "gc-grace": {
						const g = await gc.gc(REPO, { graceSeconds: 100000 })
						note = `gc-grace obj=${g.deletedObjects} enc=${g.deletedEncodings}`
						break
					}
					case "gc-grace-split": {
						// a grace window that actually SPLITS the garbage: older objects
						// are reclaimed while recently-pushed ones are retained.
						await new Promise((res) => setTimeout(res, 1600))
						const g = await gc.gc(REPO, { graceSeconds: 1 })
						await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
						note = `gc-split obj=${g.deletedObjects} enc=${g.deletedEncodings}`
						break
					}
					case "repack": {
						const p = await repack.repack(REPO)
						const p2 = await repack.repack(REPO)
						if (p2.deltas !== 0 || p2.wholes !== 0) {
							convergenceFailures.push(`round ${r}: ${JSON.stringify(p2)}`)
						}
						note = `repack ${p.wholes}w/${p.deltas}d`
						break
					}
				}
			} catch (err) {
				opFailures.push(`round ${r} op=${op}: ${(err as Error).message.slice(0, 300)}`)
				continue
			}

			const a = dir(`pg-${r}`)
			const b = dir(`rf-${r}`)
			let pgc: MirrorState
			try {
				pgc = await mirrorClone(url, a)
			} catch (err) {
				rounds.push({
					bytesMatch: true,
					cloneError: (err as Error).message.slice(0, 400),
					fsck: "",
					note,
					objectsOnlyPg: 0,
					objectsOnlyRef: 0,
					refsPg: [],
					refsRef: [],
					round: r,
				})
				continue
			}
			const rfc = await mirrorClone(`file://${ref}`, b)
			const od = diffLists(pgc.objects, rfc.objects)
			const [dpg, drf] = [await objectBytesDigest(a), await objectBytesDigest(b)]
			rounds.push({
				bytesMatch: dpg === drf,
				cloneError: null,
				fsck: pgc.fsck,
				note,
				objectsOnlyPg: od.onlyA.length,
				objectsOnlyRef: od.onlyB.length,
				refsPg: pgc.refs,
				refsRef: rfc.refs,
				round: r,
			})
			rmSync(a, { force: true, recursive: true })
			rmSync(b, { force: true, recursive: true })
		}
	}, 1_800_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("completes every fuzzed lifecycle operation without throwing", () => {
		expect(opFailures).toEqual([])
	})

	it("converges the repack every time the fuzzer repacks", () => {
		expect(convergenceFailures).toEqual([])
	})

	it("serves a clonable repo after every fuzzed round", () => {
		expect(
			rounds
				.filter((r) => r.cloneError !== null)
				.map((r) => `round ${r.round} [${r.note}]: ${r.cloneError}`),
		).toEqual([])
	})

	it("hands the client exactly the oracle's object set", () => {
		expect(
			rounds
				.filter((r) => r.objectsOnlyPg > 0 || r.objectsOnlyRef > 0)
				.map(
					(r) =>
						`round ${r.round} [${r.note}]: onlyPG=${r.objectsOnlyPg} onlyREF=${r.objectsOnlyRef}`,
				),
		).toEqual([])
	})

	it("hands the client exactly the oracle's refs", () => {
		expect(rounds.map((r) => ({ refs: r.refsPg, round: r.round }))).toEqual(
			rounds.map((r) => ({ refs: r.refsRef, round: r.round })),
		)
	})

	it("serves byte-identical objects to the oracle", () => {
		expect(
			rounds.filter((r) => !r.bytesMatch).map((r) => `round ${r.round} [${r.note}]`),
		).toEqual([])
	})

	it("every clone passes git fsck --strict", () => {
		expect(
			rounds
				.filter((r) => r.fsck.length > 0)
				.map((r) => `round ${r.round} [${r.note}]: ${r.fsck}`),
		).toEqual([])
	})
})

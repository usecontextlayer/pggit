/**
 * Lifecycle breakage — the randomized lifecycle SEQUENCE, as a fast-check property.
 *
 * Composes push / force-move (setRef) / ref-delete / orphan-commit / annotated tag
 * / branch-create / gc(grace) / object-aging / repack in a generated order, keeping
 * a plain `file://` bare remote in exact lockstep as the oracle. After every command
 * that changed anything: a fresh mirror clone from pggit, `fsck --strict`, and
 * object-set / ref-set / object-BYTES equality against a mirror clone of the
 * reference. No subsystem's own fixtures drive this composition — each generative
 * differential is scoped to one subsystem, and the lifecycle is what happens when
 * they interleave.
 *
 * WHY A PROPERTY (finding [2.15]). Every ingredient of a command model was already
 * here — the same lockstep oracle, the same weighted op list — but the driver was a
 * hand-rolled xorshift32 PRNG at one pinned seed with 40 fixed rounds and no
 * shrinking. It therefore explored ONE path through the lifecycle state space and,
 * on a divergence, handed the maintainer "seed 1, round 27 of 40" instead of the two
 * or three commands that actually matter. fast-check draws the same commands, each
 * carrying its OWN generated parameters (which ref, how deep the rewind, how much
 * grace) rather than drawing them from an ambient PRNG, and shrinks a failure to a
 * minimal sequence. The invariants are unchanged.
 *
 * DETERMINISM, and why each run is hermetic:
 *   - the fast-check seed is pinned (424_242), like every §8.4 differential;
 *   - EVERY run carves its own `createIsolatedSchema` + its own source/reference
 *     repos, so a shrink replay can never inherit the previous candidate's rows
 *     (the hazard recorded against `gc-scheduler.spec`);
 *   - GC's grace window is made deterministic by `ageObjects` + a generated
 *     `graceSeconds`, never a wall-clock sleep: `age` ages every row the store holds
 *     so far, so a later `gc` with a middling grace reclaims exactly the cohort that
 *     predates the aging and retains everything pushed after it — the split the
 *     original file bought with a 1.6 s `setTimeout`.
 *
 * Originated as exploration-7 probe `lifecycle--randomized-sequence-fuzz.ts`
 * (exit 1 on any mismatch against the file:// oracle); fixed, then converted.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { ZERO_OID } from "@/oid"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { ageObjects } from "@/testing/gc-helpers"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/fuzz"
/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const RUNS_DIR = ".engine/runs/planner-updates"

/** The seed history every candidate starts from. Small enough that a per-command
 * mirror-clone comparison is cheap, wide enough that the delta tier engages. */
const SOURCE_COMMITS = 24
const NUM_RUNS = 4
const MIN_COMMANDS = 10
const MAX_COMMANDS = 16

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

/**
 * A byte-exact digest of a repo's whole reachable object set: one `cat-file
 * --batch` pass, hashing every object's `<oid> <type> <size>\n<raw bytes>` in
 * oid order. Two repos agree here iff every reachable object is byte-identical.
 */
async function objectBytesDigest(dir: string, objects: string[]): Promise<string> {
	const unique = [...new Set(objects)]
	if (unique.length === 0) return "empty"
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${unique.join("\n")}\n`,
	})
	return createHash("sha256").update(res.stdoutBytes).digest("hex")
}

/** Everything a client can observe about one remote, through a real mirror clone. */
type MirrorState = { refs: string[]; objects: string[]; digest: string; fsck: string }

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
	const objects = await objectsIn(dest)
	return {
		digest: await objectBytesDigest(dest, objects),
		fsck: fsckLines.join("\n"),
		objects,
		refs,
	}
}

/** Index into a fixture list, loudly (`noUncheckedIndexedAccess`). */
function at<T>(xs: T[], i: number): T {
	const v = xs[i]
	if (v === undefined) throw new Error(`fixture too short: index ${i} of ${xs.length}`)
	return v
}

/** Wraparound index into a non-empty list — how every generated index lands on a
 * live ref/commit, so a shrunk sequence stays replayable. */
function pick<T>(xs: readonly T[], idx: number): T {
	const v = xs[idx % xs.length]
	if (v === undefined) throw new Error("pick: empty list")
	return v
}

// ── the generated lifecycle language ────────────────────────────────────────
// One command per lifecycle operation the original op list drew, each carrying its
// own parameters instead of consuming the ambient PRNG. Weights mirror the original
// weighted pick list (advance / force-move / repack were doubled there).

type Command =
	| { kind: "advance"; branch: number; target: number; commits: number }
	| { kind: "forceMove"; target: number; to: number }
	| { kind: "deleteRef"; target: number }
	| { kind: "orphan"; from: number }
	| { kind: "tag"; from: number }
	| { kind: "branch"; from: number }
	| { kind: "gc"; grace: number }
	| { kind: "age" }
	| { kind: "repack" }

const commandArb: fc.Arbitrary<Command> = fc.oneof(
	{
		arbitrary: fc.record({
			branch: fc.nat(),
			commits: fc.integer({ max: 6, min: 1 }),
			kind: fc.constant<"advance">("advance"),
			target: fc.nat(),
		}),
		weight: 2,
	},
	{
		arbitrary: fc.record({
			kind: fc.constant<"forceMove">("forceMove"),
			target: fc.nat(),
			to: fc.nat(),
		}),
		weight: 2,
	},
	{
		arbitrary: fc.record({
			kind: fc.constant<"deleteRef">("deleteRef"),
			target: fc.nat(),
		}),
		weight: 1,
	},
	{
		arbitrary: fc.record({ from: fc.nat(), kind: fc.constant<"orphan">("orphan") }),
		weight: 1,
	},
	{
		arbitrary: fc.record({ from: fc.nat(), kind: fc.constant<"tag">("tag") }),
		weight: 1,
	},
	{
		arbitrary: fc.record({ from: fc.nat(), kind: fc.constant<"branch">("branch") }),
		weight: 1,
	},
	{
		// 0 reclaims every unreachable object; 100000 retains all of them; 1800 is the
		// splitting window — with `age` it reclaims the old cohort and keeps the new.
		// 0 is drawn twice: only a reclaiming pass puts GC's deletes under the oracle
		// comparison at all, and the `gcDeleted` floor below is what holds that true.
		arbitrary: fc.record({
			grace: fc.constantFrom(0, 0, 1800, 100_000),
			kind: fc.constant<"gc">("gc"),
		}),
		weight: 2,
	},
	{ arbitrary: fc.constant<Command>({ kind: "age" }), weight: 1 },
	{ arbitrary: fc.constant<Command>({ kind: "repack" }), weight: 2 },
)

/** How often each command kind actually EXECUTED across the corpus (a command whose
 * precondition failed is skipped, exactly like `generative/commands.ts`), plus the
 * work GC and repack did. Floored after the run so a model regression that silently
 * degraded every candidate to "push once, clone" cannot pass unnoticed. */
type Tally = {
	advance: number
	forceMove: number
	deleteRef: number
	orphan: number
	tag: number
	branch: number
	gc: number
	age: number
	repack: number
	comparisons: number
	gcDeleted: number
	repackRows: number
}

function newTally(): Tally {
	return {
		advance: 0,
		age: 0,
		branch: 0,
		comparisons: 0,
		deleteRef: 0,
		forceMove: 0,
		gc: 0,
		gcDeleted: 0,
		orphan: 0,
		repack: 0,
		repackRows: 0,
		tag: 0,
	}
}

/**
 * Drive ONE generated sequence against a fresh store and a fresh `file://` oracle,
 * asserting the whole invariant set after every command that changed anything.
 * Every git/store failure propagates: an operation the model considered valid must
 * not throw, which is the original file's "completes every fuzzed lifecycle
 * operation without throwing" — now a shrinkable failure instead of a collected one.
 */
async function runSequence(
	baseUrl: string,
	commands: Command[],
	tally: Tally,
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pggit-breakage-fuzz-"))
	const dir = (name: string): string => join(root, name)
	const db = await createIsolatedSchema(baseUrl)
	let server: GitServer | undefined
	try {
		const src = dir("src")
		await buildSource(src, SOURCE_COMMITS)
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
		const heads = (): string[] =>
			[...state.keys()].filter((k) => k.startsWith("refs/heads/")).sort()

		await pushBoth(at(commits, commits.length - 1), "refs/heads/main")
		await repack.repack(REPO)

		let seq = 0
		for (const [round, command] of commands.entries()) {
			// A command whose precondition does not hold is a silent no-op (the
			// "sensible but randomized" discipline); `note` stays null and the round
			// costs no clone, because the state it would compare is the previous one.
			let note: string | null = null
			switch (command.kind) {
				case "advance": {
					// Bases come from BRANCH tips only: a tag ref names a tag object, and
					// fast-import's `from` demands a commit.
					const base = state.get(pick(heads(), command.branch))
					if (base === undefined) break
					const branch = `l${seq++}`
					const tip = await lineage(src, branch, base, branch, command.commits)
					const target = pick(heads(), command.target)
					// FF only when it really is one; otherwise a force-move.
					if (state.get(target) === base) await pushBoth(tip, target)
					else {
						const staging = `refs/heads/stg${seq++}`
						await spawnGit(["push", "-q", url, `${tip}:${staging}`], { cwd: src })
						await spawnGit(["push", "-q", ref, `${tip}:${staging}`], { cwd: src })
						state.set(staging, tip)
						await setBoth(target, tip)
						await delBoth(staging)
					}
					tally.advance++
					note = `advance ${target} (+${branch}, ${command.commits})`
					break
				}
				case "forceMove": {
					const cands = await reachableCommits()
					if (cands.length === 0) break
					const target = pick(heads(), command.target)
					const to = pick(cands, command.to)
					await setBoth(target, to)
					tally.forceMove++
					note = `force-move ${target} -> ${to.slice(0, 8)}`
					break
				}
				case "deleteRef": {
					// Tag refs are deletable unconditionally; a head only while another
					// head survives it, so the repo never runs out of branches to move.
					const live = [...state.keys()]
						.filter((name) => !name.startsWith("refs/heads/") || heads().length > 1)
						.sort()
					if (live.length === 0) break
					const target = pick(live, command.target)
					await delBoth(target)
					tally.deleteRef++
					note = `delete ${target}`
					break
				}
				case "orphan": {
					const cands = await reachableCommits()
					if (cands.length === 0) break
					const from = pick(cands, command.from)
					const tree = (
						await spawnGit(["rev-parse", `${from}^{tree}`], { cwd: src })
					).stdout.trim()
					const orphan = (
						await spawnGit(["commit-tree", tree, "-m", `orphan-${seq++}`], { cwd: src })
					).stdout.trim()
					await pushBoth(orphan, `refs/heads/orphan${round}`)
					tally.orphan++
					note = `orphan from ${from.slice(0, 8)}`
					break
				}
				case "tag": {
					const cands = await reachableCommits()
					if (cands.length === 0) break
					const from = pick(cands, command.from)
					const name = `t${seq++}`
					await spawnGit(["tag", "-a", name, "-m", `tag ${name}`, from], { cwd: src })
					const tagOid = (await spawnGit(["rev-parse", name], { cwd: src })).stdout.trim()
					await pushBoth(tagOid, `refs/tags/${name}`)
					tally.tag++
					note = `tag ${name}`
					break
				}
				case "branch": {
					const cands = await reachableCommits()
					if (cands.length === 0) break
					await pushBoth(pick(cands, command.from), `refs/heads/b${round}`)
					tally.branch++
					note = `branch b${round}`
					break
				}
				case "gc": {
					const result = await gc.gc(REPO, { graceSeconds: command.grace })
					// The oracle keeps its own garbage only when pggit was told to keep
					// its own; unreachable objects are invisible to a mirror clone either
					// way, so this only keeps the two repos operationally alike.
					if (command.grace === 0)
						await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })
					tally.gc++
					tally.gcDeleted += result.deletedObjects
					note = `gc grace=${command.grace} obj=${result.deletedObjects}`
					break
				}
				case "age": {
					// Every row the store holds becomes an hour old, so the NEXT gc with a
					// middling grace splits the garbage by cohort — deterministically, where
					// the original file slept 1.6 s and hoped.
					await ageObjects(db, REPO, "1 hour")
					tally.age++
					note = "age 1h"
					break
				}
				case "repack": {
					const first = await repack.repack(REPO)
					const second = await repack.repack(REPO)
					expect(
						second,
						`round ${round}: the second repack pass was not a no-op`,
					).toEqual({ deltas: 0, wholes: 0 })
					tally.repack++
					tally.repackRows += first.wholes + first.deltas
					note = `repack ${first.wholes}w/${first.deltas}d`
					break
				}
			}
			if (note === null) continue

			const served = await mirrorClone(url, dir(`pg-${round}`))
			const oracle = await mirrorClone(`file://${ref}`, dir(`rf-${round}`))
			const label = `round ${round} [${note}]`
			tally.comparisons++
			expect(served.fsck, `${label}: the clone is not fsck --strict clean`).toBe("")
			expect(
				{ digest: served.digest, objects: served.objects, refs: served.refs },
				`${label}: pggit and the file:// oracle diverged`,
			).toEqual({
				digest: oracle.digest,
				objects: oracle.objects,
				refs: oracle.refs,
			})
			rmSync(dir(`pg-${round}`), { force: true, recursive: true })
			rmSync(dir(`rf-${round}`), { force: true, recursive: true })
		}
	} finally {
		await server?.close()
		await db.drop()
		rmSync(root, { force: true, recursive: true })
	}
}

/**
 * Corpus floors — what the pinned seed MEASURABLY realizes at `NUM_RUNS`. Without
 * them a model regression that made every command skip (no heads to pick, no
 * reachable commits) would leave a green suite that clones a static repo, and the
 * `gcDeleted` / `repackRows` floors are what keep "GC ran" and "repack ran" from
 * meaning "GC and repack did nothing".
 */
const FLOORS = {
	advance: 10,
	age: 7,
	branch: 5,
	comparisons: 49,
	deleteRef: 2,
	forceMove: 6,
	gc: 7,
	gcDeleted: 170,
	orphan: 2,
	repack: 4,
	repackRows: 118,
	tag: 6,
} as const

describe("lifecycle breakage — randomized sequence fuzz", () => {
	it("keeps pggit byte-identical to a file:// oracle through any lifecycle sequence", async () => {
		const baseUrl = inject("pgBaseUrl")
		const tally = newTally()

		await fc.assert(
			fc.asyncProperty(
				fc.array(commandArb, { maxLength: MAX_COMMANDS, minLength: MIN_COMMANDS }),
				async (commands) => {
					await runSequence(baseUrl, commands, tally)
				},
			),
			{ numRuns: NUM_RUNS, seed: 424_242 },
		)

		const corpus = JSON.stringify(tally)
		console.log(`[lifecycle-fuzz corpus] ${corpus}`)
		for (const [name, floor] of Object.entries(FLOORS)) {
			expect(
				tally[name as keyof Tally],
				`the corpus under-exercised ${name} — corpus ${corpus}`,
			).toBeGreaterThanOrEqual(floor)
		}
	}, 1_800_000)
})

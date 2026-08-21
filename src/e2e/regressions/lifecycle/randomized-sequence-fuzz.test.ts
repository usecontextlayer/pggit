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
import { rmSync } from "node:fs"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, inject, it } from "vitest"
import { assertNever } from "@/assert-never"
import { ZERO_OID } from "@/object/oid"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import {
	appendLifecycleBranch,
	buildLifecycleSource,
	commitsOldestFirst,
} from "@/testing/append-only-repo"
import { ageObjects } from "@/testing/gc-helpers"
import { cyclicAt, mirrorClone, requiredAt } from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

const REPO = "workspace/slate/fuzz"

/** The seed history every candidate starts from. Small enough that a per-command
 * mirror-clone comparison is cheap, wide enough that the delta tier engages. */
const SOURCE_COMMITS = 24
const NUM_RUNS = 4
const MIN_COMMANDS = 10
const MAX_COMMANDS = 16

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
	return withTempDir("pggit-breakage-fuzz-", async (root) => {
		const dir = (name: string): string => join(root, name)
		const fixture = await setupGitServerFixture(baseUrl)
		const { db, server } = fixture
		try {
			const src = dir("src")
			await buildLifecycleSource(src, SOURCE_COMMITS)
			const commits = await commitsOldestFirst(src, "main")

			const ref = dir("ref.git")
			await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
			const url = repoUrl(server, REPO)
			const repack = createRepack(db.sql)
			const gc = createGc(db.sql)
			const refs = fixture.deps.refs

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

			await pushBoth(
				requiredAt(commits, commits.length - 1, "main commit history"),
				"refs/heads/main",
			)
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
						const base = state.get(cyclicAt(heads(), command.branch))
						if (base === undefined) break
						const branch = `l${seq++}`
						const tip = await appendLifecycleBranch(
							src,
							branch,
							base,
							branch,
							command.commits,
						)
						const target = cyclicAt(heads(), command.target)
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
						const target = cyclicAt(heads(), command.target)
						const to = cyclicAt(cands, command.to)
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
						const target = cyclicAt(live, command.target)
						await delBoth(target)
						tally.deleteRef++
						note = `delete ${target}`
						break
					}
					case "orphan": {
						const cands = await reachableCommits()
						if (cands.length === 0) break
						const from = cyclicAt(cands, command.from)
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
						const from = cyclicAt(cands, command.from)
						const name = `t${seq++}`
						await spawnGit(["tag", "-a", name, "-m", `tag ${name}`, from], { cwd: src })
						const tagOid = (
							await spawnGit(["rev-parse", name], { cwd: src })
						).stdout.trim()
						await pushBoth(tagOid, `refs/tags/${name}`)
						tally.tag++
						note = `tag ${name}`
						break
					}
					case "branch": {
						const cands = await reachableCommits()
						if (cands.length === 0) break
						await pushBoth(cyclicAt(cands, command.from), `refs/heads/b${round}`)
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
					default:
						assertNever(command)
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
			await teardownGitServerFixture(fixture)
		}
	})
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

describe("regressions/lifecycle — randomized sequence fuzz", () => {
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

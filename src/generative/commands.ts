/**
 * The state-aware git-command generator (spec §6) — the reusable CORE of the
 * §8.4 generative kernel differential. A fast-check arbitrary produces a random
 * list of git commands (one list = one "test-spec" = one candidate repo);
 * `buildRepoFromCommands` replays it via `spawnGit` into a real repo on disk.
 *
 * "Sensible but randomized": every command is applied through a `step` that
 * tracks a small model of repo state and only runs git when the operation is
 * valid (no `merge` before a second branch, no `commit` with nothing to commit,
 * no `checkout` with a dirty tree, no duplicate branch/tag). Commands that are
 * not currently valid are skipped — so a generated list NEVER makes `git` exit
 * non-zero. fast-check shrinks the list (drop commands) to localize a failure.
 *
 * One command is a MACRO — `divergeAndMerge` expands into a fixed primitive
 * sequence resolved against the live model. It exists because the shape a uniform
 * draw cannot reach is the one every consumer needs most: a multi-parent commit.
 *
 * Every skip is a silent `return`, so a regression that makes a whole command kind
 * unreachable (branches never recorded, merges always skipped, tags never created)
 * would degrade every candidate in EVERY consuming differential to a linear
 * single-branch repo without reddening any of them. `commands.test.ts` is where that
 * is caught: it folds each candidate's realized shape in from the real-git oracle and
 * floors the corpus, so the silent-skip design cannot silently empty the corpus.
 *
 * The differential ASSERTION is NOT here — it runs in the §7 properties AFTER the
 * whole list is replayed. This module only manufactures the candidate repo.
 *
 * Commit messages are unique per commit (`commit <seq>`) so two commits never
 * collapse to the same OID under `spawnGit`'s pinned clock (spec §6 determinism).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import fc from "fast-check"
import { assertNever } from "@/assert-never"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

// Bounded pools: reuse drives edits/overwrites + nested trees, and keeps the
// candidate space small enough to shrink well.
const PATHS = [
	"a.txt",
	"b.txt",
	"sub/c.txt",
	"sub/d.txt",
	"deep/x/y.txt",
	"e.bin",
	"f.txt",
	"g.txt",
] as const
const NAMES = ["feature", "topic", "dev", "release", "hotfix"] as const

type ContentSpec =
	| { kind: "empty" }
	| { kind: "text"; value: string }
	| { kind: "binary"; bytes: number[] }

type GenCommand =
	| { kind: "writeFile"; path: string; content: ContentSpec }
	| { kind: "deleteFile"; idx: number }
	| { kind: "commit" }
	| { kind: "branch"; idx: number }
	| { kind: "checkout"; idx: number }
	| { kind: "merge"; idx: number }
	| { kind: "tag"; idx: number; annotated: boolean }
	/** Macro: diverge a sibling branch off the current tip and merge it back —
	 * the one command that guarantees a multi-parent commit (see `step`). */
	| { kind: "divergeAndMerge"; nameIdx: number; pathIdx: number }

type RepoModel = {
	dir: string
	currentBranch: string
	/** Branches that point at a commit — i.e. exactly what `git branch` lists. */
	existingBranches: Set<string>
	tags: Set<string>
	/** Working tree differs from HEAD (there is something to commit). */
	dirty: boolean
	commitCount: number
	commitSeq: number
}

const contentArb: fc.Arbitrary<ContentSpec> = fc.oneof(
	fc.constant<ContentSpec>({ kind: "empty" }),
	fc.string().map<ContentSpec>((value) => ({ kind: "text", value })),
	// Binary content incl. NUL (0) and high bytes (255) — exercises the binary-safe paths.
	fc
		.array(fc.integer({ max: 255, min: 0 }), { maxLength: 64 })
		.map<ContentSpec>((bytes) => ({ bytes, kind: "binary" })),
)

const commandArb: fc.Arbitrary<GenCommand> = fc.oneof(
	// Weighted toward content + commits so most candidates have real history.
	{
		arbitrary: fc.record({
			content: contentArb,
			kind: fc.constant<"writeFile">("writeFile"),
			path: fc.constantFrom(...PATHS),
		}),
		weight: 4,
	},
	{ arbitrary: fc.constant<GenCommand>({ kind: "commit" }), weight: 3 },
	{
		arbitrary: fc.record({
			idx: fc.nat(),
			kind: fc.constant<"deleteFile">("deleteFile"),
		}),
		weight: 1,
	},
	{
		arbitrary: fc.record({ idx: fc.nat(), kind: fc.constant<"branch">("branch") }),
		weight: 1,
	},
	{
		arbitrary: fc.record({ idx: fc.nat(), kind: fc.constant<"checkout">("checkout") }),
		weight: 1,
	},
	{
		arbitrary: fc.record({ idx: fc.nat(), kind: fc.constant<"merge">("merge") }),
		weight: 1,
	},
	// Weight 2, not 1, BECAUSE of `divergeAndMerge` below: that macro adds two
	// branches' worth of refs to a candidate, and consumers that keep a ref SUBSET
	// (gc.spec's PBT-1/PBT-3 keep index 0 of the name-sorted ref list plus a mask)
	// see `refs/tags/*` pushed down that list by every extra `refs/heads/*`. At
	// weight 1 the annotated-tag-tip corner those properties floor dropped from 5
	// candidates in 30 to 2; at weight 2 it is 7. Measured, not guessed.
	{
		arbitrary: fc.record({
			annotated: fc.boolean(),
			idx: fc.nat(),
			kind: fc.constant<"tag">("tag"),
		}),
		weight: 2,
	},
	// Weighted like the other structural commands. A `merge` drawn on its own
	// almost never lands a merge COMMIT (it needs six specific commands in the
	// right order first — measured: zero merge commits over the whole pinned
	// corpus before this macro existed), so the multi-parent dimension the six
	// consuming differentials advertise comes from here.
	{
		arbitrary: fc.record({
			kind: fc.constant<"divergeAndMerge">("divergeAndMerge"),
			nameIdx: fc.nat(),
			pathIdx: fc.nat(),
		}),
		weight: 1,
	},
)

/** A fast-check arbitrary of git-command lists; each list builds one candidate repo. */
export function repoCommands(maxCommands: number): fc.Arbitrary<GenCommand[]> {
	return fc.array(commandArb, {
		maxLength: maxCommands,
		minLength: 1,
	})
}

function writeContent(dir: string, path: string, content: ContentSpec): void {
	const full = join(dir, path)
	mkdirSync(dirname(full), { recursive: true })
	let data: Buffer
	switch (content.kind) {
		case "empty":
			data = Buffer.alloc(0)
			break
		case "text":
			data = Buffer.from(content.value, "utf8")
			break
		case "binary":
			data = Buffer.from(content.bytes)
			break
		default:
			assertNever(content)
	}
	writeFileSync(full, data)
}

/** Wraparound index into a non-empty array (narrows the `noUncheckedIndexedAccess` undefined). */
function pick<T>(arr: readonly T[], idx: number): T {
	const value = arr[idx % arr.length]
	if (value === undefined) throw new Error("pick: empty array")
	return value
}

/** The offset into NAMES of the first name at-or-after `from` that is not yet a
 * branch — the sibling `divergeAndMerge` can create at the current tip, so the
 * merge base is that tip. */
type FreeName = { kind: "available"; index: number } | { kind: "exhausted" }

function freeName(model: RepoModel, from: number): FreeName {
	for (let i = 0; i < NAMES.length; i++) {
		if (!model.existingBranches.has(pick(NAMES, from + i))) {
			return { index: from + i, kind: "available" }
		}
	}
	return { kind: "exhausted" }
}

/** Apply one command, but only run `git` when the operation is currently valid. */
async function step(model: RepoModel, cmd: GenCommand): Promise<void> {
	switch (cmd.kind) {
		case "writeFile": {
			writeContent(model.dir, cmd.path, cmd.content)
			model.dirty = true
			return
		}
		case "deleteFile": {
			const full = join(model.dir, pick(PATHS, cmd.idx))
			if (existsSync(full)) {
				rmSync(full)
				model.dirty = true
			}
			return
		}
		case "commit": {
			if (!model.dirty) return
			await spawnGit(["add", "-A"], { cwd: model.dir })
			try {
				await spawnGit(["commit", "-q", "-m", `commit ${model.commitSeq}`], {
					cwd: model.dir,
				})
				model.commitSeq++
				model.commitCount++
				model.existingBranches.add(model.currentBranch)
			} catch (e) {
				// The only expected failure is a net no-op ("nothing to commit"); the
				// tree is then already == HEAD. Anything else is a real error — rethrow.
				if (
					!(e instanceof GitCommandError) ||
					e.code <= 0 ||
					!/nothing to commit/.test(e.stdout + e.stderr)
				) {
					throw e
				}
			}
			model.dirty = false
			return
		}
		case "branch": {
			const name = pick(NAMES, cmd.idx)
			if (model.commitCount === 0 || model.existingBranches.has(name)) return
			// `HEAD` is an EXPLICIT start-point, not a redundant default. Branches and
			// tags draw from the same NAMES pool, so `x` can be both — and a bare
			// `git branch <new>` then resolves HEAD to its branch NAME and re-resolves
			// that as an object, which canonical git rejects: with HEAD on branch `dev`
			// and a tag `dev` present it exits 128 `ambiguous object name: 'dev'`
			// (verified on git 2.55; `git branch <new> HEAD` exits 0 in the same state).
			// That would break this module's contract that a generated list never makes
			// git exit non-zero — silently, since it needs branch/tag collision AND a
			// checkout onto the collided branch AND a later branch.
			await spawnGit(["branch", name, "HEAD"], { cwd: model.dir })
			model.existingBranches.add(name)
			return
		}
		case "checkout": {
			if (model.dirty || model.existingBranches.size === 0) return
			const branches = [...model.existingBranches]
			const target = pick(branches, cmd.idx)
			await spawnGit(["checkout", "-q", target], { cwd: model.dir })
			model.currentBranch = target
			return
		}
		case "merge": {
			if (model.dirty || model.commitCount === 0) return
			const others = [...model.existingBranches].filter((b) => b !== model.currentBranch)
			if (others.length === 0) return
			const target = pick(others, cmd.idx)
			const before = (
				await spawnGit(["rev-parse", "HEAD"], { cwd: model.dir })
			).stdout.trim()
			const targetTip = (
				await spawnGit(["rev-parse", target], { cwd: model.dir })
			).stdout.trim()
			try {
				await spawnGit(["merge", "--no-edit", "-m", `merge ${model.commitSeq}`, target], {
					cwd: model.dir,
				})
				const after = (
					await spawnGit(["rev-parse", "HEAD"], { cwd: model.dir })
				).stdout.trim()
				if (after !== before) model.commitSeq++
				// A fast-forward moves HEAD to the target's already-counted commit; a
				// distinct result is a newly-created merge commit and must count as such.
				if (after !== before && after !== targetTip) model.commitCount++
			} catch (e) {
				// A content conflict is expected with random divergent branches: abort
				// cleanly and skip. Anything else is real — rethrow after aborting.
				// Every nonzero git exit is a GitCommandError, so the conflict must be
				// PROVEN (unmerged index entries), not inferred from the error type —
				// else broken config, corruption, and command regressions all skip.
				if (!(e instanceof GitCommandError) || e.code <= 0) throw e
				const unmerged = await spawnGit(["ls-files", "-u"], { cwd: model.dir })
				if (unmerged.stdout.trim() === "") throw e
				await spawnGit(["merge", "--abort"], { cwd: model.dir })
			}
			return
		}
		case "tag": {
			const name = pick(NAMES, cmd.idx)
			if (model.commitCount === 0 || model.tags.has(name)) return
			const args = cmd.annotated
				? ["tag", "-a", "-m", `tag ${name}`, name]
				: ["tag", name]
			await spawnGit(args, { cwd: model.dir })
			model.tags.add(name)
			return
		}
		// The MACRO. A merge COMMIT needs six primitive commands in one exact order
		// (commit → branch → checkout → commit → checkout → commit → merge) plus two
		// branches that genuinely diverged; a uniform draw over ≤25 commands
		// essentially never produces that, and measurably never did — the pinned
		// corpus realized ZERO merge commits, so every differential built on this
		// generator ran only single-parent history. This expands into those same
		// primitives, resolving each index against the LIVE model (the arbitrary
		// cannot know the model's branch ORDER at draw time, which is why the
		// sequence is not simply generated as seven separate commands). The two
		// sides write DIFFERENT paths with `commitSeq`-keyed content, so they always
		// diverge and can never conflict — the merge is a real multi-parent commit,
		// not a fast-forward and not an abort.
		case "divergeAndMerge": {
			const sidePath = pick(PATHS, cmd.pathIdx)
			const ourPath = pick(PATHS, cmd.pathIdx + 1)
			// Something to branch FROM. `commit` is a no-op on a clean tree, so this
			// only lands one when the macro starts on an empty or dirty repo.
			if (model.commitCount === 0) {
				await step(model, {
					content: { kind: "text", value: `base ${model.commitSeq}\n` },
					kind: "writeFile",
					path: sidePath,
				})
			}
			await step(model, { kind: "commit" })
			const origin = model.currentBranch
			const free = freeName(model, cmd.nameIdx)
			let sibling: string
			if (free.kind === "exhausted") {
				// All five names are branches, so one of them is not `origin`. Merging an
				// EXISTING branch can hit a real content conflict, which `merge` aborts.
				const taken = [...model.existingBranches].find((b) => b !== origin)
				if (taken === undefined) throw new Error("divergeAndMerge: no sibling exists")
				sibling = taken
			} else {
				sibling = pick(NAMES, free.index)
				await step(model, { idx: free.index, kind: "branch" })
			}
			const branchIdx = (name: string) => [...model.existingBranches].indexOf(name)
			await step(model, { idx: branchIdx(sibling), kind: "checkout" })
			await step(model, {
				content: { kind: "text", value: `side ${model.commitSeq}\n` },
				kind: "writeFile",
				path: sidePath,
			})
			await step(model, { kind: "commit" })
			await step(model, { idx: branchIdx(origin), kind: "checkout" })
			await step(model, {
				content: { kind: "text", value: `ours ${model.commitSeq}\n` },
				kind: "writeFile",
				path: ourPath,
			})
			await step(model, { kind: "commit" })
			const others = [...model.existingBranches].filter((b) => b !== model.currentBranch)
			await step(model, { idx: others.indexOf(sibling), kind: "merge" })
			return
		}
	}
	return assertNever(cmd)
}

/**
 * Replay more commands onto an ALREADY-BUILT repo, advancing its model in place.
 * This is the composable seam the incremental differentials need: build a base
 * repo, clone/push it, then `extend` it to diverge the source (incremental fetch)
 * or the client (incremental push) before the second exchange.
 */
export async function extendRepoFromCommands(
	model: RepoModel,
	commands: GenCommand[],
): Promise<void> {
	for (const cmd of commands) await step(model, cmd)
}

/**
 * Replay a generated command list into a fresh git repo on disk. Returns the repo
 * directory and the final model. The CALLER owns cleanup of `dir` (and seeding it
 * into Postgres for the differential).
 */
export async function buildRepoFromCommands(
	commands: GenCommand[],
): Promise<{ dir: string; model: RepoModel }> {
	const dir = mkdtempSync(join(tmpdir(), "pggit-gen-"))
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	const model: RepoModel = {
		commitCount: 0,
		commitSeq: 1,
		currentBranch: "main",
		dir,
		dirty: false,
		existingBranches: new Set(),
		tags: new Set(),
	}
	await extendRepoFromCommands(model, commands)
	return { dir, model }
}

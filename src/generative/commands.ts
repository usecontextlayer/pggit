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

export type ContentSpec =
	| { kind: "empty" }
	| { kind: "text"; value: string }
	| { kind: "binary"; bytes: number[] }

export type GenCommand =
	| { kind: "writeFile"; path: string; content: ContentSpec }
	| { kind: "deleteFile"; idx: number }
	| { kind: "commit" }
	| { kind: "branch"; idx: number }
	| { kind: "checkout"; idx: number }
	| { kind: "merge"; idx: number }
	| { kind: "tag"; idx: number; annotated: boolean }

export type RepoModel = {
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
	{
		arbitrary: fc.record({
			annotated: fc.boolean(),
			idx: fc.nat(),
			kind: fc.constant<"tag">("tag"),
		}),
		weight: 1,
	},
)

/** A fast-check arbitrary of git-command lists; each list builds one candidate repo. */
export function repoCommands(
	opts: { minCommands?: number; maxCommands?: number } = {},
): fc.Arbitrary<GenCommand[]> {
	return fc.array(commandArb, {
		maxLength: opts.maxCommands ?? 30,
		minLength: opts.minCommands ?? 1,
	})
}

function writeContent(dir: string, path: string, content: ContentSpec): void {
	const full = join(dir, path)
	mkdirSync(dirname(full), { recursive: true })
	const data =
		content.kind === "empty"
			? Buffer.alloc(0)
			: content.kind === "text"
				? Buffer.from(content.value, "utf8")
				: Buffer.from(content.bytes)
	writeFileSync(full, data)
}

/** Wraparound index into a non-empty array (narrows the `noUncheckedIndexedAccess` undefined). */
function pick<T>(arr: readonly T[], idx: number): T {
	const value = arr[idx % arr.length]
	if (value === undefined) throw new Error("pick: empty array")
	return value
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
			await spawnGit(["branch", name], { cwd: model.dir })
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
			try {
				await spawnGit(["merge", "--no-edit", "-m", `merge ${model.commitSeq}`, target], {
					cwd: model.dir,
				})
				model.commitSeq++ // a merge that advanced HEAD consumes a sequence number
			} catch (e) {
				// A content conflict is expected with random divergent branches: abort
				// cleanly and skip. Anything else is real — rethrow after aborting.
				await spawnGit(["merge", "--abort"], { cwd: model.dir }).catch(() => {})
				if (!(e instanceof GitCommandError)) throw e
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
	}
}

/**
 * Replay a generated command list into a real git repo on disk. Returns the repo
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
	for (const cmd of commands) await step(model, cmd)
	return { dir, model }
}

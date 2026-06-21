import { rmSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { buildRepoFromCommands, repoCommands } from "@/generative/commands"
import { spawnGit } from "@/testing/spawn-git"

// The generator is the reusable CORE of the §8.4 differential (spec §6). It must
// produce only SENSIBLE git command sequences — replaying any generated list
// must yield a valid (fsck-clean) repo and never run an invalid command (which
// would make `git` exit non-zero and `spawnGit` throw). So this is green infra,
// a normal `*.test.ts` on the gate — not a red-by-design `*.spec.test.ts`.
describe("repoCommands generator + buildRepoFromCommands replay", () => {
	it("replays ANY generated command list into an fsck-clean repo whose model matches git", async () => {
		await fc.assert(
			fc.asyncProperty(repoCommands({ maxCommands: 25 }), async (commands) => {
				const { dir, model } = await buildRepoFromCommands(commands)
				try {
					// 1. The replay never corrupts the repo (and never threw mid-replay).
					await spawnGit(["fsck", "--full"], { cwd: dir })

					// 2. The model's branch set matches git's actual local branches.
					// Use `lstrip=2` (mechanically strips `refs/heads/`), NOT `:short` —
					// `:short` disambiguates a branch to `heads/x` when a same-named TAG
					// exists (the generator can legitimately create both `x` branch + `x` tag).
					const actual = (
						await spawnGit(
							["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"],
							{ cwd: dir },
						)
					).stdout
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean)
						.sort()
					expect(actual).toEqual([...model.existingBranches].sort())

					// 3. HEAD resolves iff the model recorded at least one commit.
					const headResolves = await spawnGit(["rev-parse", "HEAD"], { cwd: dir }).then(
						() => true,
						() => false,
					)
					expect(headResolves).toBe(model.commitCount > 0)

					// 4. The model's tags match git's tags.
					const tags = (await spawnGit(["tag", "--list"], { cwd: dir })).stdout
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean)
						.sort()
					expect(tags).toEqual([...model.tags].sort())
				} finally {
					rmSync(dir, { force: true, recursive: true })
				}
			}),
			// Pinned seed → deterministic gate (spec §7.4: the gate runs a fixed seed).
			// Broad seed exploration of the generator happens during development.
			{ numRuns: 30, seed: 424_242 },
		)
	}, 180_000)

	it("can generate a repo with commits, a branch, and a tag (coverage smoke)", async () => {
		// A hand-picked sequence proving the vocabulary actually produces graph shape.
		const { dir, model } = await buildRepoFromCommands([
			{ content: { kind: "text", value: "alpha\n" }, kind: "writeFile", path: "a.txt" },
			{ kind: "commit" },
			{ idx: 0, kind: "branch" },
			{ idx: 0, kind: "checkout" },
			{ content: { kind: "text", value: "beta\n" }, kind: "writeFile", path: "b.txt" },
			{ kind: "commit" },
			{ annotated: true, idx: 1, kind: "tag" },
		])
		try {
			expect(model.commitCount).toBeGreaterThanOrEqual(2)
			expect(model.existingBranches.size).toBeGreaterThanOrEqual(2)
			expect(model.tags.size).toBe(1)
			await spawnGit(["fsck", "--full"], { cwd: dir })
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)
})

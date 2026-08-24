import { rmSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { buildRepoFromCommands, repoCommands } from "@/testing/repo-commands"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

// The generator is the reusable CORE of the §8.4 differentials (spec §6). It must
// produce only SENSIBLE git command sequences — replaying any generated list
// must yield a valid (fsck-clean) repo and never run an invalid command (which
// would make `git` exit non-zero and `spawnGit` throw). This guards that core
// directly; the generative differentials consume it. All run on one gate.
//
// It must ALSO produce a corpus with real graph shape. Every invalid-op guard in
// `step` is a silent `return`, so a regression that makes a command kind unreachable
// reduces every candidate — in this file and in all six consuming differentials — to
// a linear single-branch repo, and nothing goes red: agreement between the model and
// git holds perfectly when both say "one branch, no tags, no merges". The corpus
// floors below are the one place that failure mode is observable.

/** The realized shape of the sampled corpus, folded in per candidate from the
 * real-git oracle plus the model. Floored after `fc.assert` — the seed is pinned, so
 * the counts are deterministic and a floor is a gate, not a flake. */
type CorpusShape = {
	candidates: number
	withMerge: number
	withTagObject: number
	withSecondBranch: number
	withTag: number
}

describe("repoCommands generator + buildRepoFromCommands replay", () => {
	it("replays ANY generated command list into an fsck-clean repo whose model matches git", async () => {
		const shape: CorpusShape = {
			candidates: 0,
			withMerge: 0,
			withSecondBranch: 0,
			withTag: 0,
			withTagObject: 0,
		}
		await fc.assert(
			fc.asyncProperty(repoCommands(25), async (commands) => {
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
					const head = await attemptGit(["rev-parse", "HEAD"], dir)
					expect(head.ok).toBe(model.commitCount > 0)
					if (!head.ok) expect(head.stderr).toMatch(/ambiguous argument 'HEAD'/)

					// 4. The model's tags match git's tags.
					const tags = (await spawnGit(["tag", "--list"], { cwd: dir })).stdout
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean)
						.sort()
					expect(tags).toEqual([...model.tags].sort())

					// 5. Fold this candidate's realized shape in (git oracle + model) for the
					// corpus floors below. `--merges` lists merge commits over ALL refs; a
					// `tag`-typed ref is an annotated tag OBJECT (a lightweight tag is a
					// commit-typed ref, counted by `withTag` from the model instead).
					const merges = (
						await spawnGit(["rev-list", "--all", "--merges"], { cwd: dir })
					).stdout.trim()
					const refTypes = (
						await spawnGit(["for-each-ref", "--format=%(objecttype)"], { cwd: dir })
					).stdout
					shape.candidates++
					if (merges !== "") shape.withMerge++
					if (refTypes.split("\n").some((t) => t.trim() === "tag")) shape.withTagObject++
					if (model.existingBranches.size >= 2) shape.withSecondBranch++
					if (model.tags.size > 0) shape.withTag++
				} finally {
					rmSync(dir, { force: true, recursive: true })
				}
			}),
			// Pinned seed → deterministic gate (spec §7.4: the gate runs a fixed seed).
			// Broad seed exploration of the generator happens during development.
			{ numRuns: 30, seed: 424_242 },
		)

		// The corpus floors: the counts realized by the pinned seed. Each one falling
		// means the corresponding command kind stopped landing and every consuming
		// differential quietly lost that dimension. Raising a floor is fine (a richer
		// corpus); dropping one means that dimension disappeared.
		//
		// MERGE is floored on the RANDOM corpus, which is the only floor that protects
		// the six consumers: the hand-picked case below proves the vocabulary can reach
		// a merge, but the consumers never replay it.
		console.log(
			`[repoCommands corpus] candidates=${shape.candidates} merge=${shape.withMerge} ` +
				`tag-object=${shape.withTagObject} second-branch=${shape.withSecondBranch} ` +
				`tag=${shape.withTag}`,
		)
		expect(shape.candidates, "the property sampled nothing").toBe(30)
		expect(
			shape.withMerge,
			"no candidate produced a multi-parent commit — every consuming differential is running on linear history",
		).toBeGreaterThanOrEqual(7)
		expect(
			shape.withTagObject,
			"no candidate produced an annotated-tag object",
		).toBeGreaterThanOrEqual(6)
		expect(
			shape.withSecondBranch,
			"no candidate produced a second branch",
		).toBeGreaterThanOrEqual(9)
		expect(shape.withTag, "no candidate produced a tag").toBeGreaterThanOrEqual(7)
	}, 180_000)

	it("can generate a repo with commits, a branch, a MERGE, and a tag (coverage smoke)", async () => {
		// A hand-picked sequence proving the PRIMITIVE vocabulary produces graph shape
		// on its own. The corpus floor above is satisfied by `divergeAndMerge` alone,
		// so this is the only thing that reds if the primitive `merge` command starts
		// skipping unconditionally while the macro still lands. The two branches must
		// DIVERGE (each gets its own commit) or git fast-forwards and records no merge
		// commit at all.
		const { dir, model } = await buildRepoFromCommands([
			{ content: { kind: "text", value: "alpha\n" }, kind: "writeFile", path: "a.txt" },
			{ kind: "commit" },
			{ idx: 0, kind: "branch" }, // "feature" at the first commit
			{ idx: 1, kind: "checkout" }, // onto "feature"
			{ content: { kind: "text", value: "beta\n" }, kind: "writeFile", path: "b.txt" },
			{ kind: "commit" },
			{ idx: 0, kind: "checkout" }, // back onto "main"
			{ content: { kind: "text", value: "gamma\n" }, kind: "writeFile", path: "g.txt" },
			{ kind: "commit" }, // main now diverges from feature
			{ idx: 0, kind: "merge" }, // merge "feature" into "main"
			{ annotated: true, idx: 1, kind: "tag" },
		])
		try {
			expect(model.commitCount).toBe(4)
			expect(model.existingBranches.size).toBeGreaterThanOrEqual(2)
			expect(model.tags.size).toBe(1)
			const merges = (
				await spawnGit(["rev-list", "--all", "--merges"], { cwd: dir })
			).stdout.trim()
			expect(merges, "the merge command produced no multi-parent commit").not.toBe("")
			await spawnGit(["fsck", "--full"], { cwd: dir })
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("branches off a HEAD whose branch name is ALSO a tag (ambiguous-refname regression)", async () => {
		// Branches and tags share the NAMES pool, so `x` can be both. With HEAD on
		// branch `dev` and a tag `dev` present, a bare `git branch <new>` exits 128
		// (`ambiguous object name: 'dev'`) — which breaks the generator's contract that
		// a replay never makes git exit non-zero, and did: the sequence below is the
		// shape pinned by generative/gc.test.ts. `buildRepoFromCommands` must propagate
		// any replay failure.
		const { dir, model } = await buildRepoFromCommands([
			{ content: { kind: "text", value: "alpha\n" }, kind: "writeFile", path: "a.txt" },
			{ kind: "commit" },
			{ idx: 2, kind: "branch" }, // "dev"
			{ annotated: false, idx: 2, kind: "tag" }, // a TAG also called "dev"
			{ idx: 1, kind: "checkout" }, // HEAD onto branch "dev"
			{ idx: 0, kind: "branch" }, // "feature" — the ambiguous branch creation
		])
		try {
			expect([...model.existingBranches].sort()).toEqual(["dev", "feature", "main"])
			expect([...model.tags]).toEqual(["dev"])
			const refs = (
				await spawnGit(["for-each-ref", "--format=%(refname)"], { cwd: dir })
			).stdout
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean)
				.sort()
			expect(refs).toEqual([
				"refs/heads/dev",
				"refs/heads/feature",
				"refs/heads/main",
				"refs/tags/dev",
			])
			await spawnGit(["fsck", "--full"], { cwd: dir })
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)
})

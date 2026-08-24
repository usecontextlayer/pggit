/**
 * §8.4 generative kernel differential — REFNAME POLICY against canonical git.
 *
 * `refNameProblem` is the pure predicate receive-pack applies to every ref name a
 * client sends, and it has a perfect spawnable oracle: `git check-ref-format`. This
 * property drives both over adversarial names built by joining hostile fragments,
 * and requires exact agreement on:
 *
 *   refNameProblem(name) === null  ⟺  `git check-ref-format <name>` exits 0
 *                                     AND the name is under `refs/`
 *                                     AND it has at least three `/`-components
 *
 * The two extra conjuncts are the no-ALLOW_ONELEVEL rule receive-pack layers on top
 * of `check_refname_format` (a bare `refs/heads` would D/F-poison the whole
 * `refs/heads/*` namespace), stated ONCE here instead of enumerated per case. Any
 * disagreement is a real divergence from canonical git.
 *
 * Provenance: `refNameProblem` drifted from git once already — it required a second
 * level below `refs/` only after a review round found receive-pack accepting one-level
 * names, a corner no hand-picked list contained. The hand-picked vectors live on in
 * `src/protocol/refname-policy.test.ts` as named regressions; this is the
 * generative coverage they cannot give.
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * HERMETIC: no Postgres, no server — one `git check-ref-format` spawn per candidate.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { refNameProblem } from "@/protocol/receive-pack"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

/**
 * Adversarial name fragments, joined with `/` to build candidates. Each one targets a
 * specific `check_refname_format` rule (empty/dot-leading/`.lock`-trailing components,
 * `..`, `@{`, the forbidden punctuation set, control bytes, DEL) or a name that must
 * be ACCEPTED (ordinary components, dots inside a component, high-plane unicode) so
 * the corpus exercises both verdicts.
 *
 * NOT in the pool, deliberately:
 *   - NUL — argv cannot carry it (`spawn` rejects the argument outright), so git can
 *     never be asked. `refNameProblem`'s `\u0000` rule is pinned by the hand-picked
 *     vectors instead.
 *   - anything starting with `-` — `check-ref-format` has no `--` separator and
 *     argv-parses such a name as an option (exit 129: git declines to JUDGE, which
 *     is a broken oracle rather than a verdict).
 */
const FRAGMENTS = [
	"",
	".",
	"..",
	"...",
	".hidden",
	"a.",
	"a..b",
	"a.b",
	".lock",
	"x.lock",
	"lock.lock",
	"x.locked",
	"@",
	"@{",
	"a@{b",
	"a@b",
	" ",
	"a b",
	"a~b",
	"a^b",
	"a:b",
	"a?b",
	"a*b",
	"a[b",
	"a\\b",
	"a\u0001b",
	"a\nb",
	"a\u007fb",
	"日本",
	"ünï",
	"HEAD",
	"refs",
	"heads",
	"tags",
	"main",
	"feat",
	"v1.2.3",
	"one-two.three",
] as const

/** A candidate ref name: an optional real prefix plus 1-4 joined fragments. The
 * empty prefix is what reaches the not-under-`refs/` and one-level rules. */
const refNameArb: fc.Arbitrary<string> = fc
	.tuple(
		fc.constantFrom("", "refs/", "refs/heads/", "refs/tags/", "refs/remotes/origin/"),
		fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 4, minLength: 1 }),
	)
	.map(([prefix, parts]) => prefix + parts.join("/"))

/** THE ORACLE: canonical `git check-ref-format`. Exit 0 = well-formed, exit 1 = not.
 * Any other exit means git failed to judge rather than judging — fail loud instead of
 * laundering a broken oracle into a verdict. */
async function gitAcceptsRefName(name: string): Promise<boolean> {
	try {
		await spawnGit(["check-ref-format", name])
		return true
	} catch (e) {
		if (e instanceof GitCommandError && e.code === 1) return false
		throw e
	}
}

describe("§8.4 generative — refname policy vs `git check-ref-format`", () => {
	it("accepts exactly the names canonical git accepts under refs/ with two levels", async () => {
		let accepted = 0
		let rejected = 0
		await fc.assert(
			fc.asyncProperty(refNameArb, async (name) => {
				const canonical =
					(await gitAcceptsRefName(name)) &&
					name.startsWith("refs/") &&
					name.split("/").length >= 3
				if (canonical) accepted++
				else rejected++
				expect(refNameProblem(name) === null, JSON.stringify(name)).toBe(canonical)
			}),
			{ numRuns: 300, seed: 424_242 },
		)
		// Both verdicts must occur, or the agreement above is vacuous: a corpus of
		// only-bad names agrees with any predicate that rejects everything.
		console.log(`[refname corpus] accepted=${accepted} rejected=${rejected}`)
		expect(accepted, "no generated name was well-formed").toBeGreaterThan(0)
		expect(rejected, "no generated name was malformed").toBeGreaterThan(0)
	}, 180_000)
})

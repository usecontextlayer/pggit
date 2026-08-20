/**
 * §8.4 generative kernel differential — the NEGOTIATION TRANSCRIPT itself.
 *
 * The other fetch differentials assert the object SET that crossed the wire; this
 * one asserts the CONVERSATION. For every generated commit DAG and every generated
 * (want, haves) pair, the SAME v2 fetch bytes go to pggit's `handleUploadPack` and
 * to real `git upload-pack --stateless-rpc` over the identical repo, and the two
 * `acknowledgments` sections must be byte-identical — which pins ACK content, ACK
 * ORDER, `ready` timing and the NAK rule as canonical git's `ok_to_give_up`,
 * for every graph shape the generator reaches. Both sides must also agree on
 * whether the response carries a pack at all (git ships the pack in the same
 * response as `ready`; a not-ready round is acknowledgments + flush and nothing
 * else), so an over-eager readying is visible as a pack that git did not send.
 *
 * This is the surface that shipped wrong twice — a bare-common ancestry check,
 * then a `sharesAncestry` replacement that over-readied deep forks. Both bugs
 * transferred the CORRECT delta one round late or one round early, so every
 * set-comparing property in this directory stayed green through both; only the
 * transcript sees them.
 *
 * Fixture decisions (each keeps the differential honest rather than convenient):
 *   - Every commit is given a `keep/*` branch before the exchange, so every want
 *     is an ADVERTISED ref. Canonical git answers a want for a non-tip object with
 *     `ERR ... not our ref` unless `allowAnySHA1InWant` is set, while pggit serves
 *     any want it holds (the promisor rule) — a DELIBERATE policy difference, not
 *     a negotiation one, and out of this property's scope. Same choice, same
 *     reason, as the hand-built served-set oracle.
 *   - Every candidate gets an extra ORPHAN root (`refs/heads/island`), because
 *     `repoCommands` only ever grows one root: without it the "shares nothing with
 *     the want" have — the one shape that must NOT ready — is unreachable, and the
 *     corpus would exercise a single branch of `ok_to_give_up`. The floors below
 *     enforce that both branches are actually reached.
 *   - Wants are always commits: a tag-object want takes `readyToGiveUp`'s
 *     non-commit skip, which is its own surface with its own tests.
 *   - Have lists are sent RAW — duplicates and suppressible orderings included.
 *     Measured on git 2.55: upload-pack marks each have it holds — and that
 *     have's DIRECT PARENTS — as known, and ACKs a have only if it was not
 *     already marked, so `have c4, have c3` over `c3←c4` ACKs c4 alone while
 *     `have c3, have c4` ACKs both. pggit implements the same `got_oid` rule in
 *     `processHaves`, and the transcript equality below is what pins it.
 *   - One fixed zero-have probe runs per candidate: canonical upload-pack's v2
 *     state machine goes straight from "wants, no haves" to the packfile and
 *     sends NO acknowledgments section, with or without `done` (measured on git
 *     2.55); pggit implements the same short-circuit, asserted by pack-count
 *     equality (the ack comparison is skipped there — a pack response has no
 *     delim, so the section helper would eat compression-dependent pack bytes).
 *   - One generated have kind is an oid the repo does NOT hold. It is what keeps
 *     the NAK branch of the acknowledgments contract in the corpus once the
 *     zero-have round is excluded, and both engines must skip it identically.
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned
 * seed). A failure here is a real negotiation divergence from canonical git.
 */
import { rmSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, inject, it } from "vitest"
import { assertNever } from "@/assert-never"
import { buildRepoFromCommands, repoCommands } from "@/generative/commands"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { requireGitOid, seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { packObjectCount } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"
import { ackSection, spawnUploadPack } from "@/testing/upload-pack-oracle"
import { fetchRequest } from "@/testing/wire-fetch"

const REPO = "negotiation"

/** Where a generated `have` is drawn from, relative to the candidate's want. */
type HaveKind = "ancestor" | "sibling" | "unrelated" | "any" | "absent"

type PairSpec = {
	haves: { idx: number; kind: HaveKind }[]
	/** Draw the want from a branch TIP (the common client shape) vs any commit. */
	wantFromTip: boolean
	wantIdx: number
}

const haveKindArb: fc.Arbitrary<HaveKind> = fc.oneof(
	// Weighted toward the two shapes that decide `ok_to_give_up`: an ancestor of
	// the want (readies) and a sibling off a shared base (readies via the parent
	// step — the regression that shipped wrong twice).
	{ arbitrary: fc.constant<HaveKind>("ancestor"), weight: 3 },
	{ arbitrary: fc.constant<HaveKind>("sibling"), weight: 3 },
	{ arbitrary: fc.constant<HaveKind>("unrelated"), weight: 2 },
	{ arbitrary: fc.constant<HaveKind>("any"), weight: 2 },
	{ arbitrary: fc.constant<HaveKind>("absent"), weight: 1 },
)

const pairArb: fc.Arbitrary<PairSpec> = fc.record({
	haves: fc.array(fc.record({ idx: fc.nat(), kind: haveKindArb }), {
		maxLength: 3,
		minLength: 1,
	}),
	wantFromTip: fc.boolean(),
	wantIdx: fc.nat(),
})

/** A syntactically valid oid no repo in this suite holds (32 leading `f`s puts it
 * out of reach of any real object, and it is NOT the all-zero null oid). */
function absentOid(idx: number): string {
	return "f".repeat(32) + (idx % 0x1000_0000).toString(16).padStart(8, "0")
}

/** Wraparound index into a non-empty list (throws loudly on an empty pool). */
function pick<T>(arr: readonly T[], idx: number): T {
	const value = arr[idx % arr.length]
	if (value === undefined) throw new Error("pick: empty array")
	return value
}

async function gitOids(args: string[], dir: string): Promise<string[]> {
	const out = await spawnGit(args, { cwd: dir })
	return out.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => requireGitOid(line.trim(), `git ${args.join(" ")}`))
}

/** The realized shape of the sampled transcripts, folded in per pair. Floored
 * after `fc.assert`: the seed is pinned, so these are a gate, not a flake. */
type TranscriptShape = {
	pairs: number
	ready: number
	notReady: number
	nak: number
	multiAck: number
	withPack: number
}

describe("§8.4 generative — negotiation transcript differential", () => {
	it("pggit's acknowledgments section IS canonical upload-pack's, for any (want, haves)", async () => {
		const baseUrl = inject("pgBaseUrl")
		const shape: TranscriptShape = {
			multiAck: 0,
			nak: 0,
			notReady: 0,
			pairs: 0,
			ready: 0,
			withPack: 0,
		}

		await fc.assert(
			fc.asyncProperty(
				repoCommands(20),
				fc.array(pairArb, { maxLength: 5, minLength: 3 }),
				async (commands, pairs) => {
					const { dir: src, model } = await buildRepoFromCommands(commands)
					try {
						fc.pre(model.commitCount > 0)

						// The branch tips as the generator left them (before `keep/*`).
						const tips = await gitOids(
							["for-each-ref", "--format=%(objectname)", "refs/heads/"],
							src,
						)
						// An unrelated root, via plumbing so the generated working tree is
						// left exactly as the command replay produced it.
						const emptyTree = (
							await spawnGit(["mktree"], { cwd: src, input: "" })
						).stdout.trim()
						const island = (
							await spawnGit(["commit-tree", emptyTree, "-m", "island root"], {
								cwd: src,
							})
						).stdout.trim()
						await spawnGit(["update-ref", "refs/heads/island", island], { cwd: src })

						const commits = await gitOids(["rev-list", "--all"], src)
						// One spawn, every commit advertised (see the header).
						await spawnGit(["update-ref", "--stdin"], {
							cwd: src,
							input: commits
								.map((c, i) => `create refs/heads/keep/c${i} ${c}\n`)
								.join(""),
						})

						const isolated = await createIsolatedSchema(baseUrl)
						try {
							const objects = createObjectStore(isolated.sql)
							const refs = createRefStore(isolated.sql)
							await seedRepoIntoStore(REPO, src, { objects, refs })
							const backend: RepoBackend = {
								buildPack: (wants, haves, omitBlobs, includeTag, thinPack) =>
									objects.buildPack(REPO, wants, haves, omitBlobs, includeTag, thinPack),
								getSymref: (name) => refs.getSymref(REPO, name),
								listRefs: () => refs.listRefs(REPO),
								processHaves: (haves) => objects.processHaves(REPO, haves),
								readyToGiveUp: (wants, common) =>
									objects.readyToGiveUp(REPO, wants, common),
							}

							const ancestorCache = new Map<string, string[]>()
							const ancestorsOf = async (commit: string): Promise<string[]> => {
								const cached = ancestorCache.get(commit)
								if (cached) return cached
								const list = await gitOids(["rev-list", commit], src)
								ancestorCache.set(commit, list)
								return list
							}

							const resolveHave = (
								h: { idx: number; kind: HaveKind },
								ancestors: string[],
								siblings: string[],
							): string => {
								switch (h.kind) {
									case "ancestor":
										return pick(ancestors, h.idx)
									case "sibling":
										return pick(siblings, h.idx)
									case "unrelated":
										return island
									case "absent":
										return absentOid(h.idx)
									case "any":
										return pick(commits, h.idx)
								}
								return assertNever(h.kind)
							}

							// One fixed NAK probe ahead of the generated rounds: a want plus a
							// single have the repo does not hold. It is the shape where BOTH
							// engines must answer `acknowledgments`+`NAK` and no pack, and
							// leaving it to the draw makes the NAK floor a coincidence of one
							// sample rather than a claim about every generated graph.
							const nakProbe: PairSpec = {
								haves: [{ idx: 0, kind: "absent" }],
								wantFromTip: true,
								wantIdx: 0,
							}
							// One fixed zero-have probe: both engines must skip negotiation
							// entirely and answer the packfile with no acknowledgments
							// section (git's FETCH_SEND_PACK — see the header).
							const packProbe: PairSpec = {
								haves: [],
								wantFromTip: true,
								wantIdx: 0,
							}
							for (const spec of [nakProbe, packProbe, ...pairs]) {
								const want = pick(spec.wantFromTip ? tips : commits, spec.wantIdx)
								const ancestors = await ancestorsOf(want)
								const ancestorSet = new Set(ancestors)
								const siblings = commits.filter((c) => !ancestorSet.has(c))
								// RAW have lists — duplicates and suppressible orderings included;
								// the ACK-suppression rule is the SERVER's (see the header), and
								// the transcript equality below is what pins it.
								const haves = spec.haves.map((h) => resolveHave(h, ancestors, siblings))

								// ONE request body, both engines. `done: false` is what makes this a
								// negotiation ROUND: the server must decide by itself whether it is
								// ready, instead of being told to pack.
								const body = fetchRequest({
									done: false,
									haves,
									objectFormat: "sha1",
									wants: [want],
								})
								const out = await handleUploadPack(body, backend)
								const oracle = await spawnUploadPack(src, body)
								const where = `want=${want} haves=[${haves.join(",")}]`
								// Pack counts must agree in BOTH directions: null===null pins
								// "no pack", equal counts pin the served set's size.
								expect(packObjectCount(out), `pack count: ${where}`).toBe(
									packObjectCount(oracle),
								)
								if (haves.length === 0) {
									// Zero-have: a pack response with no delim — the ack helper
									// would eat pack bytes, and there is no section to compare.
									expect(packObjectCount(oracle), where).not.toBeNull()
									shape.pairs++
									shape.withPack++
									continue
								}
								const transcript = ackSection(oracle)
								expect(ackSection(out), where).toBe(transcript)

								shape.pairs++
								if (transcript.includes("ready\n")) shape.ready++
								else shape.notReady++
								if (transcript.includes("NAK\n")) shape.nak++
								if (transcript.split("ACK ").length > 2) shape.multiAck++
								if (packObjectCount(oracle) !== null) shape.withPack++
							}
						} finally {
							await isolated.drop()
						}
					} finally {
						rmSync(src, { force: true, recursive: true })
					}
				},
			),
			{ numRuns: 8, seed: 424_242 },
		)

		// The corpus floors, calibrated on what the pinned seed realizes today
		// (pairs=41 ready=21 not-ready=20 nak=10 multi-ack=12 with-pack=21). A
		// transcript differential that only ever saw READY transcripts — or only
		// NAK ones — agrees with git on one branch of `ok_to_give_up` and never
		// tests the other, which is exactly how both shipped regressions stayed
		// green under the set-comparing properties. Raising a floor is fine (a
		// richer corpus); dropping one is the collapse these exist to red.
		console.log(
			`[negotiation corpus] pairs=${shape.pairs} ready=${shape.ready} ` +
				`not-ready=${shape.notReady} nak=${shape.nak} multi-ack=${shape.multiAck} ` +
				`with-pack=${shape.withPack}`,
		)
		// 8 candidates × (NAK probe + pack probe + ≥3 generated rounds) is the
		// structural floor.
		expect(shape.pairs, "the property sampled nothing").toBeGreaterThanOrEqual(40)
		expect(shape.ready, "no transcript ever readied").toBeGreaterThanOrEqual(12)
		expect(shape.notReady, "every transcript readied").toBeGreaterThanOrEqual(12)
		expect(shape.nak, "no transcript ever NAK'd").toBeGreaterThanOrEqual(8)
		expect(shape.multiAck, "no transcript carried >1 ACK").toBeGreaterThanOrEqual(6)
		expect(shape.withPack, "no transcript carried a pack").toBeGreaterThanOrEqual(12)
	})
})

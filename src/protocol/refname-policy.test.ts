/**
 * Refname policy at the receive boundary:
 * git clients VALIDATE refnames before sending, so only a hostile or non-git
 * client ever ships a funny name — which is exactly why the server must not
 * trust the wire. A funny name that reached storage would poison every later
 * advertisement and status line a real git client parses. Rules mirror git's
 * `check_refname_format` as receive-pack applies it, plus the loose-ref
 * directory/file conflict (`refs/heads/a` vs `refs/heads/a/b`) checked in two
 * phases: existing-namespace clashes, then deepest-wins among the survivors.
 *
 * The two vector lists below are NAMED REGRESSIONS — each string is a rule someone
 * had to discover. The general agreement with canonical git is pinned generatively
 * against a spawned `git check-ref-format` in `src/generative/refname.test.ts`;
 * a new rule learned the hard way still belongs here, by name.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	handleReceivePack,
	type ReceiveBackend,
	refNameProblem,
} from "@/protocol/receive-pack"
import { pktLineUnpack } from "@/testing/pkt-oracle"
import { receivePackRequest } from "@/testing/wire-receive"

const A = "a".repeat(40)
const Z = "0".repeat(40)

describe("refNameProblem — git's check_refname_format for full ref names", () => {
	it("accepts well-formed full refs", () => {
		for (const ok of [
			"refs/heads/main",
			"refs/heads/feat/one-two.three",
			"refs/tags/v1.2.3",
			"refs/heads/@at",
			"refs/remotes/origin/HEAD",
		]) {
			expect(refNameProblem(ok), ok).toBeNull()
		}
	})

	it("rejects every check-ref-format violation", () => {
		for (const bad of [
			"main", // not under refs/
			"refs/heads/", // trailing slash
			"refs/heads/a.", // trailing dot
			"refs/heads/a..b", // double dot
			"refs/heads//x", // empty component
			"refs/heads/.hidden", // component starts with dot
			"refs/heads/x.lock", // component ends with .lock
			"refs/heads/a b", // space
			"refs/heads/a~b", // tilde
			"refs/heads/a^b", // caret
			"refs/heads/a:b", // colon
			"refs/heads/a?b", // question mark
			"refs/heads/a*b", // asterisk
			"refs/heads/a[b", // bracket
			"refs/heads/a\\b", // backslash
			"refs/heads/a\nb", // control byte
			"refs/heads/a\u007fb", // DEL
			"refs/heads/a@{b", // reflog syntax
		]) {
			expect(refNameProblem(bad), JSON.stringify(bad)).not.toBeNull()
		}
	})
})

type ReceiveBehavior = {
	existing?: string[]
	isAncestor?: ReceiveBackend["isAncestor"]
	isConnected?: ReceiveBackend["isConnected"]
	objectType?: ReceiveBackend["objectType"]
}

/** A behavior-configurable, stateful ref-store fake anchored by the real-Git differentials. */
function receiveFake(behavior: ReceiveBehavior = {}) {
	const refs = new Map((behavior.existing ?? []).map((name) => [name, A]))
	const backend: ReceiveBackend = {
		applyRefUpdates: async (cmds) => {
			for (const command of cmds) {
				if (command.newOid === Z) refs.delete(command.ref)
				else refs.set(command.ref, command.newOid)
			}
			return cmds.map(() => true)
		},
		ingest: async () => {},
		isAncestor: behavior.isAncestor ?? (async () => true),
		isConnected: behavior.isConnected ?? (async () => true),
		listRefNames: async () => [...refs.keys()],
		objectType: behavior.objectType ?? (async () => "commit"),
	}
	return { backend, refs }
}

function refState(refs: ReadonlyMap<string, string>): string[] {
	return [...refs].map(([name, oid]) => `${name} ${oid}`).sort()
}

function push(...lines: string[]): Buffer {
	const [first, ...rest] = lines
	if (first === undefined) throw new Error("push requires at least one command")
	return receivePackRequest([`${first}\0report-status`, ...rest])
}

describe("handleReceivePack — funny names get per-ref ng, never a ref", () => {
	it("rejects a malformed name and applies nothing for it", async () => {
		const { backend, refs } = receiveFake()
		const report = pktLineUnpack(
			await handleReceivePack(push(`${Z} ${A} refs/heads/a..b`), backend),
		)
		expect(report).toContain("ng refs/heads/a..b funny refname")
		expect(refState(refs)).toEqual([])
	})

	it("rejects a directory/file conflict against an EXISTING ref", async () => {
		const { backend, refs } = receiveFake({ existing: ["refs/heads/a"] })
		const report = pktLineUnpack(
			await handleReceivePack(push(`${Z} ${A} refs/heads/a/b`), backend),
		)
		expect(report).toContain("ng refs/heads/a/b funny refname (directory/file conflict)")
		expect(refState(refs)).toEqual([`refs/heads/a ${A}`])
	})

	it("within one batch, the DEEPEST name wins the directory/file conflict", async () => {
		// Canonical git keeps the deepest conflicting new name and ngs every
		// shorter one, in any wire order (measured on git 2.55; the receive-pack
		// policy differential pins the agreement end-to-end).
		const { backend, refs } = receiveFake()
		const report = pktLineUnpack(
			await handleReceivePack(
				push(`${Z} ${A} refs/heads/main`, `${Z} ${A} refs/heads/main/sub`),
				backend,
			),
		)
		expect(report).toContain("ng refs/heads/main funny refname (directory/file conflict)")
		expect(report).toContain("ok refs/heads/main/sub")
		expect(refState(refs)).toEqual([`refs/heads/main/sub ${A}`])
	})
})

type CommandState = "eligible" | "disconnected" | "invalid-tip" | "non-ff" | "delete"

const commandStateArb = fc.constantFrom<CommandState>(
	"eligible",
	"disconnected",
	"invalid-tip",
	"non-ff",
	"delete",
)

const dfChainArb = fc.integer({ max: 5, min: 2 }).chain((length) =>
	fc.record({
		existingRoot: fc.boolean(),
		order: fc.shuffledSubarray(
			Array.from({ length }, (_, i) => i),
			{ maxLength: length, minLength: length },
		),
		states: fc.array(commandStateArb, { maxLength: length, minLength: length }),
	}),
)

function chainRef(depth: number): string {
	return `refs/heads/property${"/child".repeat(depth)}`
}

function commandOid(depth: number): string {
	return (depth + 1).toString(16).padStart(40, "0")
}

function expectedResult(
	ref: string,
	state: CommandState,
	clashesExisting: boolean,
	losesToDeeper: boolean,
): string {
	if (state === "disconnected") return `ng ${ref} missing necessary objects\n`
	if (state === "invalid-tip") return `ng ${ref} invalid new value provided\n`
	if (state === "delete") return `ng ${ref} deletion denied (refs only advance)\n`
	if (clashesExisting) return `ng ${ref} funny refname (directory/file conflict)\n`
	if (state === "eligible") {
		return losesToDeeper
			? `ng ${ref} funny refname (directory/file conflict)\n`
			: `ok ${ref}\n`
	}
	return `ng ${ref} non-fast-forward (refs only advance)\n`
}

describe("handleReceivePack — D/F phase ordering", () => {
	/** The real-Git DFC differentials anchor the model; this hermetic property explores the survivor combinations and wire permutations that are too expensive to enumerate through two remotes. */
	it("generatively filters every per-command verdict before deepest-wins", async () => {
		const lengths = new Map<number, number>()
		const states = new Map<CommandState, number>()
		let existingClashComposites = 0
		let existingRoots = 0
		let reordered = 0
		let staleSetComposites = 0
		const bump = <T>(counts: Map<T, number>, key: T): void => {
			counts.set(key, (counts.get(key) ?? 0) + 1)
		}

		await fc.assert(
			fc.asyncProperty(
				dfChainArb,
				async ({ existingRoot, order, states: drawnStates }) => {
					const length = drawnStates.length
					bump(lengths, length)
					for (const state of drawnStates) bump(states, state)
					if (order.some((depth, position) => depth !== position)) reordered++
					if (existingRoot) existingRoots++

					const deepestEligible = existingRoot
						? drawnStates[0] === "eligible"
							? 0
							: -1
						: drawnStates.lastIndexOf("eligible")
					if (!existingRoot && deepestEligible >= 0 && deepestEligible < length - 1) {
						staleSetComposites++
					}
					if (
						existingRoot &&
						drawnStates[0] === "eligible" &&
						drawnStates.slice(1).includes("eligible")
					) {
						existingClashComposites++
					}

					const stateOf = (oid: string): CommandState => {
						const state = drawnStates[Number.parseInt(oid, 16) - 1]
						if (state === undefined)
							throw new Error(`no generated command state for ${oid}`)
						return state
					}
					const { backend, refs } = receiveFake({
						existing: existingRoot ? [chainRef(0)] : [],
						isAncestor: async (_ancestor, descendant) => stateOf(descendant) !== "non-ff",
						isConnected: async (oid) => stateOf(oid) !== "disconnected",
						objectType: async (oid) =>
							stateOf(oid) === "invalid-tip" ? "blob" : "commit",
					})
					const commands = order.map((depth) => {
						const state = drawnStates[depth] as CommandState
						const oldOid =
							state === "non-ff" || state === "delete" || (existingRoot && depth === 0)
								? A
								: Z
						const newOid = state === "delete" ? Z : commandOid(depth)
						return `${oldOid} ${newOid} ${chainRef(depth)}`
					})
					const report = pktLineUnpack(
						await handleReceivePack(push(...commands), backend),
					)
					const expectedReport = [
						"unpack ok\n",
						...order.map((depth) =>
							expectedResult(
								chainRef(depth),
								drawnStates[depth] as CommandState,
								existingRoot && depth > 0,
								drawnStates[depth] === "eligible" && depth < deepestEligible,
							),
						),
						"0000\n",
					].join("")
					expect(report).toBe(expectedReport)
					const expectedRefs = existingRoot
						? [`${chainRef(0)} ${deepestEligible === 0 ? commandOid(0) : A}`]
						: deepestEligible < 0
							? []
							: [`${chainRef(deepestEligible)} ${commandOid(deepestEligible)}`]
					expect(refState(refs)).toEqual(expectedRefs)
				},
			),
			{ numRuns: 160, seed: 424_242 },
		)

		for (const length of [2, 3, 4, 5]) {
			expect(
				lengths.get(length) ?? 0,
				`corpus never realized length ${length}`,
			).toBeGreaterThan(0)
		}
		for (const state of [
			"eligible",
			"disconnected",
			"invalid-tip",
			"non-ff",
			"delete",
		] as const) {
			expect(states.get(state) ?? 0, `corpus never realized ${state}`).toBeGreaterThan(0)
		}
		expect(reordered, "corpus never reordered the wire commands").toBeGreaterThan(0)
		expect(
			existingRoots,
			"corpus never started from an existing shallow ref",
		).toBeGreaterThan(0)
		expect(
			existingClashComposites,
			"corpus never put an eligible update beside a deeper existing-namespace clash",
		).toBeGreaterThan(0)
		expect(
			staleSetComposites,
			"corpus never put a doomed deeper command below the deepest eligible command",
		).toBeGreaterThan(0)
	})
})

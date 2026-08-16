/**
 * Executable spec for `encodeDelta` (spec §3.4, now symmetric). PURE — no git, no
 * Postgres — so it runs at high `numRuns` on the default gate.
 *
 * Three layers, each catching what the one before it cannot:
 *
 *   1. ROUND-TRIP under fuzz. `applyDelta(base, encodeDelta(base, target)) === target`.
 *      This is the whole correctness contract, and it also subsumes the format
 *      landmines: a zero-size COPY, a mis-encoded offset byte, and a dropped
 *      continuation all reconstruct the WRONG bytes, so none of them need a
 *      structural assertion — which keeps this spec on the contract rather than
 *      inside the encoder.
 *
 *   2. SIZE. Correctness alone passes for an encoder that emits nothing but literals
 *      — which is exactly today's undeltified behaviour wearing a delta header, and
 *      the entire point of the work. So the spec pins that a delta actually FINDS the
 *      match: for one entry inserted into a tree, delta size must not grow with the
 *      tree.
 *
 *   3. ADVERSARIAL VECTORS. The specific encodings with teeth — a COPY of exactly
 *      0x10000, an offset whose low bytes are zero, a run past the 3-byte size field.
 *      Fuzzing reaches these only by luck, so they are pinned by hand.
 *
 * The oracle is `applyDelta`, and it is NOT self-referential: `applyDelta` is already
 * pinned against GIT-PRODUCED deltas in `read-pack.test.ts`, so it is an independently
 * grounded reader. Real git accepting our output is a separate layer
 * (`encode-delta-oracle.test.ts`); real repositories are a third (`perf/delta-corpus.ts`).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { applyDelta, encodeDelta } from "@/pack/delta"

const SEED = 424_242

// ── generators ──────────────────────────────────────────────────────────────

/**
 * A git tree's on-disk content: `<mode> <name>\0` followed by the child's 20 RAW
 * hash bytes, entries in git's sort order. This is both the production shape and the
 * adversarial one for a byte-oriented matcher — a hash is indistinguishable from
 * noise, so a tree's ONLY compressible structure is its similarity to the previous
 * version of itself. An encoder that cannot exploit that wins nothing here.
 */
function treeContent(entries: { name: string; hash: Uint8Array }[]): Buffer {
	const sorted = [...entries].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)
	return Buffer.concat(
		sorted.map((e) =>
			Buffer.concat([Buffer.from(`100644 ${e.name}\0`, "latin1"), Buffer.from(e.hash)]),
		),
	)
}

/** Deterministic uuid-shaped entry name — the run-directory shape that makes tree
 * objects enormous in the workload this work exists for. */
function entryName(i: number): string {
	const hex = i.toString(16).padStart(8, "0")
	return `${hex}-aaaa-bbbb-cccc-${hex}00000000`
}

const hashArb = fc.uint8Array({ maxLength: 20, minLength: 20 })

/** A tree of exactly `size` entries, hashes fuzzed. */
const treeArb = (size: number): fc.Arbitrary<Buffer> =>
	fc
		.array(hashArb, { maxLength: size, minLength: size })
		.map((hashes) => treeContent(hashes.map((hash, i) => ({ hash, name: entryName(i) }))))

/**
 * A (base, target) pair that differs by ONE entry inserted at a fuzzed sorted
 * position — the exact mutation an append-only run directory performs on every
 * commit, and the case the whole delta-pack effort turns on.
 */
const treeInsertionArb = (size: number): fc.Arbitrary<{ base: Buffer; target: Buffer }> =>
	fc
		.record({
			hashes: fc.array(hashArb, { maxLength: size, minLength: size }),
			newHash: hashArb,
			position: fc.nat({ max: size }),
		})
		.map(({ hashes, newHash, position }) => {
			const entries = hashes.map((hash, i) => ({ hash, name: entryName(i) }))
			const inserted = { hash: newHash, name: `${entryName(position)}-inserted` }
			return { base: treeContent(entries), target: treeContent([...entries, inserted]) }
		})

/** Byte-level edits, for breadth beyond the tree shape. */
type Mutation =
	| { at: number; bytes: Uint8Array; kind: "insert" }
	| { at: number; kind: "delete"; len: number }
	| { at: number; bytes: Uint8Array; kind: "overwrite" }
	| { kind: "duplicate" }

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
	fc.record({
		at: fc.nat(),
		bytes: fc.uint8Array({ maxLength: 64 }),
		kind: fc.constant<"insert">("insert"),
	}),
	fc.record({
		at: fc.nat(),
		kind: fc.constant<"delete">("delete"),
		len: fc.nat({ max: 64 }),
	}),
	fc.record({
		at: fc.nat(),
		bytes: fc.uint8Array({ maxLength: 64 }),
		kind: fc.constant<"overwrite">("overwrite"),
	}),
	fc.record({ kind: fc.constant<"duplicate">("duplicate") }),
)

function mutate(base: Buffer, mutations: Mutation[]): Buffer {
	let out = Buffer.from(base)
	for (const m of mutations) {
		const at = out.length === 0 ? 0 : m.kind === "duplicate" ? 0 : m.at % (out.length + 1)
		if (m.kind === "insert") {
			out = Buffer.concat([out.subarray(0, at), Buffer.from(m.bytes), out.subarray(at)])
		} else if (m.kind === "delete") {
			out = Buffer.concat([out.subarray(0, at), out.subarray(at + m.len)])
		} else if (m.kind === "overwrite") {
			const patch = Buffer.from(m.bytes)
			out = Buffer.concat([out.subarray(0, at), patch, out.subarray(at + patch.length)])
		} else {
			// A target containing the base TWICE — two disjoint COPY runs must both be found.
			out = Buffer.concat([out, out])
		}
	}
	return out
}

/** Assert the delta reconstructs the target exactly. The single load-bearing check. */
function expectRoundTrip(base: Buffer, target: Buffer): Buffer {
	const delta = encodeDelta(base, target)
	expect(applyDelta(base, delta).equals(target)).toBe(true)
	return delta
}

// ── 1. round-trip ───────────────────────────────────────────────────────────

describe("encodeDelta — round-trip (the correctness contract)", () => {
	it("reconstructs the target for INDEPENDENT random buffers", () => {
		// Unrelated inputs are the degenerate case: almost nothing is copyable, so this
		// exercises the literal path and the header, not the matcher.
		fc.assert(
			fc.property(
				fc.uint8Array({ maxLength: 2048 }),
				fc.uint8Array({ maxLength: 2048 }),
				(a, b) => {
					expectRoundTrip(Buffer.from(a), Buffer.from(b))
				},
			),
			{ numRuns: 300, seed: SEED },
		)
	})

	it("reconstructs the target for RELATED pairs (base + edits)", () => {
		// The realistic case: long shared runs broken by small edits, which is where a
		// matcher can be subtly wrong (off-by-one in a copy length, a lost tail).
		fc.assert(
			fc.property(
				fc.uint8Array({ maxLength: 4096, minLength: 1 }),
				fc.array(mutationArb, { maxLength: 8 }),
				(baseBytes, mutations) => {
					const base = Buffer.from(baseBytes)
					expectRoundTrip(base, mutate(base, mutations))
				},
			),
			{ numRuns: 300, seed: SEED },
		)
	})

	it("reconstructs the target for TREE content with an entry inserted", () => {
		fc.assert(
			fc.property(treeInsertionArb(64), ({ base, target }) => {
				expectRoundTrip(base, target)
			}),
			{ numRuns: 200, seed: SEED },
		)
	})

	it("is deterministic — the same inputs yield the same bytes", () => {
		// Repack must be idempotent, and a failing property must shrink to something
		// reproducible. Both need this.
		fc.assert(
			fc.property(
				fc.uint8Array({ maxLength: 1024, minLength: 1 }),
				fc.array(mutationArb, { maxLength: 4 }),
				(baseBytes, mutations) => {
					const base = Buffer.from(baseBytes)
					const target = mutate(base, mutations)
					expect(encodeDelta(base, target).equals(encodeDelta(base, target))).toBe(true)
				},
			),
			{ numRuns: 100, seed: SEED },
		)
	})
})

// ── 2. size — does the encoder actually FIND the match? ─────────────────────

describe("encodeDelta — size (an all-literal encoder is correct and useless)", () => {
	it("encodes an unchanged object in a handful of bytes, at any size", () => {
		fc.assert(
			fc.property(treeArb(256), (tree) => {
				const delta = expectRoundTrip(tree, tree)
				// Two size varints plus a small number of COPY instructions. Nothing about
				// this should scale with the object.
				expect(delta.length).toBeLessThan(64)
			}),
			{ numRuns: 50, seed: SEED },
		)
	})

	it("keeps a one-entry insertion CONSTANT-SIZED as the tree grows", () => {
		// THE property this whole effort turns on. komal's run directory reached 1,476
		// entries; every commit rewrites the whole ~93 KB tree. If the delta for one
		// added entry grows with the tree, we have changed nothing.
		for (const size of [32, 128, 512]) {
			fc.assert(
				fc.property(treeInsertionArb(size), ({ base, target }) => {
					const delta = expectRoundTrip(base, target)
					expect(target.length).toBeGreaterThan(size * 40)
					expect(delta.length).toBeLessThan(512)
				}),
				{ numRuns: 25, seed: SEED },
			)
		}
	})

	it("encodes a pure append as a copy of the whole base plus the new tail", () => {
		fc.assert(
			fc.property(
				fc.uint8Array({ maxLength: 4096, minLength: 512 }),
				fc.uint8Array({ maxLength: 128 }),
				(baseBytes, tailBytes) => {
					const base = Buffer.from(baseBytes)
					const target = Buffer.concat([base, Buffer.from(tailBytes)])
					const delta = expectRoundTrip(base, target)
					expect(delta.length).toBeLessThan(tailBytes.length + 64)
				},
			),
			{ numRuns: 100, seed: SEED },
		)
	})
})

// ── 3. adversarial vectors ──────────────────────────────────────────────────

describe("encodeDelta — adversarial encodings", () => {
	it("handles both sides empty, and each side empty in turn", () => {
		const empty = Buffer.alloc(0)
		const some = Buffer.from("some content here", "latin1")
		expectRoundTrip(empty, empty)
		expectRoundTrip(empty, some)
		expectRoundTrip(some, empty)
	})

	it("handles a single byte on either side", () => {
		expectRoundTrip(Buffer.from([0]), Buffer.from([0]))
		expectRoundTrip(Buffer.from([0]), Buffer.from([1]))
		expectRoundTrip(Buffer.from([0xff]), Buffer.alloc(0))
	})

	it("handles prefixes, suffixes and infixes of the base", () => {
		const base = Buffer.from("0123456789".repeat(500), "latin1")
		expectRoundTrip(base, base.subarray(0, 2000)) // prefix
		expectRoundTrip(base, base.subarray(3000)) // suffix
		expectRoundTrip(base, base.subarray(1000, 4000)) // infix
		expectRoundTrip(base.subarray(0, 2000), base) // target extends base
	})

	it("handles a COPY of exactly 0x10000 bytes", () => {
		// applyDelta reads a zero size field as 0x10000. An encoder that emits the
		// literal three zero bytes here produces a delta that decodes to the RIGHT
		// length by accident and the wrong one everywhere else; an encoder that emits a
		// zero-length COPY anywhere decodes as a 64 KiB copy. Both die on round-trip.
		const base = Buffer.alloc(0x10000)
		for (let i = 0; i < base.length; i++) base[i] = i & 0xff
		expectRoundTrip(base, Buffer.concat([base, Buffer.from("tail", "latin1")]))
		expectRoundTrip(base, base.subarray(0, 0x10000))
	})

	it("handles a copy offset whose low bytes are zero", () => {
		// The COPY opcode omits any offset byte that is zero and sets a present-bit
		// instead. Offset 0x10000 has BOTH low bytes zero — the classic place to drop a
		// byte or set the wrong bit.
		const filler = Buffer.alloc(0x10000, 0x41)
		const marker = Buffer.from("MARKER-".repeat(64), "latin1")
		const base = Buffer.concat([filler, marker])
		expectRoundTrip(base, Buffer.concat([marker, filler]))
	})

	it("handles a run longer than the 3-byte COPY size field", () => {
		// A single COPY size maxes out at 0xFFFFFF (16 MiB). A longer run must be split
		// into consecutive COPYs with a correctly ADVANCED offset — getting the advance
		// wrong yields a plausible-looking delta of the right length and wrong content.
		const base = Buffer.alloc(0x100_0004)
		for (let i = 0; i < base.length; i++) base[i] = (i * 31) & 0xff
		expectRoundTrip(base, base)
	})

	it("handles highly repetitive content, where many offsets match equally", () => {
		const base = Buffer.alloc(64_000, 0)
		const target = Buffer.alloc(64_000, 0)
		target.write("needle", 32_000, "latin1")
		expectRoundTrip(base, target)
		expectRoundTrip(target, base)
	})
})

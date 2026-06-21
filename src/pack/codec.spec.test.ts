/**
 * §8.4 codec round-trips (PURE — no git, no Postgres, so it runs fast at high
 * numRuns). Generatively exercises the pack codec along three axes:
 *
 *   1. writePack → readPack over arbitrary MIXED-TYPE object sets (the existing
 *      read-pack.test.ts round-trip is a fixed 5-object vector; write-pack's
 *      generative case is blob-only and goes through real git).
 *   2. applyDelta over random COPY/INSERT programs. The serve path emits NO deltas
 *      (spec §3.4 asymmetric kernel) so there is no `encodeDelta` to test against —
 *      so a test-local REFERENCE ENCODER is the producer (spec §7.2.6). It is safe:
 *      `applyDelta` is already pinned against GIT-produced deltas in
 *      read-pack.test.ts, so this adds breadth, not a self-referential oracle. The
 *      `target` is built independently by concatenation, so a wrong encoder fails.
 *   3. readPack's REF_DELTA resolution — both with the base IN the pack and as a
 *      THIN pack (base absent, supplied by the external resolver — the push-ingest
 *      seam, here a plain Map instead of Postgres).
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * A failure here is a real codec bug.
 */
import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { computeOid, type GitObjectType } from "@/object"
import { applyDelta } from "@/pack/delta"
import { encodeObjectHeader, PACK_OBJ_TYPE } from "@/pack/object-header"
import { readPack } from "@/pack/read-pack"
import { type PackInputObject, writePack } from "@/pack/write-pack"

const PACK_TYPE_CODE: Record<GitObjectType, number> = {
	blob: PACK_OBJ_TYPE.BLOB,
	commit: PACK_OBJ_TYPE.COMMIT,
	tag: PACK_OBJ_TYPE.TAG,
	tree: PACK_OBJ_TYPE.TREE,
}

const typeArb = fc.constantFrom<GitObjectType>("blob", "commit", "tag", "tree")

// ── reference delta encoder (test-only producer) ────────────────────────────

type EditOp =
	| { kind: "copy"; off: number; size: number }
	| { bytes: Uint8Array; kind: "insert" }

const editOpArb: fc.Arbitrary<EditOp> = fc.oneof(
	fc.record({ kind: fc.constant<"copy">("copy"), off: fc.nat(), size: fc.nat() }),
	// maxLength > 127 so INSERT chunking (1 op per ≤127-byte run) is exercised.
	fc.record({
		bytes: fc.uint8Array({ maxLength: 300 }),
		kind: fc.constant<"insert">("insert"),
	}),
)

/** Standard LEB128 (the delta header's source/target sizes), LSB group first. */
function leb128(n: number): number[] {
	const out: number[] = []
	let v = n
	do {
		let b = v & 0x7f
		v = Math.floor(v / 128)
		if (v > 0) b |= 0x80
		out.push(b)
	} while (v > 0)
	return out
}

/** A COPY instruction: present-bit-selected little-endian offset (≤4B) + size (≤3B). */
function copyInstr(offset: number, size: number): number[] {
	let op = 0x80
	const tail: number[] = []
	const off = [
		offset & 0xff,
		(offset >>> 8) & 0xff,
		(offset >>> 16) & 0xff,
		Math.floor(offset / 2 ** 24) & 0xff,
	]
	off.forEach((b, i) => {
		if (b !== 0) {
			op |= 1 << i
			tail.push(b)
		}
	})
	// size ≥ 1 and ≤ base length here, so at least one size byte is emitted — never
	// the all-zero form that applyDelta reads as the 0x10000 special case (that
	// branch is covered by delta.test.ts).
	const sz = [size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff]
	sz.forEach((b, i) => {
		if (b !== 0) {
			op |= 1 << (4 + i)
			tail.push(b)
		}
	})
	return [op, ...tail]
}

/** INSERT instructions: literal runs, chunked to ≤127 bytes (the opcode max). */
function insertInstrs(buf: Buffer): number[] {
	const out: number[] = []
	for (let i = 0; i < buf.length; i += 127) {
		const chunk = buf.subarray(i, Math.min(i + 127, buf.length))
		out.push(chunk.length, ...chunk)
	}
	return out
}

/** Build a git delta from edit ops AND the target it must reconstruct (the oracle). */
function buildDelta(base: Buffer, ops: EditOp[]): { delta: Buffer; target: Buffer } {
	const targetParts: Buffer[] = []
	const instr: number[] = []
	for (const op of ops) {
		if (op.kind === "copy") {
			const offset = op.off % base.length
			const size = (op.size % (base.length - offset)) + 1
			targetParts.push(base.subarray(offset, offset + size))
			instr.push(...copyInstr(offset, size))
		} else {
			const lit = Buffer.from(op.bytes)
			if (lit.length === 0) continue
			targetParts.push(lit)
			instr.push(...insertInstrs(lit))
		}
	}
	const target = Buffer.concat(targetParts)
	const delta = Buffer.from([...leb128(base.length), ...leb128(target.length), ...instr])
	return { delta, target }
}

// ── test-only pack writer (emits the deltified packs writePack never produces) ──

type PackEntry =
	| { content: Buffer; kind: "base"; type: GitObjectType }
	| { baseOid: string; delta: Buffer; kind: "ref" }

function buildPack(entries: PackEntry[]): Buffer {
	const header = Buffer.alloc(12)
	header.write("PACK", 0, "latin1")
	header.writeUInt32BE(2, 4)
	header.writeUInt32BE(entries.length, 8)
	const parts: Buffer[] = [header]
	for (const e of entries) {
		if (e.kind === "base") {
			parts.push(encodeObjectHeader(PACK_TYPE_CODE[e.type], e.content.length))
			parts.push(deflateSync(e.content))
		} else {
			parts.push(encodeObjectHeader(PACK_OBJ_TYPE.REF_DELTA, e.delta.length))
			parts.push(Buffer.from(e.baseOid, "hex"))
			parts.push(deflateSync(e.delta))
		}
	}
	const body = Buffer.concat(parts)
	const trailer = createHash("sha1").update(body).digest()
	return Buffer.concat([body, trailer])
}

// ── properties ──────────────────────────────────────────────────────────────

describe("§8.4 codec round-trips (pure)", () => {
	it("writePack → readPack round-trips arbitrary mixed-type object sets", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({ content: fc.uint8Array({ maxLength: 2048 }), type: typeArb }),
					{
						maxLength: 12,
						minLength: 1,
					},
				),
				async (specs) => {
					const objects: PackInputObject[] = specs.map((s) => ({
						content: Buffer.from(s.content),
						type: s.type,
					}))
					// writePack preserves order and does NOT dedup → 1 ParsedObject per input.
					const parsed = await readPack(writePack(objects))
					expect(parsed.map((p) => ({ content: p.content, type: p.type }))).toEqual(
						objects,
					)
					for (const p of parsed) expect(p.oid).toBe(computeOid(p.type, p.content))
				},
			),
			{ numRuns: 100, seed: 424_242 },
		)
	})

	it("applyDelta reconstructs the target for random COPY/INSERT programs", () => {
		fc.assert(
			fc.property(
				fc.uint8Array({ maxLength: 2048, minLength: 1 }),
				fc.array(editOpArb, { maxLength: 20 }),
				(baseBytes, ops) => {
					const base = Buffer.from(baseBytes)
					const { delta, target } = buildDelta(base, ops)
					expect(applyDelta(base, delta).equals(target)).toBe(true)
				},
			),
			{ numRuns: 200, seed: 424_242 },
		)
	})

	it("readPack resolves REF_DELTA bases — in-pack and as a thin pack", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.uint8Array({ maxLength: 1024, minLength: 1 }),
				fc.array(editOpArb, { maxLength: 12 }),
				typeArb,
				async (baseBytes, ops, baseType) => {
					const base = Buffer.from(baseBytes)
					const { delta, target } = buildDelta(base, ops)
					const baseOid = computeOid(baseType, base)

					// (1) base IN pack → readPack resolves it with no external resolver.
					// Pack order is preserved, so the ref-delta result is the 2nd object.
					const parsedIn = await readPack(
						buildPack([
							{ content: base, kind: "base", type: baseType },
							{ baseOid, delta, kind: "ref" },
						]),
					)
					expect(parsedIn[0]?.content.equals(base)).toBe(true)
					expect(parsedIn[1]?.content.equals(target)).toBe(true)
					expect(parsedIn[1]?.type).toBe(baseType) // a delta inherits its base's type

					// (2) base ABSENT (thin pack) → the external resolver supplies it.
					const thin = buildPack([{ baseOid, delta, kind: "ref" }])
					const resolved = await readPack(thin, async (oid) =>
						oid === baseOid ? { content: base, type: baseType } : null,
					)
					expect(resolved.length).toBe(1)
					expect(resolved[0]?.content.equals(target)).toBe(true)

					// (3) thin pack with NO resolver → hard error, never a silent miss.
					await expect(readPack(thin)).rejects.toThrow(/not found in pack or store/)
				},
			),
			{ numRuns: 60, seed: 424_242 },
		)
	})
})

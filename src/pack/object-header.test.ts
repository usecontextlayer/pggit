import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	decodeObjectHeader,
	encodeObjectHeader,
	PACK_OBJ_TYPE,
} from "@/pack/object-header"

describe("pack object header", () => {
	it("encodes a small blob header in a single byte", () => {
		// type=blob(3), size=6 → (3 << 4) | 6 = 0x36, no continuation bit
		expect(encodeObjectHeader(PACK_OBJ_TYPE.BLOB, 6)).toEqual(Buffer.from([0x36]))
	})

	it("decodes a single-byte header back to type + size", () => {
		expect(decodeObjectHeader(Buffer.from([0x36]), 0)).toEqual({
			bytesRead: 1,
			size: 6,
			type: PACK_OBJ_TYPE.BLOB,
		})
	})

	it("round-trips a multi-byte header (continuation bytes)", () => {
		// size=200, blob: first = (3<<4)|(200%16=8) = 0x38, +continuation = 0xb8;
		// rest = floor(200/16) = 12 = 0x0c
		const enc = encodeObjectHeader(PACK_OBJ_TYPE.BLOB, 200)
		expect(enc).toEqual(Buffer.from([0xb8, 0x0c]))
		expect(decodeObjectHeader(enc, 0)).toEqual({
			bytesRead: 2,
			size: 200,
			type: PACK_OBJ_TYPE.BLOB,
		})
	})

	it("round-trips arbitrary type + size, including sizes > 2^32 (fast-check)", () => {
		const types = Object.values(PACK_OBJ_TYPE)
		fc.assert(
			fc.property(
				fc.constantFrom(...types),
				fc.integer({ max: 2 ** 48, min: 0 }),
				(type, size) => {
					const enc = encodeObjectHeader(type, size)
					const dec = decodeObjectHeader(enc, 0)
					expect(dec.type).toBe(type)
					expect(dec.size).toBe(size)
					expect(dec.bytesRead).toBe(enc.length)
				},
			),
			// Pinned seed (424_242) for a deterministic gate, matching the sibling specs.
			{ seed: 424_242 },
		)
	})
})

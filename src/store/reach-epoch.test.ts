/**
 * The reachability epoch's pure position/serialization math. The trap this
 * pins by name: bit positions are POSITIONAL against the SORTED oid array —
 * walk-order arrays produce plausible-looking bitmaps that serve the wrong
 * objects. The property here is the load-bearing one: hex-string sort order
 * and 20-byte buffer sort order agree, so every layer (JS sorts, Buffer
 * compares, Postgres bytea comparisons) sees ONE ordering.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	bitmapFromPositions,
	concatSortedOids,
	oidsOfUnion,
	positionOf,
	remapPositions,
	splitOids,
	unionHas,
} from "@/store/reach-epoch"

const hexOid = fc
	.uint8Array({ maxLength: 20, minLength: 20 })
	.map((b) => Buffer.from(b).toString("hex"))

describe("reach-epoch position math", () => {
	it("hex sort == byte sort: positionOf finds every member at its sorted index", () => {
		fc.assert(
			fc.property(fc.uniqueArray(hexOid, { maxLength: 200, minLength: 1 }), (hexes) => {
				const buf = concatSortedOids(hexes)
				const sorted = [...hexes].sort()
				expect(splitOids(buf)).toEqual(sorted)
				for (const [i, h] of sorted.entries()) expect(positionOf(buf, h)).toBe(i)
			}),
			// Pinned seed (424_242) for a deterministic gate, matching the sibling specs.
			{ seed: 424_242 },
		)
	})

	it("positionOf returns -1 for a non-member", () => {
		const buf = concatSortedOids(["11".repeat(20), "33".repeat(20)])
		expect(positionOf(buf, "22".repeat(20))).toBe(-1)
		expect(positionOf(buf, "00".repeat(20))).toBe(-1)
		expect(positionOf(buf, "ff".repeat(20))).toBe(-1)
		expect(positionOf(Buffer.alloc(0), "11".repeat(20))).toBe(-1)
	})

	it("concatSortedOids deduplicates", () => {
		const buf = concatSortedOids(["aa".repeat(20), "aa".repeat(20), "0b".repeat(20)])
		expect(splitOids(buf)).toEqual(["0b".repeat(20), "aa".repeat(20)])
	})

	it("bitmap round-trip: positions in, the named oids out", () => {
		fc.assert(
			fc.property(fc.uniqueArray(hexOid, { maxLength: 100, minLength: 1 }), (hexes) => {
				const buf = concatSortedOids(hexes)
				const sorted = [...hexes].sort()
				const members = sorted.filter((_, i) => i % 2 === 0)
				const bits = bitmapFromPositions(members.map((h) => positionOf(buf, h)))
				expect(oidsOfUnion([bits], buf)).toEqual(members)
			}),
			// Pinned seed (424_242) for a deterministic gate, matching the sibling specs.
			{ seed: 424_242 },
		)
	})

	it("oidsOfUnion unions across bitmaps; unionHas probes membership", () => {
		const hexes = ["01".repeat(20), "02".repeat(20), "03".repeat(20), "04".repeat(20)]
		const buf = concatSortedOids(hexes)
		const a = bitmapFromPositions([0, 2])
		const b = bitmapFromPositions([1, 2])
		expect(oidsOfUnion([a, b], buf)).toEqual(hexes.slice(0, 3))
		expect(unionHas([a, b], 3)).toBe(false)
		expect(unionHas([a, b], 1)).toBe(true)
	})

	it("remapPositions carries members to their new-array positions, dropping the drop set", () => {
		const oldHexes = ["02".repeat(20), "05".repeat(20), "09".repeat(20)]
		const oldBuf = concatSortedOids(oldHexes)
		const newBuf = concatSortedOids([...oldHexes, "01".repeat(20), "07".repeat(20)])
		const bits = bitmapFromPositions([0, 1, 2])
		expect(remapPositions(bits, oldBuf, newBuf)).toEqual(
			oldHexes.map((h) => positionOf(newBuf, h)),
		)
		expect(remapPositions(bits, oldBuf, newBuf, new Set(["05".repeat(20)]))).toEqual([
			positionOf(newBuf, "02".repeat(20)),
			positionOf(newBuf, "09".repeat(20)),
		])
	})

	it("remapPositions preserves every retained member under arbitrary insertions", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(hexOid, { maxLength: 100, minLength: 1 }),
				fc.array(hexOid, { maxLength: 100 }),
				(oldHexes, additions) => {
					const oldBuf = concatSortedOids(oldHexes)
					const oldSorted = splitOids(oldBuf)
					const newBuf = concatSortedOids([...oldSorted, ...additions])
					const selected = oldSorted.filter((_, i) => i % 2 === 0)
					const dropped = new Set(oldSorted.filter((_, i) => i % 3 === 0))
					const bits = bitmapFromPositions(selected.map((h) => positionOf(oldBuf, h)))
					const expected = selected
						.filter((h) => !dropped.has(h))
						.map((h) => positionOf(newBuf, h))

					expect(remapPositions(bits, oldBuf, newBuf, dropped)).toEqual(expected)
				},
			),
			{ seed: 424_242 },
		)
	})

	it("remapPositions throws LOUDLY when an old member is absent from the new array", () => {
		const oldBuf = concatSortedOids(["02".repeat(20), "05".repeat(20)])
		const newBuf = concatSortedOids(["02".repeat(20)])
		const bits = bitmapFromPositions([0, 1])
		expect(() => remapPositions(bits, oldBuf, newBuf)).toThrow(
			/absent from the new array/,
		)
	})
})

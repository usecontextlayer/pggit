import { describe, expect, it } from "vitest"
import {
	type MemoryBreakdown,
	median,
	peakOf,
	peakPerField,
	percentile,
	requireSamples,
} from "./memory"

describe("peakOf", () => {
	it("returns the maximum value", () => {
		expect(peakOf([3, 1, 4, 1, 5, 9, 2, 6])).toBe(9)
	})

	it("requires evidence before reduction", () => {
		expect(() => requireSamples([])).toThrow("at least one sample")
	})

	it("does not overflow the call stack on a large series", () => {
		// A multi-second clone yields thousands of 1ms samples; Math.max(...spread)
		// would throw on these, so peakOf must fold, not spread.
		const big = Array.from({ length: 200_000 }, (_, i) => i)
		expect(peakOf(requireSamples(big))).toBe(199_999)
	})
})

describe("median", () => {
	it("averages the middle pair of an even sample", () => {
		expect(median([4, 1, 3, 2])).toBe(2.5)
	})
})

describe("percentile (nearest-rank)", () => {
	it("p100 is the max, p0 is the min — order-independent", () => {
		expect(percentile([40, 10, 30, 20], 100)).toBe(40)
		expect(percentile([40, 10, 30, 20], 0)).toBe(10)
	})

	it("p50 is the nearest-rank median", () => {
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
	})
})

describe("peakPerField", () => {
	it("takes the max of each field independently across samples", () => {
		const a: MemoryBreakdown = {
			arrayBuffers: 1,
			external: 5,
			heapTotal: 9,
			heapUsed: 2,
			rss: 100,
		}
		const b: MemoryBreakdown = {
			arrayBuffers: 7,
			external: 3,
			heapTotal: 4,
			heapUsed: 8,
			rss: 90,
		}
		expect(peakPerField([a, b])).toEqual({
			arrayBuffers: 7,
			external: 5,
			heapTotal: 9,
			heapUsed: 8,
			rss: 100,
		})
	})
})

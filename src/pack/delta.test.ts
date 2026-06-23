import { describe, expect, it } from "vitest"
import { applyDelta } from "@/pack/delta"
import { expectGitFormatError } from "@/testing/format-error"

describe("applyDelta", () => {
	it("applies copy + insert instructions (hand-built vector)", () => {
		const base = Buffer.from("hello world") // 11 bytes
		const delta = Buffer.from([
			0x0b, // source size = 11
			0x12, // target size = 18
			0x90,
			0x05, // COPY offset 0, size 5 → "hello"
			0x07,
			...Buffer.from(", brave"), // INSERT 7 literal bytes
			0x91,
			0x05,
			0x06, // COPY offset 5, size 6 → " world"
		])
		expect(applyDelta(base, delta).toString()).toBe("hello, brave world")
	})

	it("treats a COPY size of 0 as 0x10000", () => {
		const base = Buffer.alloc(0x10000, 0x41)
		// header: sourceSize=0x10000, targetSize=0x10000 (LEB128 = 80 80 04 each)
		// then COPY op 0x80 with no offset/size bytes ⇒ offset 0, size 0 → 0x10000
		const delta = Buffer.from([0x80, 0x80, 0x04, 0x80, 0x80, 0x04, 0x80])
		expect(applyDelta(base, delta).equals(base)).toBe(true)
	})

	it("throws when the base size disagrees with the delta header", () => {
		const base = Buffer.from("abc") // 3 bytes
		const delta = Buffer.from([0x05, 0x01]) // header says source size 5
		expect(expectGitFormatError(() => applyDelta(base, delta))).toBe(
			"delta-base-size-mismatch",
		)
	})

	it("throws on the reserved opcode 0x00", () => {
		const base = Buffer.from("abc") // 3 bytes
		// header: sourceSize=3, targetSize=5, then the reserved instruction byte 0x00.
		const delta = Buffer.from([0x03, 0x05, 0x00])
		expect(expectGitFormatError(() => applyDelta(base, delta))).toBe(
			"delta-reserved-opcode",
		)
	})

	it("throws when the instruction stream under-produces the declared target size", () => {
		const base = Buffer.from("abc") // 3 bytes
		// header: sourceSize=3, targetSize=10, then INSERT only 3 literal bytes (< 10).
		const delta = Buffer.from([0x03, 0x0a, 0x03, ...Buffer.from("xyz")])
		expect(expectGitFormatError(() => applyDelta(base, delta))).toBe(
			"delta-target-size-mismatch",
		)
	})
})

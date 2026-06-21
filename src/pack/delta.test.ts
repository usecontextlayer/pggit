import { describe, expect, it } from "vitest"
import { applyDelta } from "@/pack/delta"

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
		expect(() => applyDelta(base, delta)).toThrow(/base size/)
	})
})

import { describe, expect, it } from "vitest"
import { applyDelta } from "@/pack/delta"
import { expectGitFormatError } from "@/testing/expect-format-error"

/** The delta header's LEB128 size varint (LSB group first), per gitformat-pack —
 * re-derived here so the hand vectors own the format rather than importing it. */
function sizeVarint(value: number): number[] {
	const out: number[] = []
	let v = value
	do {
		let b = v & 0x7f
		v = Math.floor(v / 128)
		if (v > 0) b |= 0x80
		out.push(b)
	} while (v > 0)
	return out
}

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

	// The two WIDE COPY present-bit forms below are unreachable from our own
	// encoder — `pushCopies` splits every run at 0xFFFF, so it never needs a third
	// size byte, and no base a test can hold reaches a 2^24 offset. Real git emits
	// both on large near-identical blobs, so they arrive from FOREIGN packs, where
	// the bytes are attacker-controlled; hand vectors are the only way to reach
	// them.
	it("reads a COPY whose size is carried in the third (0x40) size byte", () => {
		const base = Buffer.alloc(0x1_0008, 0x41)
		base.write("HEAD", 0, "latin1")
		base.write("MIDL", 0x8000, "latin1")
		base.write("PAST", 0x1_0000, "latin1") // beyond the copied range
		const delta = Buffer.from([
			...sizeVarint(base.length),
			...sizeVarint(0x1_0004),
			0xc0, // COPY: offset bytes absent (⇒ 0), third size byte present…
			0x01, // …⇒ size = 0x01 << 16 = 65536, both low size bytes zero
			0x04, // INSERT 4 literal bytes — a mis-consumed size byte derails here
			...Buffer.from("TAIL", "latin1"),
		])
		const got = applyDelta(base, delta)
		expect(got.length).toBe(0x1_0004)
		expect(got.subarray(0, 0x1_0000).equals(base.subarray(0, 0x1_0000))).toBe(true)
		expect(got.subarray(0x1_0000).toString("latin1")).toBe("TAIL")
	})

	it("reads a COPY at an offset carried in the fourth (0x08) offset byte", () => {
		// A fourth offset byte is only needed past 16 MiB, so the base must be that
		// large. What is pinned is that the byte is consumed and scaled by 2^24; the
		// branch's `+=` (rather than `|=`) arithmetic only becomes observable past
		// 2^31, which no test-sized base can reach.
		const base = Buffer.alloc(0x100_0010, 0x2e)
		base.write("WIDE", 0x100_0000, "latin1")
		const delta = Buffer.from([
			...sizeVarint(base.length),
			...sizeVarint(4),
			0x98, // COPY: fourth offset byte present + first size byte present…
			0x01, // …⇒ offset = 0x01 * 2^24 = 16,777,216
			0x04, // …⇒ size = 4
		])
		expect(applyDelta(base, delta).toString("latin1")).toBe("WIDE")
	})

	it("round-trips a sub-minimum internal program (the wire boundary owns git's DELTA_SIZE_MIN)", () => {
		// `01 00`: source size 1, target size 0 — our encoder legally produces
		// this for an empty target and applyDelta must reconstruct it; FOREIGN
		// packs with sub-minimum programs are rejected in read-pack instead.
		expect(applyDelta(Buffer.from("x"), Buffer.from([0x01, 0x00])).length).toBe(0)
	})

	it("throws when a COPY reaches past the base (never synthesizes zeros)", () => {
		// Buffer.copy would CLAMP the read while outPos advances by the declared
		// size — a malformed delta canonical index-pack rejects must throw, not
		// return the base padded with zeros.
		const base = Buffer.from("aa")
		const delta = Buffer.from([
			0x02, // source size = 2
			0x04, // target size = 4
			0x90,
			0x04, // COPY offset 0, size 4 — past the 2-byte base
		])
		expect(expectGitFormatError(() => applyDelta(base, delta))).toBe(
			"delta-copy-out-of-range",
		)
	})

	it("throws when a COPY overflows the declared target size", () => {
		const base = Buffer.from("aa")
		const delta = Buffer.from([
			0x02, // source size = 2
			0x01, // target size = 1
			0x90,
			0x02, // COPY offset 0, size 2 — overflows the 1-byte target
		])
		expect(expectGitFormatError(() => applyDelta(base, delta))).toBe(
			"delta-copy-out-of-range",
		)
	})

	it("throws when an INSERT declares more literal bytes than the delta carries", () => {
		const base = Buffer.from("aa")
		const delta = Buffer.from([
			0x02, // source size = 2
			0x03, // target size = 3
			0x03, // INSERT 3 literal bytes…
			0x41, // …but only one follows
		])
		expect(expectGitFormatError(() => applyDelta(base, delta))).toBe(
			"delta-insert-truncated",
		)
	})

	it("throws when the base size disagrees with the delta header", () => {
		const base = Buffer.from("abc") // 3 bytes
		// header says source size 5 (padded to git's 4-byte minimum program)
		const delta = Buffer.from([0x05, 0x01, 0x00, 0x00])
		expect(expectGitFormatError(() => applyDelta(base, delta))).toBe(
			"delta-base-size-mismatch",
		)
	})

	it("throws on the reserved opcode 0x00", () => {
		const base = Buffer.from("abc") // 3 bytes
		// header: sourceSize=3, targetSize=5, then the reserved instruction byte
		// 0x00 (padded past git's 4-byte minimum so the reserved check is reached).
		const delta = Buffer.from([0x03, 0x05, 0x00, 0x41])
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

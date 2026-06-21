import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	decodePktStream,
	encodePkt,
	encodePktLine,
	type Pkt,
	WRITER_MAX_PAYLOAD,
} from "@/pkt-line"
import { spawnGit } from "@/testing/spawn-git"

const arbPkt: fc.Arbitrary<Pkt> = fc.oneof(
	// Payload sizes 0..2000 span the empty (0004) and DEFAULT_PACKET_MAX (1000) edges.
	fc
		.uint8Array({ maxLength: 2000, minLength: 0 })
		.map((u) => ({ payload: Buffer.from(u), type: "data" as const })),
	fc.constant({ type: "flush" as const }),
	fc.constant({ type: "delim" as const }),
	fc.constant({ type: "response-end" as const }),
)

describe("encodePktLine", () => {
	it("frames a data packet with a 4-hex length prefix (length includes the prefix)", () => {
		const out = encodePktLine(Buffer.from("hello\n"))
		// 6 payload bytes + 4 prefix = 10 = 0x000a
		expect(out.toString("latin1")).toBe("000ahello\n")
	})
})

describe("encodePkt", () => {
	it("encodes the three special zero-payload packets", () => {
		expect(encodePkt({ type: "flush" }).toString("latin1")).toBe("0000")
		expect(encodePkt({ type: "delim" }).toString("latin1")).toBe("0001")
		expect(encodePkt({ type: "response-end" }).toString("latin1")).toBe("0002")
	})

	it("encodes a data packet identically to encodePktLine", () => {
		const payload = Buffer.from("hello\n")
		expect(encodePkt({ payload, type: "data" })).toEqual(encodePktLine(payload))
	})
})

describe("decodePktStream", () => {
	it("decodes a stream of data + special packets, leaving no remainder", () => {
		const buf = Buffer.concat([
			encodePktLine(Buffer.from("hello\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from("world")),
			encodePkt({ type: "response-end" }),
			encodePkt({ type: "flush" }),
		])
		const { packets, rest } = decodePktStream(buf)
		expect(packets).toEqual([
			{ payload: Buffer.from("hello\n"), type: "data" },
			{ type: "delim" },
			{ payload: Buffer.from("world"), type: "data" },
			{ type: "response-end" },
			{ type: "flush" },
		])
		expect(rest.length).toBe(0)
	})

	it("decodes an empty data packet (0004) as zero-length payload", () => {
		const { packets, rest } = decodePktStream(Buffer.from("0004", "latin1"))
		expect(packets).toEqual([{ payload: Buffer.alloc(0), type: "data" }])
		expect(rest.length).toBe(0)
	})

	it("leaves a trailing partial data packet in rest (does not mis-consume)", () => {
		const full = encodePktLine(Buffer.from("hello\n")) // 000ahello\n (10 bytes)
		const truncated = full.subarray(0, 7) // 000ahel — body incomplete
		const { packets, rest } = decodePktStream(truncated)
		expect(packets).toEqual([])
		expect(rest).toEqual(truncated)
	})

	it("leaves a trailing partial length prefix (<4 bytes) in rest", () => {
		const buf = Buffer.concat([encodePkt({ type: "flush" }), Buffer.from("00", "latin1")])
		const { packets, rest } = decodePktStream(buf)
		expect(packets).toEqual([{ type: "flush" }])
		expect(rest).toEqual(Buffer.from("00", "latin1"))
	})
})

describe("pkt-line bounds + validation", () => {
	it("rejects the reserved length 0003", () => {
		expect(() => decodePktStream(Buffer.from("0003", "latin1"))).toThrow(/0003/)
	})

	it("rejects a non-hex length prefix", () => {
		expect(() => decodePktStream(Buffer.from("zzzzdata", "latin1"))).toThrow(
			/length prefix/,
		)
	})

	it("rejects a declared length over the reader bound (payload > 65516)", () => {
		// 0xfff1 = 65521 ⇒ payload 65517 > 65516
		expect(() => decodePktStream(Buffer.from("fff1", "latin1"))).toThrow(/65516/)
	})

	it("encodePktLine rejects a payload over the writer cap (65515)", () => {
		expect(() => encodePktLine(Buffer.alloc(65516))).toThrow(/65515/)
	})
})

describe("pkt-line generative round-trip (fast-check)", () => {
	it("round-trips arbitrary packet sequences (encode → decode)", () => {
		fc.assert(
			fc.property(fc.array(arbPkt, { maxLength: 50 }), (pkts) => {
				const buf = Buffer.concat(pkts.map(encodePkt))
				const { packets, rest } = decodePktStream(buf)
				expect(rest.length).toBe(0)
				expect(packets).toEqual(pkts)
			}),
		)
	})

	it("round-trips payloads at the writer-cap boundary", () => {
		for (const size of [999, 1000, 1001, WRITER_MAX_PAYLOAD]) {
			const payload = Buffer.alloc(size, 0x61)
			const { packets, rest } = decodePktStream(encodePktLine(payload))
			expect(rest.length).toBe(0)
			expect(packets).toEqual([{ payload, type: "data" }])
		}
	})
})

describe("pkt-line against real-git framing (oracle)", () => {
	it("decodes a real git ref advertisement byte-identically", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-pktfix-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "hello\n")
			await spawnGit(["add", "a.txt"], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "seed"], { cwd: dir })

			const res = await spawnGit(["upload-pack", "--advertise-refs", dir])
			// The v0 advertisement is pure ASCII (hex lengths, hex OIDs, caps).
			const adv = Buffer.from(res.stdout, "utf8")
			expect(adv.length).toBeGreaterThan(0)

			const { packets, rest } = decodePktStream(adv)
			expect(rest.length).toBe(0)
			// Byte-identical re-encode ⇒ our framing matches canonical git's.
			expect(Buffer.concat(packets.map(encodePkt))).toEqual(adv)
			// Structural sanity: terminates with a flush, carries ref data.
			expect(packets.at(-1)).toEqual({ type: "flush" })
			expect(packets.some((p) => p.type === "data")).toBe(true)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

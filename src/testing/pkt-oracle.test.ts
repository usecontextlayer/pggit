import { describe, expect, it } from "vitest"
import { computeOid } from "@/object"
import { encodePkt, encodePktLine } from "@/pkt-line"
import {
	EMPTY_BLOB,
	EMPTY_TREE,
	framedPktLines,
	pktLineUnpack,
	renderRefAdvertV0,
	sidebandDemux,
	ZERO_OID,
} from "@/testing/pkt-oracle"

// These expectations are derived verbatim from git's own test helpers, which we
// MIRROR (not guess): `unpack`/`unpack-sideband` in
// `/tmp/git-src/t/helper/test-pkt-line.c:42-130`, and the t5411 raw report form
// in `/tmp/git-src/t/t5411/once-0010-report-status-v1.sh`. See spec §4.2/§4.3.

const A = "a".repeat(40)
const B = "b".repeat(40)

/** Build a data pkt-line carrying `s` (verbatim, no added newline). */
const pkt = (s: string) => encodePktLine(Buffer.from(s, "latin1"))
const FLUSH = encodePkt({ type: "flush" })
const DELIM = encodePkt({ type: "delim" })
const RESPONSE_END = encodePkt({ type: "response-end" })

describe("pktLineUnpack — mirror of `test-tool pkt-line unpack`", () => {
	it("renders one line per packet, special packets as their 4 hex digits", () => {
		const stream = Buffer.concat([
			pkt("version 2\n"),
			pkt("agent=pggit/0.0.0\n"),
			pkt("ls-refs=unborn\n"),
			pkt("fetch=filter\n"),
			pkt("object-format=sha1\n"),
			FLUSH,
		])
		expect(pktLineUnpack(stream)).toBe(
			"version 2\nagent=pggit/0.0.0\nls-refs=unborn\nfetch=filter\nobject-format=sha1\n0000\n",
		)
	})

	it("chomps a SINGLE trailing newline then re-adds one (PACKET_READ_CHOMP_NEWLINE)", () => {
		// A payload that already ends in \n and one that does not both render
		// identically — the decode is intentionally lossy on the trailing \n.
		expect(pktLineUnpack(pkt("ACK abc\n"))).toBe("ACK abc\n")
		expect(pktLineUnpack(pkt("ACK abc"))).toBe("ACK abc\n")
	})

	it("renders an empty (0004) packet as a single blank line", () => {
		expect(pktLineUnpack(encodePktLine(Buffer.alloc(0)))).toBe("\n")
	})

	it("renders flush/delim/response-end as 0000/0001/0002 lines", () => {
		expect(pktLineUnpack(FLUSH)).toBe("0000\n")
		expect(pktLineUnpack(DELIM)).toBe("0001\n")
		expect(pktLineUnpack(RESPONSE_END)).toBe("0002\n")
	})

	it("renders an acknowledgments (NAK) section", () => {
		const stream = Buffer.concat([pkt("acknowledgments\n"), pkt("NAK\n"), FLUSH])
		expect(pktLineUnpack(stream)).toBe("acknowledgments\nNAK\n0000\n")
	})
})

describe("framedPktLines — the t5411 length-prefixed renderer", () => {
	it("renders each data packet as <4hex><payload>, flush as bare 0000", () => {
		const report = Buffer.concat([pkt("unpack ok\n"), pkt("ok refs/heads/main\n"), FLUSH])
		// 000e = 14 = 4 + len("unpack ok\n"); 0017 = 23 = 4 + len("ok refs/heads/main\n").
		expect(framedPktLines(report)).toBe("000eunpack ok\n0017ok refs/heads/main\n0000")
	})
})

describe("sidebandDemux — mirror of `test-tool pkt-line unpack-sideband`", () => {
	it("concatenates raw per-band payloads, binary-safe, no added newline", () => {
		const packBytes = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0x01, 0xff]) // "PACK"\0\x01\xff
		const progress = Buffer.from("counting...", "latin1")
		const stream = Buffer.concat([
			encodePktLine(Buffer.concat([Buffer.from([1]), packBytes])),
			encodePktLine(Buffer.concat([Buffer.from([2]), progress])),
			encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from([0xde, 0xad])])),
			FLUSH,
		])
		const { band1, band2, band3 } = sidebandDemux(stream)
		expect(band1).toEqual(Buffer.concat([packBytes, Buffer.from([0xde, 0xad])]))
		expect(band2).toEqual(progress)
		expect(band3).toEqual(Buffer.alloc(0))
	})

	it("recovers the pack from an encodePackfileResponse-style stream (band byte 0x01)", () => {
		const pack = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02])
		// The leading `packfile\n` is a PLAIN pkt-line (band byte 'p' = 0x70) → ignored.
		const stream = Buffer.concat([
			pkt("packfile\n"),
			encodePktLine(Buffer.concat([Buffer.from([1]), pack])),
			FLUSH,
		])
		expect(sidebandDemux(stream).band1).toEqual(pack)
	})
})

describe("renderRefAdvertV0 — NUL-aware v0 push advert decode", () => {
	it("decodes an empty-repo advert (synthetic capabilities^{} line)", () => {
		const stream = Buffer.concat([
			pkt(`${ZERO_OID} capabilities^{}\0report-status delete-refs side-band-64k\n`),
			FLUSH,
		])
		expect(renderRefAdvertV0(stream)).toEqual({
			endsWithFlush: true,
			refs: [
				{
					caps: ["report-status", "delete-refs", "side-band-64k"],
					name: "capabilities^{}",
					oid: ZERO_OID,
				},
			],
		})
	})

	it("decodes caps after the NUL on the first ref only; later refs are plain", () => {
		const stream = Buffer.concat([
			pkt(`${A} refs/heads/main\0report-status atomic\n`),
			pkt(`${B} refs/heads/dev\n`),
			FLUSH,
		])
		expect(renderRefAdvertV0(stream)).toEqual({
			endsWithFlush: true,
			refs: [
				{ caps: ["report-status", "atomic"], name: "refs/heads/main", oid: A },
				{ name: "refs/heads/dev", oid: B },
			],
		})
	})

	it("records a missing trailing flush", () => {
		expect(renderRefAdvertV0(pkt(`${A} refs/heads/main\n`)).endsWithFlush).toBe(false)
	})
})

describe("test_oid well-known values are the real git sha1 OIDs", () => {
	// Non-vacuous: derive the empty-tree/empty-blob OIDs independently via computeOid
	// (the git-oid contract) and pin the constants to them — rather than asserting a
	// literal equals its own definition.
	it("EMPTY_TREE / EMPTY_BLOB match computeOid of the empty object", () => {
		expect(computeOid("tree", Buffer.alloc(0))).toBe(EMPTY_TREE)
		expect(computeOid("blob", Buffer.alloc(0))).toBe(EMPTY_BLOB)
	})
})

/**
 * §8.1 in-process pkt-line oracle — UPLOAD-PACK (fetch, protocol v2) wire goldens.
 *
 * SPEC-SUITE (`*.spec.test.ts`): authored as the executable spec of the desired
 * wire output BEFORE the implementation is made to conform (spec §3). Off the
 * default gate; run with `pnpm run test.spec`. Most assertions here already pass
 * because M0/M1 are correct — they codify that correctness and lock it against
 * regression; any that fail are Phase-3 worklist items (do NOT fix the impl here).
 *
 * Each golden is authored INDEPENDENTLY in git's grammar (spec §4.6 "the test
 * owns the canonical spec"), parametrized over OIDs/agent/algo (never frozen
 * hex), and decoded with the pkt-oracle primitives. The one allowed coupling is
 * importing AGENT from the handler — it is an external input, not the spec.
 */
import { describe, expect, it } from "vitest"
import { decodePktStream } from "@/pkt-line"
import {
	AGENT,
	encodeAcknowledgments,
	encodeAdvertisement,
	encodeLsRefsResponse,
	encodePackfileResponse,
	encodeReadyWithPack,
} from "@/protocol/v2"
import { ALGO, pktLineUnpack, sidebandDemux } from "@/testing/pkt-oracle"

// Readable synthetic OIDs for encoder inputs (spec §4.5; the v2.test.ts convention).
const A = "a".repeat(40)
const B = "b".repeat(40)
const C = "c".repeat(40)
const T = "d".repeat(40)

describe("§8.1 upload-pack wire — surface 1: v2 capability advertisement", () => {
	// The canonical advert, authored in git's grammar (serve.c order), with OUR
	// honored cap set: `fetch=filter`, not git's `fetch=shallow wait-for-done`
	// (§4.2.3 — advertise only what we honor). Template over agent + algo.
	const advert = (agent: string, algo: string) =>
		`version 2\n` +
		`agent=${agent}\n` +
		`ls-refs=unborn\n` +
		`fetch=filter\n` +
		`object-format=${algo}\n` +
		`0000\n`

	it("emits version 2, the honored caps in canonical order, and a trailing flush", () => {
		expect(pktLineUnpack(encodeAdvertisement())).toBe(advert(AGENT, ALGO))
	})
})

describe("§8.1 upload-pack wire — surface 2: ls-refs response", () => {
	it("emits one `<oid> <name>` line per ref, then flush", () => {
		const out = encodeLsRefsResponse([
			{ name: "refs/heads/main", oid: A },
			{ name: "refs/heads/dev", oid: B },
		])
		expect(pktLineUnpack(out)).toBe(`${A} refs/heads/main\n${B} refs/heads/dev\n0000\n`)
	})

	it("appends `symref-target:` for a symbolic ref (HEAD)", () => {
		const out = encodeLsRefsResponse([
			{ name: "HEAD", oid: C, symrefTarget: "refs/heads/master" },
			{ name: "refs/heads/master", oid: C },
		])
		expect(pktLineUnpack(out)).toBe(
			`${C} HEAD symref-target:refs/heads/master\n${C} refs/heads/master\n0000\n`,
		)
	})

	it("appends `peeled:` for an annotated tag", () => {
		const out = encodeLsRefsResponse([{ name: "refs/tags/v1", oid: T, peeled: C }])
		expect(pktLineUnpack(out)).toBe(`${T} refs/tags/v1 peeled:${C}\n0000\n`)
	})

	it("emits symref-target BEFORE peeled when a ref carries both", () => {
		const out = encodeLsRefsResponse([
			{ name: "HEAD", oid: C, peeled: T, symrefTarget: "refs/heads/main" },
		])
		expect(pktLineUnpack(out)).toBe(
			`${C} HEAD symref-target:refs/heads/main peeled:${T}\n0000\n`,
		)
	})

	it("an empty (unborn) ref set is just a flush", () => {
		expect(pktLineUnpack(encodeLsRefsResponse([]))).toBe("0000\n")
	})
})

describe("§8.1 upload-pack wire — surface 3: fetch acknowledgments (no pack)", () => {
	it("no common objects, not ready → `acknowledgments` + `NAK` + flush", () => {
		expect(pktLineUnpack(encodeAcknowledgments([], false))).toBe(
			"acknowledgments\nNAK\n0000\n",
		)
	})

	it("one common object → bare `ACK <oid>` (no v0-style suffix)", () => {
		expect(pktLineUnpack(encodeAcknowledgments([A], false))).toBe(
			`acknowledgments\nACK ${A}\n0000\n`,
		)
	})

	it("multiple common objects → one `ACK` line each, in order", () => {
		expect(pktLineUnpack(encodeAcknowledgments([A, B], false))).toBe(
			`acknowledgments\nACK ${A}\nACK ${B}\n0000\n`,
		)
	})
})

describe("§8.1 upload-pack wire — surface 4: ready + packfile (same response)", () => {
	const pack = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02, 0xff])

	/** The acknowledgments-section text (the data packets up to the delim). */
	function ackSection(out: Buffer): { text: string; hasDelim: boolean } {
		const { packets } = decodePktStream(out)
		const delimIdx = packets.findIndex((p) => p.type === "delim")
		const text = packets
			.slice(0, delimIdx)
			.map((p) => (p.type === "data" ? p.payload.toString("utf8") : ""))
			.join("")
		return { hasDelim: delimIdx >= 0, text }
	}

	it("no common → `acknowledgments` + `ready`, then DELIM, then the pack", () => {
		const out = encodeReadyWithPack([], pack)
		expect(ackSection(out)).toEqual({ hasDelim: true, text: "acknowledgments\nready\n" })
		expect(sidebandDemux(out).band1).toEqual(pack) // pack follows in the SAME response
	})

	it("with common → `ACK` lines precede `ready`, then DELIM + pack", () => {
		const out = encodeReadyWithPack([A, B], pack)
		expect(ackSection(out)).toEqual({
			hasDelim: true,
			text: `acknowledgments\nACK ${A}\nACK ${B}\nready\n`,
		})
		expect(sidebandDemux(out).band1).toEqual(pack)
	})
})

describe("§8.1 upload-pack wire — surface 5: packfile section", () => {
	it("emits a `packfile\\n` header, then band-1 sideband, then flush", () => {
		const pack = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0x00, 0x01, 0xff, 0x00])
		const out = encodePackfileResponse(pack)
		const { packets } = decodePktStream(out)
		expect(
			(packets[0] as { type: "data"; payload: Buffer }).payload.toString("utf8"),
		).toBe("packfile\n")
		expect(packets.at(-1)?.type).toBe("flush")
		// Every band packet rides band 1; demux recovers the pack byte-identical.
		const bands = packets.slice(1, -1) as { type: "data"; payload: Buffer }[]
		expect(bands.every((p) => p.payload[0] === 1)).toBe(true)
		expect(sidebandDemux(out).band1).toEqual(pack)
	})

	it("splits a pack larger than the band payload cap into multiple band-1 packets", () => {
		// MAX_BAND_DATA = 65514 (band byte + data must fit the 65515 writer cap).
		const big = Buffer.alloc(70_000)
		for (let i = 0; i < big.length; i++) big[i] = i % 256
		const out = encodePackfileResponse(big)
		const { packets } = decodePktStream(out)
		const bands = packets.filter(
			(p): p is { type: "data"; payload: Buffer } =>
				p.type === "data" && p.payload[0] === 1,
		)
		expect(bands.length).toBeGreaterThanOrEqual(2) // multi-chunk
		expect(sidebandDemux(out).band1).toEqual(big) // reassembles, binary-safe
	})
})

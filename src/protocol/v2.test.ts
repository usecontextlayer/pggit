import { describe, expect, it } from "vitest"
import { decodePktStream, encodePkt, encodePktLine, type Pkt } from "@/pkt-line"
import {
	encodeAdvertisement,
	encodeLsRefsResponse,
	encodePackfileResponse,
	parseFetch,
	parseV2Request,
} from "@/protocol/v2"

const A = "a".repeat(40)
const B = "b".repeat(40)
const C = "c".repeat(40)
const T = "d".repeat(40)

function dataLines(buf: Buffer): string[] {
	return decodePktStream(buf)
		.packets.filter((p): p is Extract<Pkt, { type: "data" }> => p.type === "data")
		.map((p) => p.payload.toString("utf8").replace(/\n$/, ""))
}

describe("v2 advertisement", () => {
	it("advertises version 2 + only-honored capabilities, ending in flush", () => {
		const adv = encodeAdvertisement()
		const lines = dataLines(adv)
		expect(lines[0]).toBe("version 2")
		expect(lines).toContain("ls-refs=unborn")
		expect(lines).toContain("object-format=sha1")
		expect(lines.some((l) => l === "fetch" || l.startsWith("fetch="))).toBe(true)
		expect(lines.some((l) => l.startsWith("agent=pggit"))).toBe(true)
		// we do NOT advertise shallow/filter/ref-in-want (not honored in M0)
		expect(lines.some((l) => l.includes("shallow"))).toBe(false)
		expect(decodePktStream(adv).packets.at(-1)).toEqual({ type: "flush" })
	})
})

describe("parseV2Request / parseFetch", () => {
	it("parses an ls-refs command and its args", () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=ls-refs\n")),
			encodePktLine(Buffer.from("object-format=sha1\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from("peel\n")),
			encodePktLine(Buffer.from("symrefs\n")),
			encodePktLine(Buffer.from("ref-prefix refs/heads/\n")),
			encodePkt({ type: "flush" }),
		])
		const req = parseV2Request(body)
		expect(req.command).toBe("ls-refs")
		expect(req.args).toEqual(["peel", "symrefs", "ref-prefix refs/heads/"])
	})

	it("parses fetch wants + done", () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=fetch\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from(`want ${A}\n`)),
			encodePktLine(Buffer.from(`want ${B}\n`)),
			encodePktLine(Buffer.from("done\n")),
			encodePkt({ type: "flush" }),
		])
		const fetch = parseFetch(parseV2Request(body))
		expect(fetch.wants).toEqual([A, B])
		expect(fetch.done).toBe(true)
		expect(fetch.haves).toEqual([])
	})
})

describe("encodeLsRefsResponse", () => {
	it("emits oid+ref, symref-target for HEAD, peeled for tags, then flush", () => {
		const out = encodeLsRefsResponse([
			{ name: "HEAD", oid: C, symrefTarget: "refs/heads/master" },
			{ name: "refs/heads/master", oid: C },
			{ name: "refs/tags/v1", oid: T, peeled: C },
		])
		expect(dataLines(out)).toEqual([
			`${C} HEAD symref-target:refs/heads/master`,
			`${C} refs/heads/master`,
			`${T} refs/tags/v1 peeled:${C}`,
		])
		expect(decodePktStream(out).packets.at(-1)).toEqual({ type: "flush" })
	})
})

describe("encodePackfileResponse", () => {
	it("wraps the pack in a packfile section + band-1 sideband + flush", () => {
		const pack = Buffer.from("PACK and then some bytes \x00\x01\xff")
		const { packets } = decodePktStream(encodePackfileResponse(pack))
		const data = packets.filter(
			(p): p is Extract<Pkt, { type: "data" }> => p.type === "data",
		)
		expect(data[0]?.payload.toString("utf8")).toBe("packfile\n")
		const bands = data.slice(1)
		expect(bands.every((p) => p.payload[0] === 1)).toBe(true)
		const reassembled = Buffer.concat(bands.map((p) => p.payload.subarray(1)))
		expect(reassembled).toEqual(pack)
		expect(packets.at(-1)).toEqual({ type: "flush" })
	})
})

import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { parseFetch, parseV2Request } from "@/protocol/v2"

/**
 * v2 request DECODE — the happy path of `parseV2Request`/`parseFetch` (the
 * malformed and boundary cases are v2.parse.test.ts's). The v2 ENCODE
 * surfaces (advertisement, ls-refs response, packfile section) are goldens in
 * upload-pack-wire.test.ts and live there only so the capability contract has a
 * single executable definition.
 */

const A = "a".repeat(40)
const B = "b".repeat(40)

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

/**
 * §8.1 server-boundary DECODE negatives — the request-parsing trust boundary.
 *
 * SPEC-SUITE (`*.spec.test.ts`): the executable spec for how the three decode
 * functions (`parseV2Request`, `parseFetch`, `parseReceivePack`) and the
 * `handleUploadPack` dispatcher behave on MALFORMED input. Every byte a hostile
 * or buggy client sends flows through these; CLAUDE.md mandates "validate at the
 * boundary, fail loud". A malformed command line must error, never be silently
 * dropped (which would apply a partial command set with no diagnostic).
 */
import { describe, expect, it } from "vitest"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { GitProtocolError } from "@/protocol/errors"
import { parseReceivePack } from "@/protocol/receive-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { parseFetch, parseV2Request } from "@/protocol/v2"

const A = "a".repeat(40)
const B = "b".repeat(40)
const Z = "0".repeat(40)

/** A receive-pack body: command lines, a flush, then the (here empty) pack. */
function receiveBody(lines: string[]): Buffer {
	return Buffer.concat([
		...lines.map((l) => encodePktLine(Buffer.from(l))),
		encodePkt({ type: "flush" }),
	])
}

/** A backend that throws if touched — proves a decode rejection happens FIRST. */
const untouchedBackend = new Proxy({} as RepoBackend, {
	get() {
		throw new Error("backend must not be reached on a decode rejection")
	},
})

describe("parseFetch — keeps valid args, ignores unknown ones", () => {
	it("ignores an unknown arg but keeps wants/haves/done", () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=fetch\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from(`want ${A}\n`)),
			encodePktLine(Buffer.from("frobnicate the widget\n")),
			encodePktLine(Buffer.from(`have ${B}\n`)),
			encodePktLine(Buffer.from("done\n")),
			encodePkt({ type: "flush" }),
		])
		const fetch = parseFetch(parseV2Request(body))
		expect(fetch.wants).toEqual([A])
		expect(fetch.haves).toEqual([B])
		expect(fetch.done).toBe(true)
	})
})

describe("parseReceivePack — command-list decode", () => {
	it("parses a valid command, splitting caps off the first line only", () => {
		const body = receiveBody([`${Z} ${A} refs/heads/main\0report-status atomic`])
		const req = parseReceivePack(body)
		expect(req.commands).toEqual([{ newOid: A, oldOid: Z, ref: "refs/heads/main" }])
		expect(req.caps).toEqual(["report-status", "atomic"])
		expect(req.pack.length).toBe(0)
	})

	it("a delete-only push (flush, no pack) parses with an empty pack", () => {
		const body = receiveBody([`${A} ${Z} refs/heads/gone\0report-status`])
		const req = parseReceivePack(body)
		expect(req.commands).toEqual([{ newOid: Z, oldOid: A, ref: "refs/heads/gone" }])
		expect(req.pack.length).toBe(0)
	})

	it("caps ride the first line; later command lines are plain", () => {
		const body = receiveBody([
			`${Z} ${A} refs/heads/main\0report-status`,
			`${Z} ${B} refs/heads/dev`,
		])
		const req = parseReceivePack(body)
		expect(req.commands.map((c) => c.ref)).toEqual(["refs/heads/main", "refs/heads/dev"])
		expect(req.caps).toEqual(["report-status"])
	})

	it("throws on a 2-token command line (fail loud, not silently dropped)", () => {
		expect(() => parseReceivePack(receiveBody([`${A} refs/heads/main`]))).toThrow(
			GitProtocolError,
		)
	})

	it("throws on a 4-token command line", () => {
		expect(() =>
			parseReceivePack(receiveBody([`${Z} ${A} refs/heads/main extra`])),
		).toThrow(GitProtocolError)
	})
})

describe("handleUploadPack — command dispatch", () => {
	it("throws GitProtocolError on an unsupported command, before touching the backend", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=frobnicate\n")),
			encodePkt({ type: "delim" }),
			encodePkt({ type: "flush" }),
		])
		await expect(handleUploadPack(body, untouchedBackend)).rejects.toThrow(
			GitProtocolError,
		)
	})
})

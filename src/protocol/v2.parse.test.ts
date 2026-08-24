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
import { GitProtocolError } from "@/protocol/errors"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { parseReceivePack } from "@/protocol/receive-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { parseFetch, parseV2Request } from "@/protocol/v2"
import { receivePackRequest } from "@/testing/wire-receive"

const A = "a".repeat(40)
const B = "b".repeat(40)
const Z = "0".repeat(40)

/** A benign read-only stub. (upload-pack's backend has no mutating methods, so
 * "no side effect" is structural; we assert the observable contract — an
 * unsupported command rejects with GitProtocolError — not internal call ordering.) */
const stubBackend: RepoBackend = {
	buildPack: async () => Buffer.alloc(0),
	getSymref: async () => null,
	listRefs: async () => [],
	processHaves: async () => ({ acks: [], common: [] }),
	readyToGiveUp: async () => false,
}

describe("parseFetch — argument dispatch", () => {
	it("rejects an unknown argument instead of running a plausible subset", () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=fetch\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from(`want ${A}\n`)),
			encodePktLine(Buffer.from("frobnicate the widget\n")),
			encodePktLine(Buffer.from(`have ${B}\n`)),
			encodePktLine(Buffer.from("done\n")),
			encodePkt({ type: "flush" }),
		])
		expect(() => parseFetch(parseV2Request(body))).toThrow(
			/fetch: unsupported argument "frobnicate the widget"/,
		)
	})

	it("accepts the no-state ofs-delta and no-progress arguments", () => {
		const fetch = parseFetch({
			args: [`want ${A}`, "ofs-delta", "no-progress", "done"],
			capabilities: [],
			command: "fetch",
		})
		expect(fetch).toMatchObject({ done: true, wants: [A] })
	})
})

describe("parseReceivePack — command-list decode", () => {
	it("parses a valid command, splitting caps off the first line only", () => {
		const body = receivePackRequest([`${Z} ${A} refs/heads/main\0report-status atomic`])
		const req = parseReceivePack(body)
		expect(req.commands).toEqual([{ newOid: A, oldOid: Z, ref: "refs/heads/main" }])
		expect(req.caps).toEqual(["report-status", "atomic"])
		expect(req.pack.length).toBe(0)
	})

	it("a delete-only push (flush, no pack) parses with an empty pack", () => {
		const body = receivePackRequest([`${A} ${Z} refs/heads/gone\0report-status`])
		const req = parseReceivePack(body)
		expect(req.commands).toEqual([{ newOid: Z, oldOid: A, ref: "refs/heads/gone" }])
		expect(req.pack.length).toBe(0)
	})

	it("caps ride the first line; later command lines are plain", () => {
		const body = receivePackRequest([
			`${Z} ${A} refs/heads/main\0report-status`,
			`${Z} ${B} refs/heads/dev`,
		])
		const req = parseReceivePack(body)
		expect(req.commands.map((c) => c.ref)).toEqual(["refs/heads/main", "refs/heads/dev"])
		expect(req.caps).toEqual(["report-status"])
	})

	it("throws on a 2-token command line (fail loud, not silently dropped)", () => {
		expect(() => parseReceivePack(receivePackRequest([`${A} refs/heads/main`]))).toThrow(
			GitProtocolError,
		)
	})

	it("throws on a 4-token command line", () => {
		expect(() =>
			parseReceivePack(receivePackRequest([`${Z} ${A} refs/heads/main extra`])),
		).toThrow(GitProtocolError)
	})

	// The command ids cross the trust boundary here: downstream they are fed to
	// Buffer.from(oid, "hex"), which silently truncates garbage. Each malformed
	// shape must throw in EITHER position; the zero sentinel (valid 40-hex) is
	// already pinned by the passing cases above.
	it("throws on a malformed object id in either position (non-hex, short, uppercase)", () => {
		for (const bad of ["z".repeat(40), "a".repeat(39), "A".repeat(40)]) {
			expect(() =>
				parseReceivePack(receivePackRequest([`${bad} ${A} refs/heads/main`])),
			).toThrow(/malformed object id/)
			expect(() =>
				parseReceivePack(receivePackRequest([`${A} ${bad} refs/heads/main`])),
			).toThrow(/malformed object id/)
		}
	})
})

describe("handleUploadPack — command dispatch", () => {
	it("throws GitProtocolError on an unsupported command", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=frobnicate\n")),
			encodePkt({ type: "delim" }),
			encodePkt({ type: "flush" }),
		])
		await expect(handleUploadPack(body, stubBackend)).rejects.toThrow(GitProtocolError)
	})
})

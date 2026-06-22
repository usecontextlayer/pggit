import { decodePktStream, encodePkt, encodePktLine } from "@/pkt-line"
import { GitProtocolError } from "@/protocol/errors"

export const AGENT = "pggit/0.0.0"

/**
 * Reject a client negotiating a non-sha1 object hash. pggit is SHA-1 only (the
 * charter) and assumes 40-hex / 20-byte OIDs everywhere; a sha256 client would
 * otherwise fail deep in the parser on a 64-hex OID. Catch it at the boundary
 * with a clear message. An absent `object-format` cap defaults to sha1 (git's
 * default), so it is accepted.
 */
export function assertSupportedObjectFormat(caps: string[]): void {
	const fmt = caps.find((c) => c.startsWith("object-format="))
	if (fmt !== undefined && fmt !== "object-format=sha1") {
		throw new GitProtocolError(
			`unsupported ${fmt} — only object-format=sha1 is supported`,
		)
	}
}
const SIDEBAND_DATA = 0x01
// band byte + pack data must fit the pkt-line writer cap (65515).
const MAX_BAND_DATA = 65514

/**
 * The v2 capability advertisement (GET info/refs body, minus HTTP framing).
 * We advertise ONLY what we honor (spec §4): ls-refs (with `unborn`) and fetch
 * with the `filter` (partial clone) and `include-tag` (auto-follow annotated tags)
 * features. No shallow / ref-in-want — those have no milestone owner and
 * advertising them flips clients onto unimplemented paths.
 */
export function encodeAdvertisement(): Buffer {
	const caps = [
		"version 2",
		`agent=${AGENT}`,
		"ls-refs=unborn",
		"fetch=filter include-tag",
		"object-format=sha1",
	]
	return Buffer.concat([
		...caps.map((c) => encodePktLine(Buffer.from(`${c}\n`))),
		encodePkt({ type: "flush" }),
	])
}

export type V2Request = {
	command: string
	capabilities: string[]
	args: string[]
}

/** Decode a `command=… <caps> 0001 <args> 0000` v2 request body. */
export function parseV2Request(body: Buffer): V2Request {
	const { packets } = decodePktStream(body)
	let command = ""
	const capabilities: string[] = []
	const args: string[] = []
	let afterDelim = false
	for (const p of packets) {
		if (p.type === "delim") {
			afterDelim = true
			continue
		}
		if (p.type !== "data") continue
		const line = p.payload.toString("utf8").replace(/\n$/, "")
		if (afterDelim) args.push(line)
		else if (line.startsWith("command=")) command = line.slice("command=".length)
		else capabilities.push(line)
	}
	return { args, capabilities, command }
}

export type FetchRequest = {
	wants: string[]
	haves: string[]
	done: boolean
	/** Partial-clone filter spec (e.g. `blob:none`), if the client sent one. */
	filter?: string
	/** Client asked the server to auto-include annotated tags pointing into the
	 * fetched set (the `include-tag` capability). */
	includeTag: boolean
}

export function parseFetch(req: V2Request): FetchRequest {
	const wants: string[] = []
	const haves: string[] = []
	let done = false
	let filter: string | undefined
	let includeTag = false
	for (const arg of req.args) {
		if (arg.startsWith("want ")) wants.push(arg.slice(5))
		else if (arg.startsWith("have ")) haves.push(arg.slice(5))
		else if (arg.startsWith("filter ")) filter = arg.slice("filter ".length)
		else if (arg === "include-tag") includeTag = true
		else if (arg === "done") done = true
	}
	return { done, filter, haves, includeTag, wants }
}

/**
 * One ls-refs line. A normal ref leads with its oid; an `unborn` ref (an empty
 * repo's HEAD, which has no commit yet) leads with the literal `unborn` token
 * instead — exactly git's `ls-refs.c send_ref` shape.
 */
export type LsRefEntry =
	| { name: string; oid: string; symrefTarget?: string; peeled?: string }
	| { name: string; unborn: true; symrefTarget?: string }

/** ls-refs response: one line per ref (+ symref-target / peeled), then flush. */
export function encodeLsRefsResponse(entries: LsRefEntry[]): Buffer {
	const lines = entries.map((e) => {
		let line = "unborn" in e ? `unborn ${e.name}` : `${e.oid} ${e.name}`
		if (e.symrefTarget) line += ` symref-target:${e.symrefTarget}`
		if ("peeled" in e && e.peeled) line += ` peeled:${e.peeled}`
		return encodePktLine(Buffer.from(`${line}\n`))
	})
	return Buffer.concat([...lines, encodePkt({ type: "flush" })])
}

/** The `acknowledgments` section lines: header, ACKs / NAK, optional `ready`. */
function acknowledgmentLines(common: string[], ready: boolean): Buffer {
	const lines: Buffer[] = [encodePktLine(Buffer.from("acknowledgments\n"))]
	if (common.length === 0 && !ready) {
		lines.push(encodePktLine(Buffer.from("NAK\n")))
	} else {
		for (const oid of common) lines.push(encodePktLine(Buffer.from(`ACK ${oid}\n`)))
		if (ready) lines.push(encodePktLine(Buffer.from("ready\n")))
	}
	return Buffer.concat(lines)
}

/**
 * fetch `acknowledgments` response for a negotiation round that is NOT yet ready
 * (no `done`): the section + flush, no pack. The client sends more haves or
 * `done` (spec §4 shape b).
 */
export function encodeAcknowledgments(common: string[], ready: boolean): Buffer {
	return Buffer.concat([acknowledgmentLines(common, ready), encodePkt({ type: "flush" })])
}

/**
 * fetch response when the server becomes `ready` mid-negotiation: the
 * acknowledgments section (with `ready`), a delim-pkt, then the packfile — git
 * requires the pack to follow `ready` in the same response (not a later round).
 */
export function encodeReadyWithPack(common: string[], pack: Buffer): Buffer {
	return Buffer.concat([
		acknowledgmentLines(common, true),
		encodePkt({ type: "delim" }),
		encodePackfileResponse(pack),
	])
}

/**
 * fetch response for the clone path (client sent `done`, no haves): the
 * `packfile` section header, the pack multiplexed over sideband band-1, flush.
 */
export function encodePackfileResponse(pack: Buffer): Buffer {
	const parts: Buffer[] = [encodePktLine(Buffer.from("packfile\n"))]
	for (let i = 0; i < pack.length; i += MAX_BAND_DATA) {
		const chunk = pack.subarray(i, i + MAX_BAND_DATA)
		parts.push(encodePktLine(Buffer.concat([Buffer.from([SIDEBAND_DATA]), chunk])))
	}
	return Buffer.concat([...parts, encodePkt({ type: "flush" })])
}

import { AGENT } from "@/protocol/capabilities"
import { GitProtocolError } from "@/protocol/errors"
import { decodePktStream, encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { encodeSideband, SIDEBAND_DATA } from "@/protocol/sideband"

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
	const { packets, rest } = decodePktStream(body)
	// The body is a COMPLETE request: any leftover bytes are an incomplete or
	// length-overrunning packet (decodePktStream leaves a partial packet in `rest`).
	// On a complete body that is a framing fault, not a streaming boundary — reject
	// it loudly rather than silently dropping the truncated args.
	if (rest.length > 0) {
		throw new GitProtocolError(
			`pkt-line: ${rest.length} trailing bytes after the request — incomplete or length-overrunning packet`,
		)
	}
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

/** Fetch features pggit deliberately does NOT advertise (encodeAdvertisement): a
 * client that drives one anyway must FAIL LOUDLY, never be silently dropped to an
 * empty result (the charter). `ref-in-want` (`want-ref`) and the `shallow`/`deepen`
 * family are the unimplemented ones. */
const UNSUPPORTED_FETCH_ARG = /^(want-ref|deepen|shallow)\b/

const OID = /^[0-9a-f]{40}$/

export function parseFetch(req: V2Request): FetchRequest {
	const wants: string[] = []
	const haves: string[] = []
	let done = false
	let filter: string | undefined
	let includeTag = false
	for (const arg of req.args) {
		// Reject an unadvertised feature request loudly before parsing wants — else a
		// `want-ref` line falls through every branch below and silently leaves wants=[]
		// (a no-op empty pack the client misreads as a successful empty clone).
		if (UNSUPPORTED_FETCH_ARG.test(arg)) {
			throw new GitProtocolError(
				`fetch: unsupported feature ${JSON.stringify(arg.split(" ")[0])} — pggit does not advertise it`,
			)
		}
		if (arg.startsWith("want ")) {
			const oid = arg.slice(5)
			// A want OID is coerced to `bytea` downstream via Buffer.from(oid, "hex"),
			// which SILENTLY yields a short/empty buffer for a non-hex value and then
			// fails deep in buildPack. Validate the wire shape at the boundary instead.
			if (!OID.test(oid)) {
				throw new GitProtocolError(
					`fetch: malformed want object id ${JSON.stringify(oid)}`,
				)
			}
			wants.push(oid)
		} else if (arg.startsWith("have ")) haves.push(arg.slice(5))
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
 * A v2 error response: a single `ERR <message>` pkt-line. git's packet reader
 * recognizes the `ERR ` prefix and the client dies with `remote error: <message>`
 * — the in-band channel for a request that cannot be served (e.g. a `want` the repo
 * does not have): an HTTP-200 protocol error the client can read, NOT a transport 500.
 */
export function encodeErr(message: string): Buffer {
	return encodePktLine(Buffer.from(`ERR ${message}\n`))
}

/**
 * fetch response for the clone path (client sent `done`, no haves): the
 * `packfile` section header, the pack multiplexed over sideband band-1, flush.
 */
export function encodePackfileResponse(pack: Buffer): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from("packfile\n")),
		encodeSideband(SIDEBAND_DATA, pack),
		encodePkt({ type: "flush" }),
	])
}

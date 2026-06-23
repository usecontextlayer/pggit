/**
 * pkt-line framing (git wire protocol). A pkt-line is a 4-byte hex length prefix
 * (the length INCLUDES the 4 prefix bytes) followed by `length - 4` payload bytes.
 * Three special zero-payload packets: flush `0000`, delim `0001`, response-end
 * `0002`. See gitprotocol-common + design spec §5.
 */

import { GitProtocolError } from "@/protocol/errors"

export type Pkt =
	| { type: "data"; payload: Buffer }
	| { type: "flush" }
	| { type: "delim" }
	| { type: "response-end" }

const FLUSH_PKT = Buffer.from("0000", "latin1")
const DELIM_PKT = Buffer.from("0001", "latin1")
const RESPONSE_END_PKT = Buffer.from("0002", "latin1")

/** Largest payload we will emit (git's conservative writer cap). */
export const WRITER_MAX_PAYLOAD = 65515
/** Largest payload we will accept on read (git's LARGE_PACKET_DATA_MAX). */
export const READER_MAX_PAYLOAD = 65516

/** Frame a data payload as a pkt-line: `<4-hex len><payload>`. */
export function encodePktLine(payload: Buffer): Buffer {
	if (payload.length > WRITER_MAX_PAYLOAD) {
		throw new Error(
			`pkt-line: payload ${payload.length} exceeds writer cap ${WRITER_MAX_PAYLOAD}`,
		)
	}
	const len = payload.length + 4
	const prefix = len.toString(16).padStart(4, "0")
	return Buffer.concat([Buffer.from(prefix, "latin1"), payload])
}

/** Frame any packet — data or one of the three special zero-payload markers. */
export function encodePkt(pkt: Pkt): Buffer {
	switch (pkt.type) {
		case "data":
			return encodePktLine(pkt.payload)
		case "flush":
			return FLUSH_PKT
		case "delim":
			return DELIM_PKT
		case "response-end":
			return RESPONSE_END_PKT
	}
}

function parseLen(buf: Buffer, offset: number): number {
	const hex = buf.toString("latin1", offset, offset + 4)
	if (!/^[0-9a-f]{4}$/i.test(hex)) {
		// Malformed framing in a client request body — a wire-boundary fault (400),
		// not a server error.
		throw new GitProtocolError(`pkt-line: invalid length prefix ${JSON.stringify(hex)}`)
	}
	return Number.parseInt(hex, 16)
}

/**
 * Decode a buffer into a sequence of packets. Streaming-safe: a trailing
 * partial packet is left in `rest` for the caller to prepend to the next chunk.
 *
 * With `stopAtFlush`, decoding returns at the first flush (which is NOT included
 * in `packets`), leaving the bytes after it in `rest`. The receive-pack request
 * splits here: a pkt-line command list, a flush, then the raw (un-framed) pack.
 *
 * `flushed` reports whether a flush actually terminated the stream in
 * `stopAtFlush` mode — the parser uses it to reject an unterminated command list
 * on a COMPLETE request body (where "more bytes coming" is not an option).
 */
export function decodePktStream(
	buf: Buffer,
	opts: { stopAtFlush?: boolean } = {},
): { packets: Pkt[]; rest: Buffer; flushed: boolean } {
	const packets: Pkt[] = []
	let offset = 0
	while (offset + 4 <= buf.length) {
		const len = parseLen(buf, offset)
		if (len === 0) {
			offset += 4
			if (opts.stopAtFlush) return { flushed: true, packets, rest: buf.subarray(offset) }
			packets.push({ type: "flush" })
			continue
		}
		if (len === 1) {
			packets.push({ type: "delim" })
			offset += 4
			continue
		}
		if (len === 2) {
			packets.push({ type: "response-end" })
			offset += 4
			continue
		}
		if (len === 3) {
			throw new GitProtocolError("pkt-line: reserved length 0003")
		}
		const payloadLen = len - 4
		if (payloadLen > READER_MAX_PAYLOAD) {
			throw new GitProtocolError(
				`pkt-line: declared payload ${payloadLen} exceeds reader bound ${READER_MAX_PAYLOAD}`,
			)
		}
		// Incomplete data packet — leave it (and everything after) in `rest`.
		if (offset + len > buf.length) break
		const payload = buf.subarray(offset + 4, offset + len)
		packets.push({ payload, type: "data" })
		offset += len
	}
	return { flushed: false, packets, rest: buf.subarray(offset) }
}

import { encodePktLine } from "@/protocol/pkt-line"

// One band pkt-line is a band byte + payload, together within the pkt-line writer
// cap (65515) — so a single payload slice is at most 65514 bytes.
const MAX_BAND_DATA = 65514

/**
 * Multiplex `data` onto sideband-64k's data channel: each ≤MAX_BAND_DATA slice
 * becomes a pkt-line of `[0x01 | slice]`. Returns the concatenated pkt-lines with
 * NO trailing flush — the caller owns the section framing (the `packfile\n` header
 * for fetch, the bare report for push) and appends its own flush.
 */
export function encodeSidebandData(data: Buffer): Buffer {
	const parts: Buffer[] = []
	for (let i = 0; i < data.length; i += MAX_BAND_DATA) {
		const chunk = data.subarray(i, i + MAX_BAND_DATA)
		parts.push(encodePktLine(Buffer.concat([Buffer.from([0x01]), chunk])))
	}
	return Buffer.concat(parts)
}

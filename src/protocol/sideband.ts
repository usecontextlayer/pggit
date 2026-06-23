import { encodePktLine } from "@/protocol/pkt-line"

/** The sideband-64k data channel (band 1) — carries pack/report payload. */
export const SIDEBAND_DATA = 0x01

// One band pkt-line is a band byte + payload, together within the pkt-line writer
// cap (65515) — so a single payload slice is at most 65514 bytes.
const MAX_BAND_DATA = 65514

/**
 * Multiplex `data` onto sideband `band`: each ≤MAX_BAND_DATA slice becomes a
 * pkt-line of `[band byte | slice]`. Returns the concatenated band pkt-lines with
 * NO trailing flush — the caller owns the section framing (the `packfile\n` header
 * for fetch, the bare report for push) and appends its own flush.
 */
export function encodeSideband(band: number, data: Buffer): Buffer {
	const parts: Buffer[] = []
	for (let i = 0; i < data.length; i += MAX_BAND_DATA) {
		const chunk = data.subarray(i, i + MAX_BAND_DATA)
		parts.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])))
	}
	return Buffer.concat(parts)
}

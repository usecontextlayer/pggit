/**
 * The in-process pkt-line oracle primitives (spec §4.3). Each decodes a wire
 * byte stream into a form a golden can assert against, mirroring git's own
 * `test-tool pkt-line` helpers so our goldens read in git's grammar:
 *   - `pktLineUnpack`   ← `t/helper/test-pkt-line.c` `unpack` (text/control)
 *   - `framedPktLines`  ← the length-prefixed form `t5411` asserts directly
 *   - `sidebandDemux`   ← `unpack-sideband` (binary-safe, per-band)
 *   - `renderRefAdvertV0` ← NUL-aware v0 push-advert decode
 *
 * All four are pure and build on the existing `decodePktStream`, so they share
 * one battle-tested framing reader. They are the measuring instrument for the
 * §8.1 goldens, so their own tests (`pkt-oracle.test.ts`) are a normal `*.test.ts`
 * and stay GREEN on the gate — never a `*.spec.test.ts`.
 */
import { decodePktStream } from "@/pkt-line"

/** test_oid values, verbatim from `/tmp/git-src/t/oid-info/hash-info` (sha1 rows). */
export const ZERO_OID = "0".repeat(40)
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
export const ALGO = "sha1"
export const HEXSZ = 40

/** The text `pktLineUnpack` renders a flush packet as (handy for building goldens). */
export const FLUSH_LINE = "0000\n"

/**
 * Mirror of git's `test-tool pkt-line unpack` (`t/helper/test-pkt-line.c:42-67`).
 * Renders one text line per packet: a data payload has a SINGLE trailing `\n`
 * chomped then one re-added (`PACKET_READ_CHOMP_NEWLINE`), so a payload with and
 * without a trailing newline render identically; an empty (`0004`) packet renders
 * as a blank line; flush/delim/response-end render as `0000`/`0001`/`0002` lines.
 * For NUL-free text/control streams only (not binary-safe, exactly like git's tool).
 */
export function pktLineUnpack(buf: Buffer): string {
	let out = ""
	for (const p of decodePktStream(buf).packets) {
		switch (p.type) {
			case "data":
				out += `${p.payload.toString("utf8").replace(/\n$/, "")}\n`
				break
			case "flush":
				out += "0000\n"
				break
			case "delim":
				out += "0001\n"
				break
			case "response-end":
				out += "0002\n"
				break
		}
	}
	return out
}

/**
 * Renders each data packet as `<4-hex-length><payload>` (length includes the 4
 * prefix bytes), payload verbatim with NO chomp — the form `t5411` asserts
 * directly (e.g. `000eunpack ok`). Flush/delim/response-end render as their bare
 * four hex digits (`0000`/`0001`/`0002`), faithful to the raw wire (the flush is
 * literally 4 bytes with no trailing newline; data payloads carry their own).
 * The prefix is recomputed from the decoded payload length, so this is a
 * content-level renderer, not a framing check — byte-exact framing is §8.3's job.
 */
export function framedPktLines(buf: Buffer): string {
	let out = ""
	for (const p of decodePktStream(buf).packets) {
		switch (p.type) {
			case "data": {
				const len = p.payload.length + 4
				out += len.toString(16).padStart(4, "0") + p.payload.toString("latin1")
				break
			}
			case "flush":
				out += "0000"
				break
			case "delim":
				out += "0001"
				break
			case "response-end":
				out += "0002"
				break
		}
	}
	return out
}

/** Render a single text line as its framed pkt-line `<4hex><text>\n` (for goldens). */
export function framedLine(text: string): string {
	const payload = `${text}\n`
	const len = Buffer.byteLength(payload, "utf8") + 4
	return len.toString(16).padStart(4, "0") + payload
}

/**
 * Mirror of git's `test-tool pkt-line unpack-sideband`
 * (`t/helper/test-pkt-line.c:69-130`). Strips the leading band byte from each
 * data packet and concatenates the RAW remaining bytes per band (no added
 * newline — binary-safe). Band 1 = primary (pack / sideband-wrapped report),
 * band 2 = progress, band 3 = error; non-sideband packets (band byte not 1-3,
 * e.g. a plain `packfile\n` line) are skipped. A flush ends parsing.
 */
export function sidebandDemux(buf: Buffer): {
	band1: Buffer
	band2: Buffer
	band3: Buffer
} {
	const band1: Buffer[] = []
	const band2: Buffer[] = []
	const band3: Buffer[] = []
	for (const p of decodePktStream(buf).packets) {
		if (p.type === "flush") break
		if (p.type !== "data" || p.payload.length === 0) continue
		const rest = p.payload.subarray(1)
		switch (p.payload[0]) {
			case 1:
				band1.push(rest)
				break
			case 2:
				band2.push(rest)
				break
			case 3:
				band3.push(rest)
				break
		}
	}
	return {
		band1: Buffer.concat(band1),
		band2: Buffer.concat(band2),
		band3: Buffer.concat(band3),
	}
}

export type RefAdvertV0 = {
	refs: { oid: string; name: string; caps?: string[] }[]
	endsWithFlush: boolean
}

/**
 * NUL-aware decode of the v0 receive-pack (push) advertisement (spec §4.2.7).
 * The first ref line carries `<oid> <ref>\0<space-joined-caps>`; an empty repo
 * emits the synthetic `0{40} capabilities^{}\0<caps>` line. Returns a STRUCTURED
 * object — `{ oid, name, caps? }` per ref (caps in emitted order, present only on
 * the line that carried them) plus `endsWithFlush` — so goldens can assert
 * `.refs[0]` / `.toEqual` and compare cap order exactly, rather than string-
 * matching a `%s`-style render that would truncate the caps at the NUL.
 */
export function renderRefAdvertV0(buf: Buffer): RefAdvertV0 {
	const { packets } = decodePktStream(buf)
	const refs: RefAdvertV0["refs"] = []
	for (const p of packets) {
		if (p.type !== "data") continue
		const text = p.payload.toString("latin1").replace(/\n$/, "")
		const nul = text.indexOf("\0")
		const refPart = nul >= 0 ? text.slice(0, nul) : text
		const sp = refPart.indexOf(" ")
		const ref: RefAdvertV0["refs"][number] = {
			name: refPart.slice(sp + 1),
			oid: refPart.slice(0, sp),
		}
		if (nul >= 0)
			ref.caps = text
				.slice(nul + 1)
				.split(" ")
				.filter(Boolean)
		refs.push(ref)
	}
	return { endsWithFlush: packets.at(-1)?.type === "flush", refs }
}

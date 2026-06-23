import { encodePkt, encodePktLine } from "@/protocol/pkt-line"

/**
 * Build a well-formed v2 upload-pack `fetch` request body. Each field maps 1:1 to
 * one named wire line, emitted in fixed protocol order:
 *
 *   command=fetch → [object-format] → delim → wants → want-refs → haves
 *     → [include-tag] → [done] → flush
 *
 * A field left undefined/false emits nothing, so the same builder reproduces every
 * fetch shape the tests need byte-for-byte. NOT for malformed frames — those build
 * literal buffers on purpose.
 */
export function fetchRequest(parts: {
	objectFormat?: "sha1" | "sha256"
	wants?: string[]
	wantRefs?: string[]
	haves?: string[]
	includeTag?: boolean
	done?: boolean
}): Buffer {
	const {
		objectFormat,
		wants = [],
		wantRefs = [],
		haves = [],
		includeTag = false,
		done = false,
	} = parts
	return Buffer.concat([
		encodePktLine(Buffer.from("command=fetch\n")),
		...(objectFormat
			? [encodePktLine(Buffer.from(`object-format=${objectFormat}\n`))]
			: []),
		encodePkt({ type: "delim" }),
		...wants.map((w) => encodePktLine(Buffer.from(`want ${w}\n`))),
		...wantRefs.map((r) => encodePktLine(Buffer.from(`want-ref ${r}\n`))),
		...haves.map((h) => encodePktLine(Buffer.from(`have ${h}\n`))),
		...(includeTag ? [encodePktLine(Buffer.from("include-tag\n"))] : []),
		...(done ? [encodePktLine(Buffer.from("done\n"))] : []),
		encodePkt({ type: "flush" }),
	])
}

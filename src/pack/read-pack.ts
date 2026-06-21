import { createHash } from "node:crypto"
import { createInflate } from "node:zlib"
import { computeOid, type GitObjectType } from "@/object"
import { applyDelta } from "@/pack/delta"
import { decodeObjectHeader, PACK_OBJ_TYPE } from "@/pack/object-header"

export type ParsedObject = {
	type: GitObjectType
	content: Buffer
	oid: string
}

const CODE_TO_TYPE: Record<number, GitObjectType> = {
	[PACK_OBJ_TYPE.COMMIT]: "commit",
	[PACK_OBJ_TYPE.TREE]: "tree",
	[PACK_OBJ_TYPE.BLOB]: "blob",
	[PACK_OBJ_TYPE.TAG]: "tag",
}

type RawEntry =
	| { kind: "base"; type: GitObjectType; content: Buffer }
	| { kind: "ofs"; baseOffset: number; delta: Buffer }
	| { kind: "ref"; baseOid: string; delta: Buffer }

type Resolved = { type: GitObjectType; content: Buffer }

/**
 * Inflate exactly one zlib stream at the front of `buf`, returning the data and
 * how many COMPRESSED bytes it consumed — the seam for walking the back-to-back
 * zlib streams in a packfile. (`bytesWritten` = input consumed up to
 * Z_STREAM_END; trailing bytes untouched — verified empirically against
 * node:zlib.)
 */
function inflateOne(buf: Buffer): Promise<{ data: Buffer; compressedLength: number }> {
	return new Promise((resolve, reject) => {
		const inf = createInflate()
		const chunks: Buffer[] = []
		inf.on("data", (chunk: Buffer) => chunks.push(chunk))
		inf.on("end", () =>
			resolve({ compressedLength: inf.bytesWritten, data: Buffer.concat(chunks) }),
		)
		inf.on("error", reject)
		inf.end(buf)
	})
}

/**
 * The pack OFS_DELTA "offset encoding" — NOT plain LEB128. Each continuation
 * adds 1 before shifting, so encodings are unambiguous. Arithmetic (not `<<`) so
 * offsets ≥ 2³¹ stay correct.
 */
function readOffsetVarint(
	buf: Buffer,
	offset: number,
): { value: number; bytesRead: number } {
	let b = buf.readUInt8(offset)
	let bytesRead = 1
	let value = b & 0x7f
	while (b & 0x80) {
		b = buf.readUInt8(offset + bytesRead)
		bytesRead += 1
		value = (value + 1) * 128 + (b & 0x7f)
	}
	return { bytesRead, value }
}

/**
 * Parse a v2 packfile into its objects, resolving OFS_DELTA and REF_DELTA
 * (including delta chains) against bases present in the same pack. A REF_DELTA
 * whose base is NOT in the pack (a thin pack — push ingest) is rejected here;
 * external-base resolution against the Postgres store lands with M2.
 */
export async function readPack(pack: Buffer): Promise<ParsedObject[]> {
	if (pack.subarray(0, 4).toString("latin1") !== "PACK") {
		throw new Error("pack: bad magic")
	}
	const version = pack.readUInt32BE(4)
	if (version !== 2) throw new Error(`pack: unsupported version ${version}`)
	const count = pack.readUInt32BE(8)

	const trailerOffset = pack.length - 20
	const actualTrailer = createHash("sha1")
		.update(pack.subarray(0, trailerOffset))
		.digest()
	if (!pack.subarray(trailerOffset).equals(actualTrailer)) {
		throw new Error("pack: trailer SHA-1 mismatch")
	}

	// Pass 1 — parse every entry's raw form, keyed by its start offset.
	const entries = new Map<number, RawEntry>()
	const order: number[] = []
	let offset = 12
	for (let i = 0; i < count; i++) {
		const start = offset
		const { type, size, bytesRead } = decodeObjectHeader(pack, offset)
		offset += bytesRead

		if (type === PACK_OBJ_TYPE.OFS_DELTA) {
			const { value: negOffset, bytesRead: ob } = readOffsetVarint(pack, offset)
			offset += ob
			const { data, compressedLength } = await inflateOne(pack.subarray(offset))
			offset += compressedLength
			entries.set(start, { baseOffset: start - negOffset, delta: data, kind: "ofs" })
		} else if (type === PACK_OBJ_TYPE.REF_DELTA) {
			const baseOid = pack.subarray(offset, offset + 20).toString("hex")
			offset += 20
			const { data, compressedLength } = await inflateOne(pack.subarray(offset))
			offset += compressedLength
			entries.set(start, { baseOid, delta: data, kind: "ref" })
		} else {
			const typeName = CODE_TO_TYPE[type]
			if (!typeName) throw new Error(`pack: unknown object type ${type}`)
			const { data, compressedLength } = await inflateOne(pack.subarray(offset))
			if (data.length !== size) {
				throw new Error(`pack: size mismatch (header ${size}, inflated ${data.length})`)
			}
			offset += compressedLength
			entries.set(start, { content: data, kind: "base", type: typeName })
		}
		order.push(start)
	}
	if (offset !== trailerOffset) {
		throw new Error(
			`pack: consumed ${offset} bytes, expected ${trailerOffset} before trailer`,
		)
	}

	// Pass 2 — resolve deltas against in-pack bases (memoized, cycle-guarded).
	const byOffset = new Map<number, ParsedObject>()
	const byOid = new Map<string, Resolved>()
	const inProgress = new Set<number>()

	function resolveOffset(off: number): ParsedObject {
		const memo = byOffset.get(off)
		if (memo) return memo
		if (inProgress.has(off)) throw new Error("pack: cyclic delta chain")
		inProgress.add(off)

		const entry = entries.get(off)
		if (!entry) throw new Error(`pack: no entry at offset ${off}`)

		let resolved: Resolved
		if (entry.kind === "base") {
			resolved = { content: entry.content, type: entry.type }
		} else if (entry.kind === "ofs") {
			const base = resolveOffset(entry.baseOffset)
			resolved = { content: applyDelta(base.content, entry.delta), type: base.type }
		} else {
			const base = resolveOid(entry.baseOid)
			resolved = { content: applyDelta(base.content, entry.delta), type: base.type }
		}

		const result: ParsedObject = {
			content: resolved.content,
			oid: computeOid(resolved.type, resolved.content),
			type: resolved.type,
		}
		byOffset.set(off, result)
		byOid.set(result.oid, resolved)
		inProgress.delete(off)
		return result
	}

	function resolveOid(oid: string): Resolved {
		const memo = byOid.get(oid)
		if (memo) return memo
		for (const off of order) {
			if (resolveOffset(off).oid === oid) {
				const found = byOid.get(oid)
				if (found) return found
			}
		}
		throw new Error(
			`pack: ref-delta base ${oid} not in pack (thin pack not yet supported)`,
		)
	}

	return order.map((off) => resolveOffset(off))
}

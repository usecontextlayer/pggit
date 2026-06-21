/**
 * Pack object header: a variable-length encoding of (type, uncompressed size)
 * that prefixes every object entry in a packfile.
 *
 * First byte: `[c|ttt|ssss]` — continuation bit `c`, 3-bit type `ttt`, low 4 bits
 * of size. Each continuation byte contributes 7 more size bits, least-significant
 * group first. See gitformat-pack.
 *
 * Size arithmetic uses `*`/`Math.floor`, NOT `<<`/`>>` — JS bitwise ops are
 * 32-bit and would corrupt object sizes ≥ 2³¹.
 */

export const PACK_OBJ_TYPE = {
	BLOB: 3,
	COMMIT: 1,
	OFS_DELTA: 6,
	REF_DELTA: 7,
	TAG: 4,
	TREE: 2,
} as const

export type PackObjType = (typeof PACK_OBJ_TYPE)[keyof typeof PACK_OBJ_TYPE]

export type DecodedObjectHeader = {
	type: number
	size: number
	bytesRead: number
}

export function encodeObjectHeader(type: number, size: number): Buffer {
	let rest = Math.floor(size / 16)
	let first = (type << 4) | (size % 16)
	if (rest > 0) first |= 0x80
	const bytes = [first]
	while (rest > 0) {
		let byte = rest % 128
		rest = Math.floor(rest / 128)
		if (rest > 0) byte |= 0x80
		bytes.push(byte)
	}
	return Buffer.from(bytes)
}

export function decodeObjectHeader(buf: Buffer, offset: number): DecodedObjectHeader {
	let b = buf.readUInt8(offset)
	let bytesRead = 1
	const type = (b >> 4) & 0x07
	let size = b & 0x0f
	let mult = 16
	while (b & 0x80) {
		b = buf.readUInt8(offset + bytesRead)
		bytesRead++
		size += (b & 0x7f) * mult
		mult *= 128
	}
	return { bytesRead, size, type }
}

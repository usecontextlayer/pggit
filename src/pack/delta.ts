import { GitFormatError } from "@/git-format-error"

/**
 * Apply a git delta to its base, producing the target object. The delta begins
 * with two LEB128 varints (source size, target size), then a stream of
 * instructions: a COPY (high bit set — copy a run from the base at a given
 * offset/size) or an INSERT (1..127 literal bytes that follow). See
 * gitformat-pack "Deltified representation". We only ever READ/apply deltas;
 * the serve path emits none (spec §3.4).
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
	let pos = 0

	const readVarint = (): number => {
		let result = 0
		let shift = 0
		let byte: number
		do {
			byte = delta.readUInt8(pos)
			pos += 1
			result += (byte & 0x7f) * 2 ** shift
			shift += 7
		} while (byte & 0x80)
		return result
	}

	const sourceSize = readVarint()
	const targetSize = readVarint()
	if (base.length !== sourceSize) {
		throw new GitFormatError(
			"delta-base-size-mismatch",
			`delta: base size ${base.length} ≠ declared ${sourceSize}`,
		)
	}

	const out = Buffer.alloc(targetSize)
	let outPos = 0
	while (pos < delta.length) {
		const op = delta.readUInt8(pos)
		pos += 1

		if (op & 0x80) {
			// COPY: present bits select which little-endian offset/size bytes follow.
			let copyOffset = 0
			if (op & 0x01) copyOffset |= delta.readUInt8(pos++)
			if (op & 0x02) copyOffset |= delta.readUInt8(pos++) << 8
			if (op & 0x04) copyOffset |= delta.readUInt8(pos++) << 16
			if (op & 0x08) copyOffset += delta.readUInt8(pos++) * 2 ** 24
			let copySize = 0
			if (op & 0x10) copySize |= delta.readUInt8(pos++)
			if (op & 0x20) copySize |= delta.readUInt8(pos++) << 8
			if (op & 0x40) copySize |= delta.readUInt8(pos++) << 16
			if (copySize === 0) copySize = 0x10000
			base.copy(out, outPos, copyOffset, copyOffset + copySize)
			outPos += copySize
		} else if (op !== 0) {
			// INSERT: `op` literal bytes follow.
			delta.copy(out, outPos, pos, pos + op)
			outPos += op
			pos += op
		} else {
			throw new GitFormatError("delta-reserved-opcode", "delta: reserved opcode 0x00")
		}
	}

	if (outPos !== targetSize) {
		throw new GitFormatError(
			"delta-target-size-mismatch",
			`delta: produced ${outPos} bytes, declared ${targetSize}`,
		)
	}
	return out
}

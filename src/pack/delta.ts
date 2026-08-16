import { GitFormatError } from "@/object/format-error"

// The delta codec, both directions (gitformat-pack "Deltified representation"):
// `applyDelta` reads — push ingest resolves every arriving delta through it — and
// `encodeDelta` writes, for the derived pack-encoding tier. Spec §3.4's read-only
// asymmetry ("the serve path emits none") is retired by the delta-pack design
// (docs/2026-08-15-delta-pack-design.md).

/**
 * Encode `target` as a git delta against `base` — the inverse of {@link applyDelta},
 * and the half of the delta codec the serve path has never had.
 *
 * The contract, in full, because the executable spec is written against it:
 *
 * - **Correct.** `applyDelta(base, encodeDelta(base, target))` equals `target`, for
 *   every pair of inputs including the degenerate ones (either side empty).
 * - **Total.** It always returns a delta and never throws — even when the delta ends
 *   up LARGER than `target`. Whether a delta is worth keeping is the caller's call,
 *   not the encoder's: repack keeps one only when it beats the whole object, exactly
 *   as git does. Folding that judgement in here would fuse two concepts into one
 *   function and leave the caller unable to ask "how big would it be?".
 * - **Deterministic.** The same `(base, target)` yields the same bytes, so a repack
 *   pass is idempotent and a failing property shrinks to a reproducible case.
 * - **No size ceiling parameter.** git's `create_delta` takes a `max_delta_size` and
 *   bails early; measured on the real workload (9,292 trees of CodeCreators' komal
 *   repo) the whole encode pass is ~1.2s, so the early bail buys nothing worth the
 *   extra state. Add it as an optional argument if a corpus ever says otherwise.
 *
 * One correctness trap the spec pins deliberately: a COPY instruction whose size
 * field encodes zero is read back by {@link applyDelta} as 0x10000, so a zero-length
 * COPY must never be emitted. This encoder sidesteps the trap structurally — a
 * match shorter than {@link MATCH_BLOCK} is emitted as literal, and a long run is
 * split at 0xFFFF, so a size field is never zero and the 0x10000 special encoding
 * is never produced (both forms are legal to READ; only one is ever written).
 *
 * Mechanism (git's `create_delta` in miniature): index every MATCH_BLOCK-aligned
 * block of `base` by content, then scan `target` — at each position, the longest
 * forward extension over the candidate offsets wins and becomes a COPY; bytes with
 * no block-length match accumulate into INSERTs (chunked at the 127-byte opcode
 * cap). Candidate lists are capped at {@link CHAIN_LIMIT} offsets (git's own
 * hash-chain cap) so degenerate content — a 64 KB run of one byte indexes to a
 * single key — stays O(n·CHAIN) instead of O(n²), and the cap keeps the FIRST
 * (lowest) offsets, so the choice stays deterministic.
 */
export function encodeDelta(base: Buffer, target: Buffer): Buffer {
	// Index base: block content → ascending offsets (capped, first-kept).
	const index = new Map<string, number[]>()
	for (let i = 0; i + MATCH_BLOCK <= base.length; i += MATCH_BLOCK) {
		const key = base.subarray(i, i + MATCH_BLOCK).toString("latin1")
		const slot = index.get(key)
		if (slot === undefined) index.set(key, [i])
		else if (slot.length < CHAIN_LIMIT) slot.push(i)
	}

	const ops: number[] = []
	pushSizeVarint(ops, base.length)
	pushSizeVarint(ops, target.length)

	let literal: number[] = []
	const flushLiteral = (): void => {
		for (let i = 0; i < literal.length; i += 127) {
			const chunk = literal.slice(i, i + 127)
			ops.push(chunk.length, ...chunk)
		}
		literal = []
	}

	let pos = 0
	while (pos < target.length) {
		// Longest forward extension over the candidates at this position.
		let bestOff = -1
		let bestLen = 0
		if (pos + MATCH_BLOCK <= target.length) {
			const key = target.subarray(pos, pos + MATCH_BLOCK).toString("latin1")
			for (const cand of index.get(key) ?? []) {
				let len = 0
				const maxLen = Math.min(target.length - pos, base.length - cand)
				while (len < maxLen && target[pos + len] === base[cand + len]) len++
				if (len > bestLen) {
					bestLen = len
					bestOff = cand
					if (pos + len === target.length) break // cannot be beaten
				}
			}
		}
		if (bestLen >= MATCH_BLOCK && bestOff >= 0) {
			flushLiteral()
			pushCopies(ops, bestOff, bestLen)
			pos += bestLen
		} else {
			literal.push(target[pos] as number)
			pos++
		}
	}
	flushLiteral()
	return Buffer.from(ops)
}

/** Minimum match worth a COPY: shorter than a COPY's own opcode footprint plus the
 * lost literal-run continuity, and the block size the base index is keyed on. */
const MATCH_BLOCK = 16

/** Max candidate offsets kept per block key — git's hash-chain cap. Keeps
 * degenerate (highly repetitive) content linear; first-kept, so deterministic. */
const CHAIN_LIMIT = 64

/** The delta header's LEB128 size varint (LSB group first). */
function pushSizeVarint(out: number[], value: number): void {
	let v = value
	do {
		let b = v & 0x7f
		v = Math.floor(v / 128)
		if (v > 0) b |= 0x80
		out.push(b)
	} while (v > 0)
}

/**
 * COPY instructions for a run, split at 0xFFFF per instruction with the offset
 * advanced per split (the classic wrong-content bug is advancing the length but
 * not the offset). Present-bit encoding: only non-zero offset/size bytes are
 * emitted, each flagged in the opcode.
 */
function pushCopies(out: number[], offset: number, length: number): void {
	let off = offset
	let remaining = length
	while (remaining > 0) {
		const size = Math.min(remaining, 0xffff)
		let opcode = 0x80
		const tail: number[] = []
		for (let s = 0; s < 4; s++) {
			const byte = Math.floor(off / 2 ** (8 * s)) & 0xff
			if (byte !== 0) {
				opcode |= 1 << s
				tail.push(byte)
			}
		}
		for (let s = 0; s < 3; s++) {
			const byte = (size >>> (8 * s)) & 0xff
			if (byte !== 0) {
				opcode |= 0x10 << s
				tail.push(byte)
			}
		}
		out.push(opcode, ...tail)
		off += size
		remaining -= size
	}
}

/**
 * Apply a git delta to its base, producing the target object. The delta begins
 * with two LEB128 varints (source size, target size), then a stream of
 * instructions: a COPY (high bit set — copy a run from the base at a given
 * offset/size) or an INSERT (1..127 literal bytes that follow).
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

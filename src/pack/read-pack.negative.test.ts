/**
 * Adversarial malformed-pack parse paths. `readPack` runs on attacker-controlled
 * push bytes, so every validation throw is a security boundary: a swallowed,
 * mis-framed, or HUNG parse on corrupt input is a DoS/corruption vector. Each
 * case asserts the SPECIFIC rejection by its stable `GitFormatError.code` (not the
 * message prose, which is free to be reworded) — so the test pins "rejected for
 * THIS reason" without coupling to the wording. The truncated-zlib case proves a
 * corrupt stream throws rather than hangs (the test would time out if it hung).
 */
import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { encodeObjectHeader, PACK_OBJ_TYPE } from "@/pack/object-header"
import { readPack } from "@/pack/read-pack"

/** Build a v2 pack from raw (type-code, body-bytes) entries + a correct trailer. */
function packOf(entries: { type: number; deflated: Buffer; size: number }[]): Buffer {
	const header = Buffer.alloc(12)
	header.write("PACK", 0, "latin1")
	header.writeUInt32BE(2, 4)
	header.writeUInt32BE(entries.length, 8)
	const parts: Buffer[] = [header]
	for (const e of entries) {
		parts.push(encodeObjectHeader(e.type, e.size), e.deflated)
	}
	const body = Buffer.concat(parts)
	return Buffer.concat([body, createHash("sha1").update(body).digest()])
}

/** A well-formed base object entry (type code + deflated content). */
function base(type: number, content: Buffer) {
	return { deflated: deflateSync(content), size: content.length, type }
}

/** Recompute the trailer over a mutated body so a later check (not the trailer) fires. */
function reseal(pack: Buffer): Buffer {
	const body = pack.subarray(0, pack.length - 20)
	return Buffer.concat([body, createHash("sha1").update(body).digest()])
}

const validBlobPack = packOf([base(PACK_OBJ_TYPE.BLOB, Buffer.from("hello\n"))])

describe("readPack — malformed input fails loud", () => {
	it("round-trips the valid control pack (guards against a vacuous suite)", async () => {
		const parsed = await readPack(validBlobPack)
		expect(parsed.map((p) => p.type)).toEqual(["blob"])
	})

	it("throws on bad magic", async () => {
		const p = Buffer.from(validBlobPack)
		p.write("XACK", 0, "latin1")
		await expect(readPack(p)).rejects.toMatchObject({ code: "bad-magic" })
	})

	it("throws on an unsupported version", async () => {
		const p = Buffer.from(validBlobPack)
		p.writeUInt32BE(3, 4)
		await expect(readPack(p)).rejects.toMatchObject({ code: "unsupported-version" })
	})

	it("throws on a flipped trailer byte (SHA-1 mismatch)", async () => {
		const p = Buffer.from(validBlobPack)
		const last = p.length - 1
		p.writeUInt8(p.readUInt8(last) ^ 0xff, last)
		await expect(readPack(p)).rejects.toMatchObject({ code: "trailer-mismatch" })
	})

	it("throws when the object count is smaller than the body (leftover bytes)", async () => {
		const twoObjects = packOf([
			base(PACK_OBJ_TYPE.BLOB, Buffer.from("aaa")),
			base(PACK_OBJ_TYPE.BLOB, Buffer.from("bbb")),
		])
		const p = Buffer.from(twoObjects)
		p.writeUInt32BE(1, 8) // claim 1 object; a second object's bytes remain
		await expect(readPack(reseal(p))).rejects.toMatchObject({ code: "trailing-bytes" })
	})

	it("throws when the object count is larger than the body", async () => {
		const p = Buffer.from(validBlobPack)
		p.writeUInt32BE(2, 8) // claim 2 objects; only 1 present
		// The phantom 2nd object decodes the 20-byte trailer as a bogus header, then
		// inflates into the buffer end — a deterministic zlib underrun (wrapped as a
		// typed inflate failure), not a hang.
		await expect(readPack(reseal(p))).rejects.toMatchObject({ code: "inflate-failed" })
	})

	it("throws on an unknown object type code", async () => {
		const p = packOf([{ deflated: deflateSync(Buffer.from("x")), size: 1, type: 5 }])
		await expect(readPack(p)).rejects.toMatchObject({ code: "unknown-object-type" })
	})

	it("throws (does not hang) on a truncated final zlib stream", async () => {
		const content = Buffer.from("a moderately long blob body to deflate\n".repeat(8))
		const full = deflateSync(content)
		const header = Buffer.alloc(12)
		header.write("PACK", 0, "latin1")
		header.writeUInt32BE(2, 4)
		header.writeUInt32BE(1, 8)
		const body = Buffer.concat([
			header,
			encodeObjectHeader(PACK_OBJ_TYPE.BLOB, content.length),
			full.subarray(0, Math.floor(full.length / 2)), // cut the zlib stream in half
		])
		const pack = Buffer.concat([body, createHash("sha1").update(body).digest()])
		await expect(readPack(pack)).rejects.toMatchObject({ code: "inflate-failed" })
	})
})

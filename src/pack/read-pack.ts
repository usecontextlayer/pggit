import { createHash } from "node:crypto"
import { createInflate } from "node:zlib"
import { computeOid, type GitObjectType } from "@/object"
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

/**
 * Inflate exactly one zlib stream starting at the front of `buf`, returning the
 * decompressed data and how many COMPRESSED bytes it consumed — the seam for
 * walking the back-to-back zlib streams in a packfile. (`bytesWritten` reflects
 * input consumed up to Z_STREAM_END; trailing bytes are left untouched —
 * verified empirically against node:zlib.)
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

/** Parse a v2 packfile into its objects. Currently base types only (no deltas). */
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

	const objects: ParsedObject[] = []
	let offset = 12
	for (let i = 0; i < count; i++) {
		const { type, size, bytesRead } = decodeObjectHeader(pack, offset)
		offset += bytesRead

		const typeName = CODE_TO_TYPE[type]
		if (!typeName) {
			throw new Error(`pack: object type ${type} (deltas) not yet supported`)
		}

		const { data, compressedLength } = await inflateOne(pack.subarray(offset))
		if (data.length !== size) {
			throw new Error(`pack: size mismatch (header ${size}, inflated ${data.length})`)
		}
		offset += compressedLength
		objects.push({ content: data, oid: computeOid(typeName, data), type: typeName })
	}

	if (offset !== trailerOffset) {
		throw new Error(
			`pack: consumed ${offset} bytes, expected ${trailerOffset} before trailer`,
		)
	}
	return objects
}

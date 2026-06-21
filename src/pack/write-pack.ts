import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { count } from "@/instrument"
import type { GitObjectType } from "@/object"
import { encodeObjectHeader, PACK_OBJ_TYPE, type PackObjType } from "@/pack/object-header"

export type PackInputObject = {
	type: GitObjectType
	content: Buffer
}

const TYPE_CODE: Record<GitObjectType, PackObjType> = {
	blob: PACK_OBJ_TYPE.BLOB,
	commit: PACK_OBJ_TYPE.COMMIT,
	tag: PACK_OBJ_TYPE.TAG,
	tree: PACK_OBJ_TYPE.TREE,
}

/**
 * Serialize objects into a self-contained, **undeltified** packfile (v2):
 * `PACK` magic + version 2 + object count, then for each object a varint
 * (type, uncompressed size) header followed by its zlib-deflated content, then a
 * trailing SHA-1 of all preceding bytes. This is the serve hot path — we never
 * emit deltas (spec §3.4 asymmetric kernel).
 */
export function writePack(objects: PackInputObject[]): Buffer {
	const header = Buffer.alloc(12)
	header.write("PACK", 0, "latin1")
	header.writeUInt32BE(2, 4)
	header.writeUInt32BE(objects.length, 8)

	count("writePackCalls")
	const parts: Buffer[] = [header]
	for (const obj of objects) {
		parts.push(encodeObjectHeader(TYPE_CODE[obj.type], obj.content.length))
		const deflated = deflateSync(obj.content)
		count("deflateInputBytes", obj.content.length)
		count("deflateOutputBytes", deflated.length)
		parts.push(deflated)
	}

	const body = Buffer.concat(parts)
	const trailer = createHash("sha1").update(body).digest()
	return Buffer.concat([body, trailer])
}

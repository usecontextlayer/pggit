import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { count } from "@/instrument"
import type { GitObjectType } from "@/object/object"
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
 * The 12-byte pack header: `PACK` magic, version 2, object count. The count is
 * fixed up front, so a streaming encoder must know its object total before the
 * first object (the row-store's closure provides it without reading content).
 */
export function packHeader(objectCount: number): Buffer {
	const header = Buffer.alloc(12)
	header.write("PACK", 0, "latin1")
	header.writeUInt32BE(2, 4)
	header.writeUInt32BE(objectCount, 8)
	return header
}

/** One packed object: its varint (type, uncompressed size) header + zlib-deflated
 * content. Undeltified — we never emit deltas (spec §3.4 asymmetric kernel). */
export function packObject(type: GitObjectType, content: Buffer): Buffer {
	const deflated = deflateSync(content)
	count("deflateInputBytes", content.length)
	count("deflateOutputBytes", deflated.length)
	return Buffer.concat([encodeObjectHeader(TYPE_CODE[type], content.length), deflated])
}

/**
 * Serialize objects into a self-contained, **undeltified** packfile (v2): the
 * header, each object's (header + deflated content), then a trailing SHA-1 of all
 * preceding bytes. The serve path streams the same primitives object-by-object
 * (object-store `buildPack`); this all-at-once form builds test packs and the
 * empty pack.
 */
export function writePack(objects: PackInputObject[]): Buffer {
	count("writePackCalls")
	const parts: Buffer[] = [packHeader(objects.length)]
	for (const obj of objects) parts.push(packObject(obj.type, obj.content))

	const body = Buffer.concat(parts)
	const trailer = createHash("sha1").update(body).digest()
	return Buffer.concat([body, trailer])
}

import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import type { GitObjectType } from "@/object/object"
import { encodeObjectHeader, PACK_OBJ_TYPE } from "@/pack/object-header"

const PACK_TYPE_CODE: Record<GitObjectType, number> = {
	blob: PACK_OBJ_TYPE.BLOB,
	commit: PACK_OBJ_TYPE.COMMIT,
	tag: PACK_OBJ_TYPE.TAG,
	tree: PACK_OBJ_TYPE.TREE,
}

export type RefDeltaPackEntry =
	| { content: Buffer; kind: "base"; type: GitObjectType }
	| { baseOid: string; delta: Buffer; kind: "ref" }

/** Build a v2 pack carrying whole objects and test-authored REF_DELTA entries. */
export function buildRefDeltaPack(entries: RefDeltaPackEntry[]): Buffer {
	const header = Buffer.alloc(12)
	header.write("PACK", 0, "latin1")
	header.writeUInt32BE(2, 4)
	header.writeUInt32BE(entries.length, 8)
	const parts: Buffer[] = [header]
	for (const entry of entries) {
		if (entry.kind === "base") {
			parts.push(encodeObjectHeader(PACK_TYPE_CODE[entry.type], entry.content.length))
			parts.push(deflateSync(entry.content))
		} else {
			parts.push(encodeObjectHeader(PACK_OBJ_TYPE.REF_DELTA, entry.delta.length))
			parts.push(Buffer.from(entry.baseOid, "hex"))
			parts.push(deflateSync(entry.delta))
		}
	}
	const body = Buffer.concat(parts)
	return Buffer.concat([body, createHash("sha1").update(body).digest()])
}

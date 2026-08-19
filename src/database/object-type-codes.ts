import type { GitObjectType } from "@/object/object"
import { PACK_OBJ_TYPE } from "@/pack/object-header"

/**
 * The stored object-type code: `git_object.type` and `git_tag.target_type` hold
 * the pack object-type code (1 commit, 2 tree, 3 blob, 4 tag), so a stored type
 * maps straight to the pack header on serve. This is the one name↔code mapping
 * for STORED types — the pack codec keeps its own private map (write-pack.ts)
 * and stays storage-independent.
 */
export const OBJECT_TYPE_CODE: Record<GitObjectType, number> = {
	blob: PACK_OBJ_TYPE.BLOB,
	commit: PACK_OBJ_TYPE.COMMIT,
	tag: PACK_OBJ_TYPE.TAG,
	tree: PACK_OBJ_TYPE.TREE,
}

const CODE_TO_TYPE = new Map<number, GitObjectType>(
	Object.entries(OBJECT_TYPE_CODE).map(([name, code]) => [code, name as GitObjectType]),
)

/** The domain type name for a stored code; loud on a code the schema never writes. */
export function objectTypeFromCode(code: number): GitObjectType {
	const type = CODE_TO_TYPE.get(code)
	if (!type) throw new Error(`pggit: unknown stored git object type code ${code}`)
	return type
}

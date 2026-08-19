import { commitTreeOid } from "@/object/object"
import { diffFileLists, type TreeReader } from "@/object/tree-diff"
import { buildFileList } from "@/repo-view/build-file-list"
import { SNAPSHOT_REFS } from "@/repo-view/config"
import type { RepoFileProjection } from "@/repo-view/repo-file-projection"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"

const ZERO_OID = "0".repeat(40)

export type SnapshotDeps = {
	objects: ObjectStore
	snapshots: RepoFileProjection
}

/**
 * Refresh `refName`'s file snapshot after a push applied it. Non-branch refs are
 * ignored (§ SNAPSHOT_REFS); a delete (zero oid) drops the snapshot; otherwise
 * the projection advances to the new tip — incrementally from its recorded basis
 * when the tip descends from it, by full rebuild when no basis exists, and NOT AT
 * ALL when a newer push already projected past this oid (the monotonic guard,
 * spine chunk 4). This side supplies only the tree-walking; which plan applies is
 * the projection store's decision, under the branch's lock. Runs after the push
 * commits; a failure here never rolls back the git operation, and because the
 * basis and rows move together, an absorbed failure self-heals on the next push
 * (head didn't advance, so that push recomputes from the same basis).
 */
export async function syncRefSnapshot(
	deps: SnapshotDeps,
	repoId: string,
	refName: string,
	newOid: string,
): Promise<void> {
	if (!SNAPSHOT_REFS(refName)) return
	if (newOid === ZERO_OID) {
		await deps.snapshots.dropRefSnapshot(repoId, refName)
		return
	}
	const read: TreeReader = async (oid: string) => {
		const obj = await deps.objects.getObject(repoId, oid)
		if (!obj)
			throw new Error(`repo-view: object ${oid} missing while building ${refName}`)
		return obj
	}
	const treeOf = async (commitOid: string): Promise<string> =>
		commitTreeOid((await read(commitOid)).content)
	await deps.snapshots.applyRefAdvance(repoId, refName, newOid, {
		diffFrom: async (basisCommit) =>
			diffFileLists(read, await treeOf(basisCommit), await treeOf(newOid)),
		fullList: () => buildFileList(read, newOid),
	})
}

/**
 * Rebuild a repo's entire projection from its current branch tips — the backfill
 * for an existing repo, and the "nuke and rebuild" backstop if the cache ever
 * drifts. Everything is re-derived from the canonical packs; `clearRepo` also
 * clears the recorded bases, so every branch takes the full-rebuild path.
 */
export async function rebuildAllSnapshots(
	deps: SnapshotDeps & { refs: RefStore },
	repoId: string,
): Promise<void> {
	await deps.snapshots.clearRepo(repoId)
	for (const ref of await deps.refs.listRefs(repoId)) {
		await syncRefSnapshot(deps, repoId, ref.name, ref.oid)
	}
}

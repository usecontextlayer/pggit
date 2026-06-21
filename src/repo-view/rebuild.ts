import type { ObjectStore } from "@/object-store"
import type { RefStore } from "@/refs-store"
import { buildFileList } from "@/repo-view/build-file-list"
import { SNAPSHOT_REFS } from "@/repo-view/config"
import type { SnapshotStore } from "@/repo-view/snapshot-store"

const ZERO_OID = "0".repeat(40)

export type SnapshotDeps = {
	objects: ObjectStore
	snapshots: SnapshotStore
}

/**
 * Refresh `refName`'s file snapshot after a push applied it. Non-branch refs are
 * ignored (§ SNAPSHOT_REFS); a delete (zero oid) drops the snapshot; otherwise
 * the new tip's tree is walked — objects are already present post-ingest — into a
 * fresh snapshot. Runs after the push commits, so a failure here never rolls back
 * the git operation (the projection is rebuildable from the packs).
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
	const read = async (oid: string) => {
		const obj = await deps.objects.getObject(repoId, oid)
		if (!obj)
			throw new Error(`repo-view: object ${oid} missing while building ${refName}`)
		return obj
	}
	await deps.snapshots.rebuildRefSnapshot(
		repoId,
		refName,
		await buildFileList(read, newOid),
	)
}

/**
 * Rebuild a repo's entire projection from its current branch tips — the backfill
 * for an existing repo, and the "nuke and rebuild" backstop if the cache ever
 * drifts. Everything is re-derived from the canonical packs.
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

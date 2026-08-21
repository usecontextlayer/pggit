import { commitTreeOid } from "@/object/object"
import { ZERO_OID } from "@/object/oid"
import {
	diffFileLists,
	type FileEntry,
	listFiles,
	type TreeReader,
} from "@/object/tree-diff"
import type { RepoFileProjection } from "@/repo-file/projection"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"

export type ProjectionDeps = {
	objects: ObjectStore
	projection: RepoFileProjection
}

export type ObjectReader = (oid: string) => Promise<{ content: Buffer }>
export type FileList = { files: FileEntry[] }

/**
 * The flat path→blob index of a commit's tree (the `git ls-tree -r` of a commit,
 * read straight from the object store): one FileEntry per blob — full path from
 * the root, raw mode, blob oid. Subtrees are recursed; gitlinks (submodules) are
 * skipped (no blob in this repo). Blob CONTENT is NOT read — it lives in
 * git_object and is joined at query time (§4.5 collapse). The walk itself is
 * `listFiles` (object/tree-diff.ts), shared with the diff path so the full and
 * incremental projections can never disagree about what a tree contains.
 */
export async function buildFileList(
	readObject: ObjectReader,
	commitOid: string,
): Promise<FileList> {
	const commit = await readObject(commitOid)
	const readTree: TreeReader = async (oid) => (await readObject(oid)).content
	return { files: await listFiles(readTree, commitTreeOid(commit.content)) }
}

/**
 * Refresh `refName`'s file projection after a push applied it. Non-branch refs are
 * ignored; a delete (zero oid) drops the projection; otherwise
 * the projection advances to the new tip — incrementally from its recorded basis
 * when the tip descends from it, by full rebuild when no basis exists, and NOT AT
 * ALL when a newer push already projected past this oid (the monotonic guard).
 * This side supplies only the tree-walking; the projection store
 * selects the plan outside its transaction and rechecks the basis under the
 * branch lock before applying. Runs after the push commits; a failure here never
 * rolls back the git operation, and because the basis and rows move together, an
 * absorbed failure self-heals on the next push (head didn't advance, so that
 * push recomputes from the same basis).
 */
export async function syncRefProjection(
	deps: ProjectionDeps,
	repoId: string,
	refName: string,
	newOid: string,
): Promise<void> {
	// The queryable projection is branch-only: tags, notes, and pull refs do not
	// describe a workspace file tree.
	if (!refName.startsWith("refs/heads/")) return
	if (newOid === ZERO_OID) {
		await deps.projection.dropRefProjection(repoId, refName)
		return
	}
	const readObject: ObjectReader = async (oid: string) => {
		const obj = await deps.objects.getObject(repoId, oid)
		if (!obj)
			throw new Error(`repo-file: object ${oid} missing while building ${refName}`)
		return obj
	}
	const readTree: TreeReader = async (oid) => (await readObject(oid)).content
	const treeOf = async (commitOid: string): Promise<string> =>
		commitTreeOid((await readObject(commitOid)).content)
	await deps.projection.applyRefAdvance(repoId, refName, newOid, {
		diffFrom: async (basisCommit) =>
			diffFileLists(readTree, await treeOf(basisCommit), await treeOf(newOid)),
		fullList: () => buildFileList(readObject, newOid),
	})
}

/**
 * Rebuild a repo's entire projection from its current branch tips — the backfill
 * for an existing repo, and the "nuke and rebuild" backstop if the cache ever
 * drifts. Everything is re-derived from the canonical objects; `clearRepo` also
 * clears the recorded bases, so every branch takes the full-rebuild path.
 */
export async function rebuildAllProjections(
	deps: ProjectionDeps & { refs: RefStore },
	repoId: string,
): Promise<void> {
	await deps.projection.clearRepo(repoId)
	for (const ref of await deps.refs.listRefs(repoId)) {
		await syncRefProjection(deps, repoId, ref.name, ref.oid)
	}
}

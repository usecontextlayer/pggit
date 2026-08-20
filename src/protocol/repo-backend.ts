import type { RepoBackend } from "@/protocol/upload-pack"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"

/** Bind the repo-scoped upload-pack contract to the multi-repo stores. */
export function bindRepoBackend(
	stores: { objects: ObjectStore; refs: RefStore },
	repoId: string,
): RepoBackend {
	return {
		buildPack: (wants, haves, omitBlobs, includeTag, thinPack) =>
			stores.objects.buildPack(repoId, wants, haves, omitBlobs, includeTag, thinPack),
		getSymref: (name) => stores.refs.getSymref(repoId, name),
		listRefs: () => stores.refs.listRefs(repoId),
		processHaves: (haves) => stores.objects.processHaves(repoId, haves),
		readyToGiveUp: (wants, common) => stores.objects.readyToGiveUp(repoId, wants, common),
	}
}

import { graphWalk } from "@/graph-walk"
import { count, label, withPhase } from "@/instrument"
import { commitParents, type GitObjectType, referencedOids } from "@/object"
import { type PackInputObject, writePack } from "@/pack/write-pack"
import {
	encodeAcknowledgments,
	encodeLsRefsResponse,
	encodePackfileResponse,
	encodeReadyWithPack,
	type LsRefEntry,
	parseFetch,
	parseV2Request,
	type V2Request,
} from "@/protocol/v2"

export type BackendObject = { type: GitObjectType; content: Buffer }

/** Everything the upload-pack service needs from a single repo's storage. */
export type RepoBackend = {
	listRefs: () => Promise<{ name: string; oid: string }[]>
	getSymref: (name: string) => Promise<string | null>
	getObject: (oid: string) => Promise<BackendObject | null>
}

async function readOrThrow(backend: RepoBackend, oid: string): Promise<BackendObject> {
	const obj = await backend.getObject(oid)
	if (!obj) throw new Error(`upload-pack: object ${oid} not found`)
	return obj
}

/** Follow a tag chain to its non-tag target; undefined if `oid` is not a tag. */
async function peelTag(oid: string, backend: RepoBackend): Promise<string | undefined> {
	let cur = oid
	let sawTag = false
	for (let i = 0; i < 16; i++) {
		const obj = await backend.getObject(cur)
		if (obj?.type !== "tag") return sawTag ? cur : undefined
		sawTag = true
		const target = referencedOids("tag", obj.content)[0]
		if (!target) return undefined
		cur = target
	}
	throw new Error("upload-pack: tag chain too deep")
}

async function handleLsRefs(req: V2Request, backend: RepoBackend): Promise<Buffer> {
	label("ls-refs")
	return withPhase("ref-advertise", async () => {
		const wantPeel = req.args.includes("peel")
		const wantSymrefs = req.args.includes("symrefs")
		const prefixes = req.args
			.filter((a) => a.startsWith("ref-prefix "))
			.map((a) => a.slice("ref-prefix ".length))
		const matches = (name: string) =>
			prefixes.length === 0 || prefixes.some((p) => name.startsWith(p))

		const refs = await backend.listRefs()
		const byName = new Map(refs.map((r) => [r.name, r.oid]))
		const entries: LsRefEntry[] = []

		const headTarget = await backend.getSymref("HEAD")
		if (headTarget && matches("HEAD")) {
			const headOid = byName.get(headTarget)
			if (headOid) {
				entries.push({
					name: "HEAD",
					oid: headOid,
					symrefTarget: wantSymrefs ? headTarget : undefined,
				})
			}
		}

		for (const ref of refs) {
			if (!matches(ref.name)) continue
			const entry: LsRefEntry = { name: ref.name, oid: ref.oid }
			if (wantPeel) {
				const peeled = await peelTag(ref.oid, backend)
				if (peeled) entry.peeled = peeled
			}
			entries.push(entry)
		}

		return encodeLsRefsResponse(entries)
	})
}

/** Translate the wire filter spec to a walk option; reject what we don't honor. */
function filterOmitsBlobs(filter: string | undefined): boolean {
	if (filter === undefined) return false
	if (filter === "blob:none") return true
	throw new Error(`upload-pack: unsupported filter ${JSON.stringify(filter)}`)
}

/** The subset of `haves` the server actually has — the common negotiation set. */
async function commonHaves(haves: string[], backend: RepoBackend): Promise<string[]> {
	const common: string[] = []
	for (const h of haves) {
		if (await backend.getObject(h)) common.push(h)
	}
	return common
}

/** Whether `start` reaches any common commit by ancestor walk (commit/tag links). */
async function reachesCommon(
	start: string,
	common: Set<string>,
	backend: RepoBackend,
): Promise<boolean> {
	const seen = new Set<string>()
	const queue = [start]
	while (queue.length > 0) {
		const oid = queue.pop()
		if (oid === undefined || seen.has(oid)) continue
		seen.add(oid)
		if (common.has(oid)) return true
		const obj = await readOrThrow(backend, oid)
		if (obj.type === "tag") queue.push(...referencedOids("tag", obj.content))
		else if (obj.type === "commit") queue.push(...commitParents(obj.content))
	}
	return false
}

/**
 * git's `ok_to_give_up`: ready once every want reaches a common have by ancestry
 * — the haves form a cut below all wants, so the delta is well-defined.
 */
async function readyToGiveUp(
	wants: string[],
	common: string[],
	backend: RepoBackend,
): Promise<boolean> {
	if (common.length === 0) return false
	const commonSet = new Set(common)
	for (const want of wants) {
		if (!(await reachesCommon(want, commonSet, backend))) return false
	}
	return true
}

/**
 * Build the delta pack: the want-closure minus the have-closure. Explicitly-
 * wanted OIDs are roots and always included, even when the have-closure covers
 * them — a promisor lazy-fetch wants a blob reachable from a tree it has but is
 * itself missing (partial clone), so it must not be subtracted.
 */
async function buildDeltaPack(
	wants: string[],
	common: string[],
	omitBlobs: boolean,
	backend: RepoBackend,
): Promise<Buffer> {
	const read = (oid: string) => readOrThrow(backend, oid)
	const { wantClosure, haveClosure } = await withPhase("graph-walk", async () => {
		const wantClosure = await graphWalk(wants, read, { omitBlobs })
		const haveClosure =
			common.length > 0 ? await graphWalk(common, read, { omitBlobs }) : new Set<string>()
		return { haveClosure, wantClosure }
	})

	const wantsSet = new Set(wants)
	const objects = await withPhase("read-objects", async () => {
		const objs: PackInputObject[] = []
		for (const oid of wantClosure) {
			if (haveClosure.has(oid) && !wantsSet.has(oid)) continue
			const obj = await read(oid)
			objs.push({ content: obj.content, type: obj.type })
		}
		return objs
	})

	const pack = await withPhase("write-pack", async () => writePack(objects))
	count("objectsServed", objects.length)
	count("packBytes", pack.length)
	return pack
}

async function handleFetch(req: V2Request, backend: RepoBackend): Promise<Buffer> {
	label("fetch")
	const { wants, haves, done, filter } = parseFetch(req)
	const omitBlobs = filterOmitsBlobs(filter)
	const common = await commonHaves(haves, backend)

	if (!done) {
		// Negotiation round (spec §4 shape b). Until the haves cut every want we
		// ACK/NAK and flush, no pack — the client sends more haves. Once ready, git
		// requires the pack in this same response, after the `ready` line.
		if (!(await readyToGiveUp(wants, common, backend))) {
			return encodeAcknowledgments(common, false)
		}
		return encodeReadyWithPack(
			common,
			await buildDeltaPack(wants, common, omitBlobs, backend),
		)
	}

	// `done` (spec §4 shapes a/c): pack the delta directly. A clone has no haves,
	// so the subtrahend is empty and we pack the whole want-closure.
	return encodePackfileResponse(await buildDeltaPack(wants, common, omitBlobs, backend))
}

/** Dispatch a v2 upload-pack POST body to ls-refs or fetch. */
export async function handleUploadPack(
	body: Buffer,
	backend: RepoBackend,
): Promise<Buffer> {
	const req = parseV2Request(body)
	if (req.command === "ls-refs") return handleLsRefs(req, backend)
	if (req.command === "fetch") return handleFetch(req, backend)
	throw new Error(`upload-pack: unsupported command ${JSON.stringify(req.command)}`)
}

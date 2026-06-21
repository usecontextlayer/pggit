import { graphWalk } from "@/graph-walk"
import { type GitObjectType, referencedOids } from "@/object"
import { type PackInputObject, writePack } from "@/pack/write-pack"
import {
	encodeLsRefsResponse,
	encodePackfileResponse,
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
}

async function handleFetch(req: V2Request, backend: RepoBackend): Promise<Buffer> {
	const { wants } = parseFetch(req)
	const reachable = await graphWalk(wants, (oid) => readOrThrow(backend, oid))

	const objects: PackInputObject[] = []
	for (const oid of reachable) {
		const obj = await readOrThrow(backend, oid)
		objects.push({ content: obj.content, type: obj.type })
	}

	return encodePackfileResponse(writePack(objects))
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

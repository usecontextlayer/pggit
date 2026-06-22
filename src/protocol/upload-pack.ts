import { label, withPhase } from "@/instrument"
import { type GitObjectType, referencedOids } from "@/object"
import { GitProtocolError } from "@/protocol/errors"
import {
	assertSupportedObjectFormat,
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

/**
 * Everything the upload-pack service needs from a single repo's storage. The graph
 * logic lives in the store now (set-based SQL over the row+edge model), so this is
 * a thin set-oriented interface — not the object-at-a-time walk interface of the
 * old app-side enumeration. `getObject` survives only for `ls-refs` tag peeling,
 * and goes when `peeled_oid` lands (Chunk 5).
 */
export type RepoBackend = {
	listRefs: () => Promise<{ name: string; oid: string }[]>
	getSymref: (name: string) => Promise<string | null>
	getObject: (oid: string) => Promise<BackendObject | null>
	/** The subset of `haves` the repo has — the negotiation common set. */
	commonHaves: (haves: string[]) => Promise<string[]>
	/** git's ok_to_give_up: does every want reach a common have by ancestry? */
	readyToGiveUp: (wants: string[], common: string[]) => Promise<boolean>
	/** The served pack: want-closure minus have-closure, plus the explicit wants. */
	buildPack: (wants: string[], haves: string[], omitBlobs: boolean) => Promise<Buffer>
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

		const wantUnborn = req.args.includes("unborn")
		const headTarget = await backend.getSymref("HEAD")
		if (headTarget && matches("HEAD")) {
			const headOid = byName.get(headTarget)
			if (headOid) {
				entries.push({
					name: "HEAD",
					oid: headOid,
					symrefTarget: wantSymrefs ? headTarget : undefined,
				})
			} else if (wantUnborn && wantSymrefs) {
				// Empty repo: HEAD points at a branch with no commit yet. git emits the
				// unborn HEAD only when the client asked for both `unborn` and `symrefs`
				// (ls-refs.c send_possibly_unborn_head), propagating the default branch.
				entries.push({ name: "HEAD", symrefTarget: headTarget, unborn: true })
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
	throw new GitProtocolError(`upload-pack: unsupported filter ${JSON.stringify(filter)}`)
}

async function handleFetch(req: V2Request, backend: RepoBackend): Promise<Buffer> {
	label("fetch")
	const { wants, haves, done, filter } = parseFetch(req)
	// A zero-want fetch is NOT an error: git's upload-pack treats it as a no-op
	// (upload-pack.c) and returns an empty pack — buildPack produces one, so we let
	// it fall through rather than rejecting.
	const omitBlobs = filterOmitsBlobs(filter)
	const common = await backend.commonHaves(haves)

	if (!done) {
		// Negotiation round (spec §4 shape b): until the haves cut every want we
		// ACK/NAK and flush, no pack — the client sends more haves. Once ready, git
		// requires the pack in this same response, after the `ready` line.
		if (!(await backend.readyToGiveUp(wants, common))) {
			return encodeAcknowledgments(common, false)
		}
		return encodeReadyWithPack(common, await backend.buildPack(wants, common, omitBlobs))
	}

	// `done` (spec §4 shapes a/c): pack the delta directly. A clone has no haves, so
	// the subtrahend is empty and we pack the whole want-closure.
	return encodePackfileResponse(await backend.buildPack(wants, common, omitBlobs))
}

/** Dispatch a v2 upload-pack POST body to ls-refs or fetch. */
export async function handleUploadPack(
	body: Buffer,
	backend: RepoBackend,
): Promise<Buffer> {
	const req = parseV2Request(body)
	assertSupportedObjectFormat(req.capabilities)
	if (req.command === "ls-refs") return handleLsRefs(req, backend)
	if (req.command === "fetch") return handleFetch(req, backend)
	throw new GitProtocolError(
		`upload-pack: unsupported command ${JSON.stringify(req.command)}`,
	)
}

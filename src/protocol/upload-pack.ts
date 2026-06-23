import { label, withPhase } from "@/instrument"
import { GitProtocolError, WantNotFoundError } from "@/protocol/errors"
import {
	assertSupportedObjectFormat,
	encodeAcknowledgments,
	encodeErr,
	encodeLsRefsResponse,
	encodePackfileResponse,
	encodeReadyWithPack,
	type LsRefEntry,
	parseFetch,
	parseV2Request,
	type V2Request,
} from "@/protocol/v2"

/** A ref advertised by the store: its oid, plus the peeled tag target when it is
 * an annotated tag (computed at ref-write, §5.3). */
export type AdvertisedRef = { name: string; oid: string; peeled?: string }

/**
 * Everything the upload-pack service needs from a single repo's storage. The graph
 * logic lives in the store now (set-based SQL over the row+edge model), so this is
 * a thin set-oriented interface — no object-at-a-time walk. Tag peeling is read
 * straight off the ref (`peeled`), so there is no object-fetch on the serve path.
 */
export type RepoBackend = {
	listRefs: () => Promise<AdvertisedRef[]>
	getSymref: (name: string) => Promise<string | null>
	/** The subset of `haves` the repo has — the negotiation common set. */
	commonHaves: (haves: string[]) => Promise<string[]>
	/** git's ok_to_give_up: does every want reach a common have by ancestry? */
	readyToGiveUp: (wants: string[], common: string[]) => Promise<boolean>
	/** The served pack: want-closure minus have-closure, plus the explicit wants
	 * (and, when `includeTag`, annotated tags pointing into the served set). */
	buildPack: (
		wants: string[],
		haves: string[],
		omitBlobs: boolean,
		includeTag: boolean,
	) => Promise<Buffer>
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
			// Peeled target is precomputed at ref-write (§5.3) — no per-request walk.
			if (wantPeel && ref.peeled) entry.peeled = ref.peeled
			entries.push(entry)
		}

		return encodeLsRefsResponse(entries)
	})
}

/**
 * Translate the wire filter spec to a walk option. We optimize the common
 * `blob:none` (blobless partial clone) by omitting blobs; any other filter
 * (`tree:0`, `blob:limit=…`, …) serves the FULL closure. The protocol lets a
 * server send more than a filter requests — the client accepts the superset and
 * has nothing to lazily fetch — so over-serving completes the clone that a hard
 * rejection would abort, without implementing every filter spec.
 */
function filterOmitsBlobs(filter: string | undefined): boolean {
	return filter === "blob:none"
}

async function handleFetch(req: V2Request, backend: RepoBackend): Promise<Buffer> {
	label("fetch")
	// parseFetch validates wire shape (malformed/unsupported args → GitProtocolError
	// → 400) BEFORE the serve attempt — kept outside the try so it stays a 400.
	const { wants, haves, done, filter, includeTag } = parseFetch(req)
	// A zero-want fetch is NOT an error: git's upload-pack treats it as a no-op
	// (upload-pack.c) and returns an empty pack — buildPack produces one, so we let
	// it fall through rather than rejecting.
	const omitBlobs = filterOmitsBlobs(filter)
	const common = await backend.commonHaves(haves)

	try {
		if (!done) {
			// Negotiation round (spec §4 shape b): until the haves cut every want we
			// ACK/NAK and flush, no pack — the client sends more haves. Once ready, git
			// requires the pack in this same response, after the `ready` line.
			if (!(await backend.readyToGiveUp(wants, common))) {
				return encodeAcknowledgments(common, false)
			}
			return encodeReadyWithPack(
				common,
				await backend.buildPack(wants, common, omitBlobs, includeTag),
			)
		}

		// `done` (spec §4 shapes a/c): pack the delta directly. A clone has no haves, so
		// the subtrahend is empty and we pack the whole want-closure.
		return encodePackfileResponse(
			await backend.buildPack(wants, common, omitBlobs, includeTag),
		)
	} catch (err) {
		// A `want` the repo does not have is a client condition, not a server fault:
		// answer it in-band like canonical upload-pack (`ERR … not our ref`) so the
		// client reads a clean protocol error, not an HTTP 500. A genuine serve failure
		// (any other error) still propagates → 500 (§10, no partial pack is emitted).
		if (err instanceof WantNotFoundError) return encodeErr(err.message)
		throw err
	}
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

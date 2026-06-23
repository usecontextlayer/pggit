/**
 * A malformed-request / unsupported-capability error detected at the git wire
 * boundary (bad command list, unknown command, unsupported object-format or
 * filter, a request body in an encoding we don't accept). It is the CLIENT's
 * fault, so the HTTP layer maps it to a 400 with the message — distinct from an
 * internal failure (a missing object mid-serve, a DB error), which stays a 500.
 * Validate at the boundary, fail loud, and let the type carry the status.
 */
export class GitProtocolError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "GitProtocolError"
	}
}

/**
 * A fetch `want` names an object this repo does not have — a CLIENT condition (a
 * stale/force-pushed tip, a lost promisor blob), not an internal failure. Real git
 * upload-pack answers it IN-BAND with `ERR upload-pack: not our ref <oid>` (an HTTP
 * 200 protocol error the client reads), so it must NOT escape as a 500. Carries the
 * absent OIDs; `handleFetch` maps it to the ERR pkt-line. Distinct from a generic
 * `Error` out of the serve path (a real backend fault), which still propagates → 500.
 */
export class WantNotFoundError extends Error {
	constructor(readonly oids: string[]) {
		super(`upload-pack: not our ref ${oids.join(" ")}`)
		this.name = "WantNotFoundError"
	}
}

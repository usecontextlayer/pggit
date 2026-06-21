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

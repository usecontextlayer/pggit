/**
 * A "the git data we were handed is not well-formed" error — raised while parsing
 * a packfile, applying a delta, or reading a git object's bytes. It is distinct
 * from `GitProtocolError` (a malformed *request* at the wire boundary, → HTTP
 * 400): a `GitFormatError` is about the *content* (a corrupt/truncated pack or
 * object), which on push surfaces as the `unpack <reason>` report-status line and
 * otherwise propagates as an internal failure.
 *
 * The `code` is the stable, assertable identity of the failure; the `message` is
 * free-form prose for humans (the `unpack` line, logs) and may be reworded
 * without breaking callers or tests. Tests assert `code`, never the message text.
 */
export type GitFormatErrorCode =
	// packfile framing / codec (read-pack)
	| "bad-magic"
	| "unsupported-version"
	| "trailer-mismatch"
	| "unknown-object-type"
	| "size-mismatch"
	| "trailing-bytes"
	| "unresolved-base"
	| "inflate-failed"
	// delta application
	| "delta-base-size-mismatch"
	| "delta-reserved-opcode"
	| "delta-target-size-mismatch"
	// git object content
	| "malformed-tree"
	| "missing-tree-header"

export class GitFormatError extends Error {
	readonly code: GitFormatErrorCode

	constructor(code: GitFormatErrorCode, message: string) {
		super(message)
		this.name = "GitFormatError"
		this.code = code
	}
}

import { GitFormatError } from "@/object/format-error"

/**
 * Run `fn`, assert it threw a `GitFormatError`, and return its stable `.code` (for
 * a `.toBe("…")` on the code rather than the free-form message). Re-throws any other
 * error and fails loud if nothing was thrown.
 */
export function expectGitFormatError(fn: () => unknown): string {
	try {
		fn()
	} catch (e) {
		if (e instanceof GitFormatError) return e.code
		throw e
	}
	throw new Error("expected a GitFormatError, none thrown")
}

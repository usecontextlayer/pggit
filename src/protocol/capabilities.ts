import { GitProtocolError } from "@/protocol/errors"

// Protocol capabilities shared by both services — the agent string and the
// object-format guard are version-agnostic (push is v0, fetch is v2), so they
// live here rather than in the v2-named module.

export const AGENT = "pggit/0.0.0"

/**
 * Reject a client negotiating a non-sha1 object hash. pggit is SHA-1 only (the
 * charter) and assumes 40-hex / 20-byte OIDs everywhere; a sha256 client would
 * otherwise fail deep in the parser on a 64-hex OID. Catch it at the boundary
 * with a clear message. An absent `object-format` cap defaults to sha1 (git's
 * default), so it is accepted.
 */
export function assertSupportedObjectFormat(caps: string[]): void {
	const fmt = caps.find((c) => c.startsWith("object-format="))
	if (fmt !== undefined && fmt !== "object-format=sha1") {
		throw new GitProtocolError(
			`unsupported ${fmt} — only object-format=sha1 is supported`,
		)
	}
}

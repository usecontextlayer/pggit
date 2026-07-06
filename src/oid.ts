/**
 * A validated git object id: exactly 40 lowercase hex characters (sha1 — the
 * only object-format pggit advertises). The zero id (`"0" × 40`) IS a valid
 * `Oid`; its sentinel meaning (absent / create's old / delete's new) stays a
 * value-level comparison at each consumer.
 *
 * The brand means "this string passed `isOid`". Downstream conversions —
 * `Buffer.from(oid, "hex")` in the store CAS and the ancestry/connectivity
 * walks — silently yield a short or empty buffer for anything else, so each
 * boundary validates ONCE and the type carries the guarantee inward.
 */
export type Oid = string & { __brand: "oid" }

const OID_PATTERN = /^[0-9a-f]{40}$/

export function isOid(raw: string): raw is Oid {
	return OID_PATTERN.test(raw)
}

/** The zero id — the wire's "no value" sentinel. */
export const ZERO_OID = "0".repeat(40) as Oid

/**
 * Which refs get a queryable file snapshot. Branches only — tags, notes, and
 * `refs/pull/*` are skipped. One edit to widen the projection later.
 */
export const SNAPSHOT_REFS = (refName: string): boolean =>
	refName.startsWith("refs/heads/")

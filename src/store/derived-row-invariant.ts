import { objectTypeFromCode } from "@/database/object-type-codes"

/** Stored commits and tags always have their transactionally-derived row. */
export function throwMissingDerivedRow(oid: string, type: number): never {
	throw new Error(
		`pggit: stored ${objectTypeFromCode(type)} ${oid} has no derived row — the chunk-1 invariant is broken (backfill missed, or a write path skipped derivation)`,
	)
}

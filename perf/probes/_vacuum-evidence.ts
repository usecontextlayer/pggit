import postgresFactory from "postgres"

type VacuumEvidence = {
	lines: string[]
	notRemovable: number
	relations: number
	remain: number
	removed: number
	xidsOld: number
}

function noticeInteger(value: string, context: string): number {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`VACUUM VERBOSE emitted an invalid ${context}: ${value}`)
	}
	return parsed
}

function relationNoticePattern(relation: string): RegExp {
	const escaped = relation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return new RegExp(`(?:^|\\W)${escaped}(?:_p\\d+)?(?:\\W|$)`)
}

/** Run VACUUM VERBOSE on a private connection and aggregate Postgres's tuple notices. */
export async function vacuumVerbose(
	baseUrl: string,
	schema: string,
	relations: string | readonly string[],
	options: { analyze?: boolean; applicationName?: string } = {},
): Promise<VacuumEvidence> {
	const requested = typeof relations === "string" ? [relations] : relations
	if (requested.length === 0) throw new Error("VACUUM VERBOSE requires a relation")
	const lines: string[] = []
	const conn = postgresFactory(baseUrl, {
		connection: {
			...(options.applicationName === undefined
				? {}
				: { application_name: options.applicationName }),
			search_path: schema,
		},
		max: 1,
		onnotice: (notice) => lines.push(`${notice.message ?? ""}`),
	})
	try {
		for (const relation of requested) {
			await conn.unsafe(
				`vacuum (verbose${options.analyze === true ? ", analyze" : ""}) ${relation}`,
			)
		}
	} finally {
		await conn.end()
	}
	const evidence: VacuumEvidence = {
		lines,
		notRemovable: 0,
		relations: 0,
		remain: 0,
		removed: 0,
		xidsOld: 0,
	}
	const relationPatterns = requested.map(relationNoticePattern)
	for (const line of lines) {
		const normalized = line.replace(/\s+/g, " ")
		if (
			!normalized.includes("finished vacuuming") ||
			!relationPatterns.some((pattern) => pattern.test(normalized))
		) {
			continue
		}
		const tuples = normalized.match(
			/tuples: (\d+) removed, (\d+) remain, (\d+) are dead but not yet removable/,
		)
		if (tuples !== null) {
			const [, removed, remain, notRemovable] = tuples
			if (removed === undefined || remain === undefined || notRemovable === undefined) {
				throw new Error(`VACUUM VERBOSE emitted an incomplete tuple notice: ${line}`)
			}
			evidence.removed += noticeInteger(removed, "removed-tuple count")
			evidence.remain += noticeInteger(remain, "remaining-tuple count")
			evidence.notRemovable += noticeInteger(notRemovable, "not-removable-tuple count")
			evidence.relations++
		}
		const xidAge = normalized.match(/which was (\d+) XIDs old/)?.[1]
		if (xidAge !== undefined) {
			evidence.xidsOld = Math.max(evidence.xidsOld, noticeInteger(xidAge, "XID age"))
		}
	}
	if (evidence.relations === 0) {
		throw new Error(
			`VACUUM VERBOSE did not report tuple counts for ${requested.join(", ")}:\n${lines.join("\n")}`,
		)
	}
	return evidence
}

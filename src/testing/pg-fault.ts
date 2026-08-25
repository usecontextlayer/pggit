import { setTimeout as sleep } from "node:timers/promises"
import type { Sql } from "postgres"

export type BackendAbort = {
	kind: "cancel" | "terminate"
	needle: string
	skip: number
}

/** Watch one Postgres backend and abort it once it enters the targeted statement occurrence. `query_start` distinguishes repeated executions of the same statement; `stop` lets a caller end a missed aim as soon as the operation settles. */
export async function abortBackendWhenActive(
	admin: Sql,
	pid: number,
	abort: BackendAbort,
	options: { limitMs: number; stop?: { now: boolean } },
): Promise<boolean> {
	const starts = new Set<string>()
	const t0 = Date.now()
	while (!options.stop?.now && Date.now() - t0 < options.limitMs) {
		const [activity] = await admin<{ query: string; started_at: string }[]>`
			select query, query_start::text as started_at
			from pg_stat_activity where pid = ${pid} and state = 'active'`
		if (
			activity?.started_at &&
			activity.query.toLowerCase().replace(/\s+/g, " ").includes(abort.needle)
		) {
			starts.add(activity.started_at)
			if (starts.size > abort.skip) {
				if (abort.kind === "cancel") await admin`select pg_cancel_backend(${pid})`
				else await admin`select pg_terminate_backend(${pid})`
				return true
			}
		}
		await sleep(1)
	}
	return false
}

/**
 * Shared plumbing for the `perf/breakage/txn--*.ts` harnesses — the crash-integrity
 * lens on bounded multi-statement maintenance. The probes price interruption and
 * recovery against the current cascading object sweep, reachability epoch, and
 * D15 repack-repair behavior.
 *
 * Matches `perf/delta-probe.ts`: a `--pg=` flag defaulting to the local
 * docker-compose Postgres, and a markdown table printer. Nothing here reaches into
 * pggit internals — every harness drives the public `createRepack` / `createGc` /
 * wire-server surfaces and observes bytes, rows, and wall time.
 */
export { flag, positiveIntegerFlag } from "../args"

import { flag } from "../args"

export const PG_URL = flag("pg", "postgres://postgres:postgres@localhost:6489/postgres")

/** One measurement table, markdown-shaped and column-aligned. */
export function table(headers: string[], rows: (string | number)[][]): string {
	const all = [headers, ...rows.map((r) => r.map(String))]
	const width = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)))
	const line = (r: string[]): string =>
		`| ${r.map((c, i) => c.padEnd(width[i] ?? 0)).join(" | ")} |`
	return [
		line(headers),
		`|${width.map((n) => "-".repeat(n + 2)).join("|")}|`,
		...all.slice(1).map(line),
	].join("\n")
}

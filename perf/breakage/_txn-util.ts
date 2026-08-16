/**
 * Shared plumbing for the `perf/breakage/txn--*.ts` harnesses — the crash-integrity
 * lens (a repack pass is many transactions, a GC pass is three independent sweeps,
 * and neither has a watermark; see docs/2026-08-15-delta-pack-design.md D4/D5/D7).
 *
 * Matches `perf/delta-probe.ts`: a `--pg=` flag defaulting to the local
 * docker-compose Postgres, and a markdown table printer. Nothing here reaches into
 * pggit internals — every harness drives the public `createRepack` / `createGc` /
 * wire-server surfaces and observes bytes, rows, and wall time.
 */

/** `--name=value` from argv, or `fallback`. */
export function flag(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}

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

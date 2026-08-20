/**
 * Shared plumbing for the `perf/breakage/txn--*.ts` harnesses — the crash-integrity
 * lens on bounded multi-statement maintenance. The probes price interruption and
 * recovery against the current origin-closure GC, reachability epoch, and
 * D15 repack-repair behavior.
 *
 * The probes drive public maintenance and wire surfaces, then use deliberate
 * isolated-schema SQL seams for fault injection, exact censuses, and timing-bucket
 * evidence. This module only shares their presentation boundary.
 */
export { table } from "../table"

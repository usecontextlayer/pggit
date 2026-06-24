import type { Sql } from "postgres"

/**
 * Per-repo reachability GC — the one piece of the Postgres-native redesign (§7)
 * still unimplemented. See `docs/2026-06-24-force-commit-gc-design.md` for the
 * full design; the observable contract this must satisfy is §4 of that doc.
 *
 * THIS IS A TDD STUB. `gc()` throws so the behavioural tests written against the
 * §4 contract fail for exactly this reason, then pass once GC is implemented. Do
 * not add behaviour here — the implementation lands in a later phase.
 */

/** Tunables for one GC pass. `graceSeconds` is REQUIRED — no silent default: an
 * object is reclaimed iff it is unreachable from every ref AND its `created_at`
 * is older than `graceSeconds` (0 ⇒ reclaim all unreachable; a huge value ⇒
 * retain). `batchLimit` caps the per-batch DELETE size (sweep tuning only — it
 * never changes the final observable state). */
export type GcOptions = { graceSeconds: number; batchLimit?: number }

/** What one GC pass reclaimed: the deleted `git_object` / `git_edge` row counts. */
export type GcResult = { deletedObjects: number; deletedEdges: number }

export type Gc = ReturnType<typeof createGc>

/**
 * Build the GC over a porsager client (the same wire→DB boundary the object and
 * ref stores take). `gc(repo, opts)` reclaims a single repo's unreachable-and-
 * old-enough objects offline; reachable objects are always retained.
 */
export function createGc(pg: Sql) {
	// `pg` is unused in the stub; the implementation will run the sweep through it.
	void pg
	return {
		async gc(_repo: string, _opts: GcOptions): Promise<GcResult> {
			throw new Error("pggit gc: not implemented (TDD stub)")
		},
	}
}

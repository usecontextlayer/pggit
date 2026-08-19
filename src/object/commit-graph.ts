/**
 * Generation numbers over a batch of commits (spine chunk 1). A commit's
 * generation is `1 + max(generation(parents))` — git's commit-graph number — and
 * the finite region carries the strict invariant `gen(parent) < gen(child)` that
 * the frontier's exactness rests on. NULL means "no pruning" (git's
 * GENERATION_NUMBER_INFINITY) and is ABSORBING: a commit whose parent is absent
 * or NULL-generation is NULL, and stays NULL forever — generations are computed
 * exactly once, at the moment a commit's row is written, never recomputed when a
 * missing parent arrives later (ingest atomicity: no crash window can leave a
 * half-backfilled derived scalar).
 *
 * Pure: the caller supplies the batch (oid → ordered parents) and the prior
 * generations of every out-of-batch parent that already has a `git_commit` row.
 * A parent in neither map is ABSENT — denied-push residue — and poisons its
 * descendants to NULL.
 */

/** `generation` for every commit in `batch`, resolved in one topological pass —
 * in-batch parents resolve locally whatever order the pack listed them in (a git
 * pack lists commits newest-first; per-row computation in pack order would derive
 * NULL for every commit of a first push and absorbing-NULL would freeze that
 * forever). */
export function computeGenerations(
	batch: ReadonlyMap<string, readonly string[]>,
	prior: ReadonlyMap<string, number | null>,
): Map<string, number | null> {
	// Kahn over the in-batch parent relation only: out-of-batch parents are
	// already settled (prior row, or absent ≡ NULL), so they never gate readiness.
	const indegree = new Map<string, number>()
	const dependents = new Map<string, string[]>()
	for (const [oid, parents] of batch) {
		let inBatch = 0
		for (const p of parents) {
			if (!batch.has(p)) continue
			inBatch++
			const slot = dependents.get(p)
			if (slot) slot.push(oid)
			else dependents.set(p, [oid])
		}
		indegree.set(oid, inBatch)
	}

	const generations = new Map<string, number | null>()
	const ready = [...indegree.entries()].filter(([, n]) => n === 0).map(([oid]) => oid)
	while (ready.length > 0) {
		const oid = ready.pop() as string
		const parents = batch.get(oid) as readonly string[]
		let generation: number | null = 1
		for (const p of parents) {
			const parentGen = batch.has(p) ? generations.get(p) : prior.get(p)
			// Absent parent (in neither map) or NULL parent: absorbing NULL.
			if (parentGen === undefined || parentGen === null) {
				generation = null
				break
			}
			if (parentGen + 1 > generation) generation = parentGen + 1
		}
		generations.set(oid, generation)
		for (const child of dependents.get(oid) ?? []) {
			const childIndegree = indegree.get(child)
			if (childIndegree === undefined) {
				throw new Error(`computeGenerations: no indegree for batch commit ${child}`)
			}
			const n = childIndegree - 1
			indegree.set(child, n)
			if (n === 0) ready.push(child)
		}
	}

	// Content-addressed parents cannot cycle (an oid is a hash of its parents'
	// oids), so leftovers mean a caller bug, never data.
	if (generations.size !== batch.size) {
		throw new Error(
			`computeGenerations: ${batch.size - generations.size} commits form a parent cycle`,
		)
	}
	return generations
}

/** Read the total result of `computeGenerations` without collapsing a valid NULL
 * generation and an impossible missing key into the same value. */
export function requireGeneration(
	generations: ReadonlyMap<string, number | null>,
	oid: string,
): number | null {
	if (!generations.has(oid)) {
		throw new Error(`computeGenerations: no result for batch commit ${oid}`)
	}
	return generations.get(oid) as number | null
}

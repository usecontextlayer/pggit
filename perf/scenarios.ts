/**
 * Synthetic repository shapes for the perf harness, described in the git-sizer
 * vocabulary (blob count + size, tree width/depth, history length, ref count).
 * All sizes are tunable from the CLI; these are the defaults.
 */

export type Scenario = {
	name: string
	/** Distinct files in the final tree. */
	blobCount: number
	blobMinBytes: number
	blobMaxBytes: number
	/** Fanout per directory level. */
	treeWidth: number
	/** Directory nesting depth. */
	pathDepth: number
	/** Number of commits (history length). */
	historyLen: number
	/** Files modified per commit after the first (churn → extra blob versions). */
	churn: number
	/** Extra branch refs beyond main. */
	refCount: number
}

export const SCENARIOS: Record<string, Scenario> = {
	// Stresses graph-walk + ref advertisement: deep history, many refs, deep trees.
	adversarial: {
		blobCount: 120,
		blobMaxBytes: 1024,
		blobMinBytes: 128,
		churn: 4,
		historyLen: 200,
		name: "adversarial",
		pathDepth: 4,
		refCount: 40,
		treeWidth: 6,
	},
	// The target workload: many small markdown files, moderate history.
	markdown: {
		blobCount: 200,
		blobMaxBytes: 4096,
		blobMinBytes: 512,
		churn: 6,
		historyLen: 20,
		name: "markdown",
		pathDepth: 2,
		refCount: 5,
		treeWidth: 16,
	},
	// Smoke: a handful of objects, sub-second — proves the harness end to end.
	tiny: {
		blobCount: 8,
		blobMaxBytes: 256,
		blobMinBytes: 32,
		churn: 2,
		historyLen: 3,
		name: "tiny",
		pathDepth: 1,
		refCount: 1,
		treeWidth: 4,
	},
}

/** Deterministic PRNG (mulberry32) — seeded so a scenario reproduces run to run. */
export function mulberry32(seed: number): () => number {
	let state = seed | 0
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

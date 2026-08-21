/**
 * Corpus verification for `encodeDelta` — layer 3, the one that runs against REAL
 * repositories rather than fuzzed or generated ones.
 *
 * Fuzzing proves the encoder is correct on the inputs we thought to describe. A
 * generated fixture proves it on the shape we thought to model. Neither can tell us
 * it is correct on the trees, blobs and commits that actually exist in a repository
 * somebody uses — which is where a delta encoder meets content nobody designed:
 * submodules, symlinks, mode changes, empty files, non-UTF-8 paths, binary blobs,
 * merge commits with several parents.
 *
 * For every repository given, and every (base → target) pair the same-path heuristic
 * produces, this asserts:
 *
 *   1. `applyDelta(base, encodeDelta(base, target))` is byte-identical to `target`.
 *   2. canonical `git` ingests a pack built from those deltas and recovers every
 *      object byte-identically, fsck-clean.
 *   3. the resulting size is reported against `git gc --aggressive` — the quality
 *      benchmark, so a regression in delta quality is visible rather than silent.
 *
 * This is a VERIFICATION, not a report: any violation exits non-zero.
 *
 * It is not a vitest test because its corpus cannot be committed — the motivating
 * repository is customer data, and the useful corpora are whatever exists on the
 * machine. CI covers the same properties on generated fixtures
 * (`src/pack/encode-delta-oracle.test.ts`); this is what you run before believing it.
 *
 *   npx tsx perf/probes/delta-corpus.ts --repo=../customers/.../komal-96afa2eb --repo=.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { parseRepeatedArgs } from "@perf/args"
import { z } from "zod"
import type { Oid } from "@/oid"
import { applyDelta, DELTA_SIZE_MIN, encodeDelta } from "@/pack/delta"
import {
	cloneIndependentMirror,
	gitLogRawBasePairs,
	loadAllReachableObjects,
	loadGitObjects,
	packFileBytes,
} from "@/testing/git-fixtures"
import { buildRefDeltaPack, type RefDeltaPackEntry } from "@/testing/ref-delta-pack"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"

const mb = (n: number): string => `${(n / 1_000_000).toFixed(2)} MB`

function repoArgs(): string[] {
	return parseRepeatedArgs(
		z.object({ repo: z.tuple([z.string().min(1)], z.string().min(1)) }).strict(),
	).repo
}

type Verdict = {
	repo: string
	objects: number
	deltified: number
	eligible: number
	roundTripFailures: string[]
	undeltifiedBytes: number
	ourPackBytes: number
	gitGcBytes: number
	gitRecoveryFailures: string[]
}

async function verifyRepo(
	repo: string,
	scratch: ReturnType<typeof createScratchArena>,
): Promise<Verdict> {
	// Never work on the caller's repository: `git gc` below rewrites whatever it is
	// pointed at, and a customer mirror must stay byte-for-byte pristine. A MIRROR
	// clone (not a directory copy) takes every ref and object and no working tree —
	// so pointing this at a dev checkout does not copy its node_modules — and
	// `--no-hardlinks` keeps the clone's object files physically its own, so the
	// aggressive gc cannot reach back into the source's store.
	const workRoot = scratch.make("corpus")
	const work = join(workRoot, "repo.git")
	await cloneIndependentMirror(repo, work)

	const objects = await loadAllReachableObjects(work)
	if (objects.length === 0) {
		throw new Error(`delta-corpus: ${repo} has no reachable objects`)
	}
	const byOid = new Map(objects.map((o) => [o.oid, o]))
	const pairs = await gitLogRawBasePairs(work)

	const roundTripFailures: string[] = []
	const entries: RefDeltaPackEntry[] = []
	let undeltifiedBytes = 0
	let deltified = 0
	let eligible = 0

	// A real history can pair A→B AND B→A (a file toggling between two contents),
	// and emitting both as deltas is an unresolvable cycle — observed at 5 pairs on
	// pggit's own history. The SHIPPED repack cannot produce this (its star
	// invariant makes every base a whole encoding), but this harness models
	// unconstrained chains, so it must break cycles itself: an object whose pair
	// chain leads back to it ships whole.
	const inCycle = (start: Oid): boolean => {
		const seen = new Set<Oid>([start])
		let cursor = pairs.get(start)
		while (cursor !== undefined) {
			if (seen.has(cursor)) return true
			seen.add(cursor)
			cursor = pairs.get(cursor)
		}
		return false
	}

	for (const o of objects) {
		const whole = deflateSync(o.content)
		undeltifiedBytes += whole.length

		const baseOid = pairs.get(o.oid)
		const base = baseOid ? byOid.get(baseOid) : undefined
		if (!base || base.type !== o.type || inCycle(o.oid)) {
			entries.push({ content: o.content, kind: "base", type: o.type })
			continue
		}

		eligible++
		const delta = encodeDelta(base.content, o.content)
		// Property 1 — the encoder's own contract, on real content.
		if (!applyDelta(base.content, delta).equals(o.content)) {
			roundTripFailures.push(`${o.type} ${o.oid} (base ${base.oid})`)
			entries.push({ content: o.content, kind: "base", type: o.type })
			continue
		}
		const encoded = deflateSync(delta)
		if (delta.length >= DELTA_SIZE_MIN && encoded.length < whole.length) {
			entries.push({ baseOid: base.oid, delta, kind: "ref" })
			deltified++
		} else {
			entries.push({ content: o.content, kind: "base", type: o.type })
		}
	}
	if (eligible === 0) {
		throw new Error(`delta-corpus: ${repo} produced no eligible base/target pairs`)
	}
	if (deltified === 0) {
		throw new Error(`delta-corpus: ${repo} produced no delta worth transmitting`)
	}

	// Property 2 — canonical git must ingest the pack and recover every object.
	// A REF_DELTA base must precede nothing in particular, but it MUST be present;
	// bases here are always other entries of the same pack, so the pack is self-contained.
	const sinkRoot = scratch.make("corpus-sink")
	const sink = join(sinkRoot, "repo")
	mkdirSync(sink) // spawn reports a missing cwd as `spawn git ENOENT`
	await spawnGit(["init", "-q", "-b", "main"], { cwd: sink })
	const ourPack = buildRefDeltaPack(entries)
	await spawnGit(["index-pack", "--stdin", "--fix-thin"], {
		cwd: sink,
		input: ourPack,
	})
	await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: sink })

	const gitRecoveryFailures: string[] = []
	const recovered = await loadGitObjects(
		sink,
		objects.map((object) => object.oid),
	)
	for (const [index, expected] of objects.entries()) {
		const actual = recovered[index]
		if (
			actual === undefined ||
			actual.oid !== expected.oid ||
			actual.type !== expected.type ||
			!actual.content.equals(expected.content)
		) {
			gitRecoveryFailures.push(expected.oid)
		}
	}

	// Property 3 — the quality benchmark.
	await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: work })
	const gitGcBytes = await packFileBytes(work)
	if (gitGcBytes === 0) throw new Error(`git gc produced a zero-byte pack for ${repo}`)

	return {
		deltified,
		eligible,
		gitGcBytes,
		gitRecoveryFailures,
		objects: objects.length,
		ourPackBytes: ourPack.length,
		repo,
		roundTripFailures,
		undeltifiedBytes,
	}
}

async function main(): Promise<void> {
	const scratch = createScratchArena()
	const verdicts: Verdict[] = []
	try {
		for (const repo of repoArgs()) {
			console.log(`\n## ${repo}`)
			const v = await verifyRepo(repo, scratch)
			verdicts.push(v)
			console.log(
				`objects ${v.objects}, eligible pairs ${v.eligible}, deltified ${v.deltified}`,
			)
			console.log(
				`undeltified payload ${mb(v.undeltifiedBytes)} → our pack ${mb(v.ourPackBytes)} ` +
					`(${(v.undeltifiedBytes / v.ourPackBytes).toFixed(1)}×) · git pack ${mb(v.gitGcBytes)} ` +
					`(${(v.undeltifiedBytes / v.gitGcBytes).toFixed(1)}×)`,
			)
			if (v.roundTripFailures.length > 0) {
				console.error(`ROUND-TRIP FAILURES (${v.roundTripFailures.length}):`)
				for (const f of v.roundTripFailures.slice(0, 20)) console.error(`  ${f}`)
			}
			if (v.gitRecoveryFailures.length > 0) {
				console.error(`GIT RECOVERY FAILURES (${v.gitRecoveryFailures.length}):`)
				for (const f of v.gitRecoveryFailures.slice(0, 20)) console.error(`  ${f}`)
			}
		}
	} finally {
		scratch.cleanup()
	}

	const violations = verdicts.reduce(
		(n, v) => n + v.roundTripFailures.length + v.gitRecoveryFailures.length,
		0,
	)
	console.log(`\n${violations === 0 ? "OK" : `${violations} VIOLATIONS`}`)
	if (violations > 0) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

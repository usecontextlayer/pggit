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
 *   npx tsx perf/delta-corpus.ts --repo=../customers/.../komal-96afa2eb --repo=.
 */
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import type { GitObjectType } from "@/object/object"
import { applyDelta, encodeDelta } from "@/pack/delta"
import { encodeObjectHeader, PACK_OBJ_TYPE } from "@/pack/object-header"
import { spawnGit } from "@/testing/spawn-git"

const PACK_TYPE_CODE: Record<GitObjectType, number> = {
	blob: PACK_OBJ_TYPE.BLOB,
	commit: PACK_OBJ_TYPE.COMMIT,
	tag: PACK_OBJ_TYPE.TAG,
	tree: PACK_OBJ_TYPE.TREE,
}

type Obj = { oid: string; type: GitObjectType; content: Buffer }
type PackEntry =
	| { content: Buffer; kind: "base"; type: GitObjectType }
	| { baseOid: string; delta: Buffer; kind: "ref" }

const mb = (n: number): string => `${(n / 1_000_000).toFixed(2)} MB`

function repoArgs(): string[] {
	const repos = process.argv
		.filter((a) => a.startsWith("--repo="))
		.map((a) => a.slice("--repo=".length))
	if (repos.length === 0) {
		throw new Error("delta-corpus: at least one --repo=<path> is required")
	}
	return repos
}

/** Every reachable object with its bytes, in ONE `cat-file --batch`. */
async function reachableObjects(dir: string): Promise<Obj[]> {
	const list = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
	const oids = [
		...new Set(
			list.stdout
				.split("\n")
				.map((l) => l.slice(0, 40))
				.filter((o) => /^[0-9a-f]{40}$/.test(o)),
		),
	]
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
	})
	const buf = res.stdoutBytes
	const objs: Obj[] = []
	let pos = 0
	while (pos < buf.length) {
		const nl = buf.indexOf(0x0a, pos)
		if (nl < 0) break
		const [oid, type, sizeStr] = buf.subarray(pos, nl).toString("latin1").split(" ")
		if (!oid || !type || !sizeStr) break
		const size = Number(sizeStr)
		const start = nl + 1
		objs.push({
			content: buf.subarray(start, start + size),
			oid,
			type: type as GitObjectType,
		})
		pos = start + size + 1
	}
	return objs
}

/**
 * (target → base) pairs from ONE `git log --raw` pass: for each commit, every changed
 * path's old and new oid. This IS the same-path-one-commit-earlier heuristic, taken
 * from structure the repository already carries rather than from a similarity search.
 */
async function basePairs(dir: string): Promise<Map<string, string>> {
	const out = await spawnGit(
		[
			"log",
			"--reverse",
			"--raw",
			"-r",
			"-t",
			"--no-renames",
			"--abbrev=40",
			"--format=@%H %T %P",
			"--all",
		],
		{ cwd: dir },
	)
	const pairs = new Map<string, string>()
	const commitTree = new Map<string, string>()
	for (const line of out.stdout.split("\n")) {
		if (line.startsWith("@")) {
			const [hash, tree, ...parents] = line.slice(1).split(" ")
			if (!hash || !tree) continue
			commitTree.set(hash, tree)
			const parentTree = parents[0] ? commitTree.get(parents[0]) : undefined
			if (parentTree && parentTree !== tree && !pairs.has(tree))
				pairs.set(tree, parentTree)
			continue
		}
		if (!line.startsWith(":")) continue
		const tab = line.indexOf("\t")
		if (tab < 0) continue
		const fields = line.slice(1, tab).split(" ")
		const [oldOid, newOid] = [fields[2], fields[3]]
		if (!oldOid || !newOid || /^0+$/.test(oldOid) || oldOid === newOid) continue
		if (!pairs.has(newOid)) pairs.set(newOid, oldOid)
	}
	return pairs
}

function buildPack(entries: PackEntry[]): Buffer {
	const header = Buffer.alloc(12)
	header.write("PACK", 0, "latin1")
	header.writeUInt32BE(2, 4)
	header.writeUInt32BE(entries.length, 8)
	const parts: Buffer[] = [header]
	for (const e of entries) {
		if (e.kind === "base") {
			parts.push(encodeObjectHeader(PACK_TYPE_CODE[e.type], e.content.length))
			parts.push(deflateSync(e.content))
		} else {
			parts.push(encodeObjectHeader(PACK_OBJ_TYPE.REF_DELTA, e.delta.length))
			parts.push(Buffer.from(e.baseOid, "hex"))
			parts.push(deflateSync(e.delta))
		}
	}
	const body = Buffer.concat(parts)
	return Buffer.concat([body, createHash("sha1").update(body).digest()])
}

type Verdict = {
	repo: string
	objects: number
	deltified: number
	roundTripFailures: string[]
	undeltifiedBytes: number
	ourBytes: number
	gitGcBytes: number
	gitRecoveryFailures: string[]
}

async function verifyRepo(repo: string, scratch: string[]): Promise<Verdict> {
	// Never work on the caller's repository: `git gc` below rewrites whatever it is
	// pointed at, and a customer mirror must stay byte-for-byte pristine. A MIRROR
	// clone (not a directory copy) takes every ref and object and no working tree —
	// so pointing this at a dev checkout does not copy its node_modules — and
	// `--no-hardlinks` keeps the clone's object files physically its own, so the
	// aggressive gc cannot reach back into the source's store.
	const work = join(mkdtempSync(join(tmpdir(), "pggit-corpus-")), "repo.git")
	scratch.push(work)
	await spawnGit(["clone", "--mirror", "--no-hardlinks", "-q", repo, work])

	const objects = await reachableObjects(work)
	const byOid = new Map(objects.map((o) => [o.oid, o]))
	const pairs = await basePairs(work)

	const roundTripFailures: string[] = []
	const entries: PackEntry[] = []
	let undeltifiedBytes = 0
	let ourBytes = 0
	let deltified = 0

	// A real history can pair A→B AND B→A (a file toggling between two contents),
	// and emitting both as deltas is an unresolvable cycle — observed at 5 pairs on
	// pggit's own history. The SHIPPED repack cannot produce this (its star
	// invariant makes every base a whole encoding), but this harness models
	// unconstrained chains, so it must break cycles itself: an object whose pair
	// chain leads back to it ships whole.
	const inCycle = (start: string): boolean => {
		const seen = new Set<string>([start])
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
			ourBytes += whole.length
			continue
		}

		const delta = encodeDelta(base.content, o.content)
		// Property 1 — the encoder's own contract, on real content.
		if (!applyDelta(base.content, delta).equals(o.content)) {
			roundTripFailures.push(`${o.type} ${o.oid} (base ${base.oid})`)
			entries.push({ content: o.content, kind: "base", type: o.type })
			ourBytes += whole.length
			continue
		}
		const encoded = deflateSync(delta)
		if (encoded.length < whole.length) {
			entries.push({ baseOid: base.oid, delta, kind: "ref" })
			ourBytes += encoded.length
			deltified++
		} else {
			entries.push({ content: o.content, kind: "base", type: o.type })
			ourBytes += whole.length
		}
	}

	// Property 2 — canonical git must ingest the pack and recover every object.
	// A REF_DELTA base must precede nothing in particular, but it MUST be present;
	// bases here are always other entries of the same pack, so the pack is self-contained.
	const sink = join(mkdtempSync(join(tmpdir(), "pggit-corpus-sink-")), "repo")
	scratch.push(sink)
	mkdirSync(sink) // spawn reports a missing cwd as `spawn git ENOENT`
	await spawnGit(["init", "-q", "-b", "main"], { cwd: sink })
	await spawnGit(["index-pack", "--stdin", "--fix-thin"], {
		cwd: sink,
		input: buildPack(entries),
	})
	await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: sink })

	const gitRecoveryFailures: string[] = []
	const check = await spawnGit(["cat-file", "--batch"], {
		cwd: sink,
		input: `${objects.map((o) => o.oid).join("\n")}\n`,
	})
	const buf = check.stdoutBytes
	let pos = 0
	for (const expected of objects) {
		const nl = buf.indexOf(0x0a, pos)
		if (nl < 0) {
			gitRecoveryFailures.push(`${expected.oid} (truncated)`)
			break
		}
		const [oid, , sizeStr] = buf.subarray(pos, nl).toString("latin1").split(" ")
		const size = Number(sizeStr)
		const start = nl + 1
		if (
			oid !== expected.oid ||
			!buf.subarray(start, start + size).equals(expected.content)
		) {
			gitRecoveryFailures.push(expected.oid)
		}
		pos = start + size + 1
	}

	// Property 3 — the quality benchmark.
	await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: work })
	const gitGcBytes =
		Number(
			(await spawnGit(["count-objects", "-v"], { cwd: work })).stdout.match(
				/size-pack: (\d+)/,
			)?.[1] ?? 0,
		) * 1024

	return {
		deltified,
		gitGcBytes,
		gitRecoveryFailures,
		objects: objects.length,
		ourBytes,
		repo,
		roundTripFailures,
		undeltifiedBytes,
	}
}

async function main(): Promise<void> {
	const scratch: string[] = []
	const verdicts: Verdict[] = []
	try {
		for (const repo of repoArgs()) {
			console.log(`\n## ${repo}`)
			const v = await verifyRepo(repo, scratch)
			verdicts.push(v)
			console.log(`objects ${v.objects}, deltified ${v.deltified}`)
			console.log(
				`undeltified ${mb(v.undeltifiedBytes)} → ours ${mb(v.ourBytes)} ` +
					`(${(v.undeltifiedBytes / v.ourBytes).toFixed(1)}×) · git gc ${mb(v.gitGcBytes)} ` +
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
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
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

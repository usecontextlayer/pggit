/**
 * Shared plumbing for the `perf/probes/perf/*.ts` probes. The helpers drive real Git and pggit surfaces, then use explicit store censuses where a named fixture must prove its internal preconditions. Malformed Git output, incomplete seed coverage, invalid CLI scales, missing subprocess metrics, and undersampled RSS all abort a probe before it can score a number.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { peakOf, rssBytes, startRssSampler } from "@perf/memory"
import postgresFactory, { type Sql } from "postgres"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import {
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	type GitObjectWithOid,
	loadAllReachableObjects,
	packFileBytes,
	repackEligibleObjects,
	requiredAt,
	seedGitRefs,
} from "@/testing/git-fixtures"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"

export const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)}`
export const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}`

/** A schema-scoped client that counts queries and their normalized SQL shapes. */
export function queryCountingClient(
	pgUrl: string,
	schema: string,
): { sql: Sql; counter: { byShape: Map<string, number>; queries: number } } {
	const counter = { byShape: new Map<string, number>(), queries: 0 }
	const sql = postgresFactory(pgUrl, {
		connection: { search_path: schema },
		debug: (_id, query) => {
			counter.queries++
			const shape = query.trim().replace(/\s+/g, " ").slice(0, 46)
			counter.byShape.set(shape, (counter.byShape.get(shape) ?? 0) + 1)
		},
		max: 4,
		onnotice: () => {},
	})
	return { counter, sql }
}

function deterministicNoise(salt: string, length: number): Buffer {
	const parts: Buffer[] = []
	let total = 0
	let index = 0
	while (total < length) {
		const part = createHash("sha256").update(`${salt}-${index++}`).digest()
		parts.push(part)
		total += part.length
	}
	return Buffer.concat(parts).subarray(0, length)
}

/** Successive whole versions of one artifact, each carrying a distinct 200-byte edit. */
export function rewrittenArtifactStream(options: {
	blobBytes: number
	versions: number
}): Buffer {
	const parts: Buffer[] = []
	const base = deterministicNoise("artifact", options.blobBytes)
	type CommitParent = { kind: "root" } | { kind: "child"; mark: number }
	let parent: CommitParent = { kind: "root" }
	let mark = 0
	for (let version = 0; version < options.versions; version++) {
		const body = Buffer.from(base)
		deterministicNoise(`edit-${version}`, 200).copy(body, version * 1000)
		const blobMark = ++mark
		parts.push(
			Buffer.from(`blob\nmark :${blobMark}\ndata ${body.length}\n`),
			body,
			Buffer.from("\n"),
		)
		const commitMark = ++mark
		const message = `v${version}`
		parts.push(
			Buffer.from(
				`commit refs/heads/main\nmark :${commitMark}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${message.length}\n${message}\n` +
					(parent.kind === "root" ? "" : `from :${parent.mark}\n`) +
					`M 100644 :${blobMark} data/artifact.bin\n`,
			),
		)
		parent = { kind: "child", mark: commitMark }
	}
	return Buffer.concat(parts)
}

const scratch = createScratchArena()
export const mkTmp = scratch.make
export const cleanupTmp = scratch.cleanup

/** Peak-RSS sampler around an async call — process-wide RSS sampled off-thread so synchronous encoding work cannot hide its own peak. */
export async function withPeakRss<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; ms: number; peakRss: number; baseRss: number }> {
	const baseRss = process.memoryUsage().rss
	const sampler = startRssSampler()
	const t0 = Date.now()
	const outcome = requiredAt(
		await Promise.allSettled([Promise.resolve().then(fn)]),
		0,
		"peak-RSS measured operation",
	)
	const ms = Date.now() - t0
	const series = await sampler.stop()
	if (outcome.status === "rejected") throw outcome.reason
	return {
		baseRss,
		ms,
		peakRss: peakOf(rssBytes(series)),
		value: outcome.value,
	}
}

/** Run a command under `/usr/bin/time -l` and return wall ms + peak RSS bytes. */
export async function timedSpawn(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<{ ms: number; peakRss: number }> {
	const t0 = Date.now()
	return await new Promise((resolve, reject) => {
		const child = spawn("/usr/bin/time", ["-l", cmd, ...args], {
			cwd,
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		})
		let err = ""
		child.stderr.on("data", (c: Buffer) => {
			err += c.toString()
		})
		child.stdout.on("data", () => {})
		child.on("error", reject)
		child.on("close", (code, signal) => {
			if (code === null) {
				reject(new Error(`${cmd} was terminated by signal ${signal ?? "unknown"}`))
				return
			}
			if (code !== 0) {
				reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))
				return
			}
			const m = err.match(/(\d+)\s+maximum resident set size/)
			if (m?.[1] === undefined) {
				reject(new Error(`/usr/bin/time did not report maximum RSS for ${cmd}: ${err}`))
				return
			}
			resolve({ ms: Date.now() - t0, peakRss: Number(m[1]) })
		})
	})
}

/** `git repack -adf` on a COPY of the repo: wall, peak RSS, resulting pack bytes. */
export async function gitRepack(
	srcDir: string,
	tag: string,
	extraArgs: string[] = [],
): Promise<{ ms: number; peakRss: number; packBytes: number }> {
	const dir = join(mkTmp(tag), "repo")
	cpSync(srcDir, dir, { recursive: true })
	const r = await timedSpawn("git", ["repack", "-adf", "-q", ...extraArgs], dir)
	return { ms: r.ms, packBytes: await packFileBytes(dir), peakRss: r.peakRss }
}

/** Seed a real repo's objects + refs into a pggit schema through the public store. */
export async function seedRepo(
	sql: Sql,
	repoId: string,
	dir: string,
	objects?: GitObjectWithOid[],
): Promise<{ objects: number; eligibleObjects: number; rawBytes: number; ms: number }> {
	const objs = objects ?? (await loadAllReachableObjects(dir))
	if (objs.length === 0) throw new Error(`cannot seed empty repository ${dir}`)
	const store = createObjectStore(sql)
	const refs = createRefStore(sql)
	const t0 = Date.now()
	await store.putPack(repoId, objs)
	const rawBytes = objs.reduce((total, object) => total + object.content.length, 0)
	await seedGitRefs(repoId, dir, refs)
	await assertCanonicalStoreFixture(sql, repoId, {
		encodings: { kind: "exact", objects: [] },
		objects: objs,
		refs: await canonicalStoreRefsOf(dir),
	})
	return {
		eligibleObjects: repackEligibleObjects(objs).length,
		ms: Date.now() - t0,
		objects: objs.length,
		rawBytes,
	}
}

/** Build a repo from a raw fast-import stream. */
export async function importRepo(tag: string, stream: string): Promise<string> {
	const dir = join(mkTmp(tag), "repo")
	mkdirSync(dir, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: stream })
	return dir
}

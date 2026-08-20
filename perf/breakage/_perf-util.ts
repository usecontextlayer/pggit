/**
 * Shared plumbing for the `perf/breakage/perf--*.ts` probes. The helpers drive real Git and pggit surfaces, then use explicit store censuses where a named fixture must prove its internal preconditions. Malformed Git output, incomplete seed coverage, invalid CLI scales, missing subprocess metrics, and undersampled RSS all abort a probe before it can score a number.
 */
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Sql } from "postgres"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { gitReachableOids, loadGitObjects, seedGitRefs } from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"
import { peakOf, startRssSampler } from "../memory"

export { flag, increasingIntegerListFlag, positiveIntegerFlag } from "../args"

import { flag } from "../args"

export const PG_URL = flag("pg", "postgres://postgres:postgres@localhost:6489/postgres")

export const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)}`
export const secs = (ms: number): string => `${(ms / 1000).toFixed(2)}`

const scratch: string[] = []
export function mkTmp(tag: string): string {
	const d = mkdtempSync(join(tmpdir(), `pggit-breakage-${tag}-`))
	scratch.push(d)
	return d
}
export function cleanupTmp(): void {
	for (const d of scratch.splice(0)) rmSync(d, { force: true, recursive: true })
}

/** Peak-RSS sampler around an async call — process-wide RSS sampled off-thread so synchronous encoding work cannot hide its own peak. */
export async function withPeakRss<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; ms: number; peakRss: number; baseRss: number }> {
	const baseRss = process.memoryUsage().rss
	const sampler = startRssSampler()
	const t0 = Date.now()
	let outcome: { ok: true; value: T } | { ok: false; error: unknown }
	try {
		outcome = { ok: true, value: await fn() }
	} catch (error) {
		outcome = { error, ok: false }
	}
	const ms = Date.now() - t0
	const series = await sampler.stop()
	if (!outcome.ok) throw outcome.error
	return {
		baseRss,
		ms,
		peakRss: peakOf(series.map(([, rss]) => rss)),
		value: outcome.value,
	}
}

/** Run a command under `/usr/bin/time -l` and return wall ms + peak RSS bytes. */
export async function timedSpawn(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<{ ms: number; peakRss: number; code: number }> {
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
			resolve({ code, ms: Date.now() - t0, peakRss: Number(m[1]) })
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
	const out = await spawnGit(["count-objects", "-v"], { cwd: dir })
	const size = out.stdout.match(/^size-pack: (\d+)$/m)?.[1]
	if (size === undefined) {
		throw new Error(`git count-objects did not report size-pack:\n${out.stdout}`)
	}
	const kb = Number(size)
	return { ms: r.ms, packBytes: kb * 1024, peakRss: r.peakRss }
}

export type Obj = { oid: string; type: string; content: Buffer }

/** Every reachable object of a repo, via ONE `git cat-file --batch`. */
export async function reachableObjects(dir: string): Promise<Obj[]> {
	return loadGitObjects(dir, await gitReachableOids(dir))
}

/** Seed a real repo's objects + refs into a pggit schema through the public store. */
export async function seedRepo(
	sql: Sql,
	repoId: string,
	dir: string,
	objects?: Obj[],
): Promise<{ objects: number; rawBytes: number; ms: number }> {
	const objs = objects ?? (await reachableObjects(dir))
	if (objs.length === 0) throw new Error(`cannot seed empty repository ${dir}`)
	const store = createObjectStore(sql)
	const refs = createRefStore(sql)
	const t0 = Date.now()
	let batch: Obj[] = []
	let bytes = 0
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return
		await store.putPack(
			repoId,
			batch.map((o) => ({
				content: o.content,
				type: o.type as "blob" | "commit" | "tag" | "tree",
			})),
		)
		batch = []
		bytes = 0
	}
	let rawBytes = 0
	for (const o of objs) {
		rawBytes += o.content.length
		batch.push(o)
		bytes += o.content.length
		if (bytes >= 16_000_000 || batch.length >= 20_000) await flush()
	}
	await flush()
	const seededRefs = await seedGitRefs(repoId, dir, refs)
	// `repoId` is the WIRE NAME; the census reads by the bigint surrogate.
	const [repoRow] = await sql<{ id: string }[]>`
		select id::text as id from repos where name = ${repoId}`
	if (repoRow === undefined) throw new Error(`seeded repo ${repoId} has no repos row`)
	const [census] = await sql<
		{ objects: string; commits: string; tags: string; refs: string }[]
	>`select
		(select count(*) from git_object where repo_id = ${repoRow.id}::bigint)::text as objects,
		(select count(*) from git_commit where repo_id = ${repoRow.id}::bigint)::text as commits,
		(select count(*) from git_tag where repo_id = ${repoRow.id}::bigint)::text as tags,
		(select count(*) from git_ref where repo_id = ${repoRow.id}::bigint)::text as refs`
	if (census === undefined) throw new Error(`seed census returned no row for ${repoId}`)
	const expected = {
		commits: objs.filter((object) => object.type === "commit").length,
		objects: objs.length,
		refs: seededRefs.directRefs + 1,
		tags: objs.filter((object) => object.type === "tag").length,
	}
	const actual = {
		commits: Number(census.commits),
		objects: Number(census.objects),
		refs: Number(census.refs),
		tags: Number(census.tags),
	}
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`seed census mismatch for ${repoId}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		)
	}
	return { ms: Date.now() - t0, objects: objs.length, rawBytes }
}

/** Build a repo from a raw fast-import stream. */
export async function importRepo(tag: string, stream: string): Promise<string> {
	const dir = join(mkTmp(tag), "repo")
	mkdirSync(dir, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: stream })
	return dir
}

/** A row of any probe's result table. */
export function table(headers: string[], rows: (string | number)[][]): string {
	const all = [headers, ...rows.map((r) => r.map(String))]
	const w = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)))
	const line = (r: string[]): string =>
		`| ${r.map((c, i) => c.padEnd(w[i] as number)).join(" | ")} |`
	return [
		line(headers),
		`|${w.map((n) => "-".repeat(n + 2)).join("|")}|`,
		...all.slice(1).map(line),
	].join("\n")
}

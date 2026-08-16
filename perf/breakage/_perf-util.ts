/**
 * Shared plumbing for the `perf/breakage/perf--*.ts` probes. Black-box only: every
 * helper drives a public surface (real `git`, `createObjectStore.putPack`,
 * `createRepack().repack()`, the wire server) and observes wall time, process
 * RSS, and byte counts. Nothing here reaches into pggit internals.
 *
 * Ported verbatim from `breakage/_perf-util.ts`; the one addition is the `flag`
 * reader so every probe takes `--pg=` the way `perf/delta-probe.ts` does.
 */
import { spawn } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { spawnGit } from "@/testing/spawn-git"

/** `--name=value` off argv, the same reader `perf/delta-probe.ts` uses. */
export function flag(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}

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

/** Peak-RSS sampler around an async call — the honest in-process memory number
 * (`process.memoryUsage().rss` sampled while the work runs, not just after). */
export async function withPeakRss<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; ms: number; peakRss: number; baseRss: number }> {
	globalThis.gc?.()
	await new Promise((r) => setTimeout(r, 30))
	const baseRss = process.memoryUsage().rss
	let peakRss = baseRss
	const timer = setInterval(() => {
		const rss = process.memoryUsage().rss
		if (rss > peakRss) peakRss = rss
	}, 25)
	const t0 = Date.now()
	try {
		const value = await fn()
		return { baseRss, ms: Date.now() - t0, peakRss, value }
	} finally {
		clearInterval(timer)
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
		child.on("close", (code) => {
			const m = err.match(/(\d+)\s+maximum resident set size/)
			resolve({ code: code ?? 0, ms: Date.now() - t0, peakRss: Number(m?.[1] ?? 0) })
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
	const kb = Number(out.stdout.match(/size-pack: (\d+)/)?.[1] ?? 0)
	return { ms: r.ms, packBytes: kb * 1024, peakRss: r.peakRss }
}

export type Obj = { oid: string; type: string; content: Buffer }

/** Every reachable object of a repo, via ONE `git cat-file --batch`. */
export async function reachableObjects(dir: string): Promise<Obj[]> {
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
		objs.push({ content: buf.subarray(start, start + size), oid, type })
		pos = start + size + 1
	}
	return objs
}

/** Seed a real repo's objects + refs into a pggit schema through the public store. */
export async function seedRepo(
	// biome-ignore lint/suspicious/noExplicitAny: porsager Sql, kept structural for the probes
	sql: any,
	repoId: string,
	dir: string,
	objects?: Obj[],
): Promise<{ objects: number; rawBytes: number; ms: number }> {
	const objs = objects ?? (await reachableObjects(dir))
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
	for (const line of (await spawnGit(["show-ref", "--heads"], { cwd: dir })).stdout
		.trim()
		.split("\n")) {
		const [oid, name] = line.split(" ")
		if (oid && name) await refs.setRef(repoId, name, oid)
	}
	const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: dir })).stdout.trim()
	if (head) await refs.setSymref(repoId, "HEAD", head)
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

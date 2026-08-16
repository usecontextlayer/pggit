/**
 * Shared plumbing for the `realrepo--*` breakage harnesses.
 *
 * These drive REAL repository history (this checkout, `trove`, `web`, a customer
 * mirror) through the pggit wire, so the one thing they must never do is touch the
 * repository they are pointed at: they `git push` from it, `git config` it, and `git
 * gc` the oracles built from it. `prepareMirror` is the single door — every harness
 * resolves `--repo=` / `--mirror=` through it and works on the private clone it
 * returns, so a source checkout stays byte-for-byte pristine.
 *
 * Everything here is mechanical (arg parsing, scratch dirs, a git call that reports
 * failure instead of throwing, a findings ledger). The measurements, thresholds and
 * oracle comparisons live in the harness that owns them.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

/** The shared docker-compose Postgres every perf harness defaults to. */
export const DEFAULT_PG_URL = "postgres://postgres:postgres@localhost:6489/postgres"

export function flag(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}

export const kb = (n: number): string => `${(n / 1000).toFixed(0)} KB`
export const mb = (n: number): string => `${(n / 1_000_000).toFixed(2)} MB`
export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export type Scratch = {
	/** A fresh temp directory, remembered so `cleanup()` can remove it. */
	mk: (tag: string) => string
	cleanup: () => void
}

export function createScratch(prefix: string): Scratch {
	const dirs: string[] = []
	return {
		cleanup: () => {
			for (const d of dirs) rmSync(d, { force: true, recursive: true })
		},
		mk: (tag: string) => {
			const d = mkdtempSync(join(tmpdir(), `${prefix}-${tag}-`))
			dirs.push(d)
			return d
		},
	}
}

/**
 * Resolve `--repo=<path>` (or `--mirror=<bare.git>`) into a PRIVATE bare mirror in
 * scratch, and hand back that path.
 *
 * Never work on the caller's repository: these harnesses push from it, write
 * `uploadpack.*` config into it, and `git gc` what they build out of it — and a
 * customer mirror or a live checkout must stay byte-for-byte pristine. A MIRROR
 * clone (not a directory copy) takes every ref and object and no working tree — so
 * pointing this at a dev checkout does not copy its node_modules — and
 * `--no-hardlinks` keeps the clone's object files physically its own, so nothing
 * here can reach back into the source's store.
 */
export async function prepareMirror(scratch: Scratch): Promise<string> {
	const source = flag("repo", "") || flag("mirror", "")
	if (!source) throw new Error("--repo=<path> (or --mirror=<bare.git>) is required")
	const work = join(scratch.mk("mirror"), "source.git")
	await spawnGit(["clone", "--mirror", "--no-hardlinks", "-q", source, work])
	return work
}

export type GitOutcome = { ok: boolean; code: number; stdout: string; stderr: string }

/** `spawnGit`, but a non-zero exit is an OUTCOME to compare against the oracle's,
 * not a throw — "pggit rejected what git accepted" is the finding these harnesses
 * exist to catch, and it is only visible if both sides report their exit code. */
export async function tryGit(
	args: string[],
	cwd?: string,
	input?: string,
): Promise<GitOutcome> {
	try {
		const r = await spawnGit(args, { cwd, input })
		return { code: 0, ok: true, stderr: r.stderr, stdout: r.stdout }
	} catch (err) {
		if (err instanceof GitCommandError) {
			return { code: err.code, ok: false, stderr: err.stderr, stdout: err.stdout }
		}
		throw err
	}
}

export type Ledger = {
	findings: string[]
	report: string[]
	fail: (what: string, detail: string) => void
}

/** Findings are collected, printed as they happen, and re-printed at the end; the
 * harness exits non-zero when the ledger is non-empty. */
export function createLedger(slug: string): Ledger {
	const findings: string[] = []
	const report: string[] = []
	return {
		fail: (what: string, detail: string): void => {
			findings.push(`${what}: ${detail}`)
			console.log(`\n!! FINDING [${slug}] ${what}\n   ${detail}\n`)
		},
		findings,
		report,
	}
}

/** Every object git can name in a repo — the set a clone must reproduce exactly. */
export async function oidSet(dir: string): Promise<Set<string>> {
	const out = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
		{ cwd: dir },
	)
	return new Set(out.stdout.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l)))
}

/** Total `.pack` bytes on disk — with `fetch.unpackLimit=1` this is exactly what the
 * remote put on the wire, since git keeps the received pack instead of exploding it. */
export function packBytesOnDisk(bareDir: string): number {
	const dir = join(bareDir, "objects", "pack")
	let total = 0
	for (const f of readdirSync(dir)) {
		if (f.endsWith(".pack")) total += statSync(join(dir, f)).size
	}
	return total
}

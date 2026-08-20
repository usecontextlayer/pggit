import { spawn } from "node:child_process"

type SpawnGitResult = {
	code: number
	stdout: string
	/** Raw stdout bytes — use this for binary git output (packs, tree objects). */
	stdoutBytes: Buffer
	stderr: string
}

type SpawnGitOptions = {
	cwd?: string
	/** Bytes to write to git's stdin (e.g. rev-list args for `pack-objects --revs`). */
	input?: Buffer | string
}

export type SpawnGitBoundedResult =
	| { settled: true; code: number; out: string }
	| { settled: false; code: null; out: string }

/**
 * Pinned author/committer identity + clock. Commit/tag OIDs are a hash of the
 * identity strings and the timestamps, so the generative differential (spec §8.4)
 * can only match OIDs on both sides if BOTH the oracle git and our seeding DSL
 * use exactly these values. The seeding DSL's fixed clock must match `PINNED_DATE`.
 */
export const PINNED_IDENTITY = {
	email: "oracle@pggit.test",
	name: "pggit oracle",
} as const
export const PINNED_DATE = "@1700000000 +0000" as const

// Git config that must be neutralized for reproducible, side-effect-free runs:
// no auto-gc/maintenance mutating the store mid-test.
const PINNED_CONFIG_ARGS = [
	"-c",
	"gc.auto=0",
	"-c",
	"gc.autoDetach=false",
	"-c",
	"maintenance.auto=false",
]

// Build an isolated env: drop every inherited GIT_* var (so a parent shell can't
// leak GIT_DIR/GIT_CONFIG/etc.), then set our pinned identity, clock, and the
// config-isolation switches (no system/global gitconfig → no gpgsign, autocrlf,
// defaultBranch surprises). PATH/HOME are kept so `git` is found.
export function buildGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value
	}
	return {
		...env,
		GIT_AUTHOR_DATE: PINNED_DATE,
		GIT_AUTHOR_EMAIL: PINNED_IDENTITY.email,
		GIT_AUTHOR_NAME: PINNED_IDENTITY.name,
		GIT_COMMITTER_DATE: PINNED_DATE,
		GIT_COMMITTER_EMAIL: PINNED_IDENTITY.email,
		GIT_COMMITTER_NAME: PINNED_IDENTITY.name,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		LC_ALL: "C",
		TZ: "UTC",
	}
}

export class GitCommandError extends Error {
	constructor(
		readonly args: string[],
		readonly code: number,
		readonly stdout: string,
		readonly stderr: string,
	) {
		super(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`)
		this.name = "GitCommandError"
	}
}

type GitAttempt = { ok: boolean; code: number; stdout: string; stderr: string }

/** Run Git when an ordinary nonzero exit is data, while preserving infrastructure faults. */
export async function attemptGit(args: string[], cwd?: string): Promise<GitAttempt> {
	try {
		const result = await spawnGit(args, { cwd })
		return { code: result.code, ok: true, stderr: result.stderr, stdout: result.stdout }
	} catch (error) {
		if (!(error instanceof GitCommandError) || error.code < 1) throw error
		return {
			code: error.code,
			ok: false,
			stderr: error.stderr,
			stdout: error.stdout,
		}
	}
}

/** Run Git with a hard wall-clock bound, preserving ordinary nonzero exits as data. */
export function spawnGitBounded(
	args: string[],
	cwd: string,
	limitMs: number,
): Promise<SpawnGitBoundedResult> {
	const fullArgs = [...PINNED_CONFIG_ARGS, ...args]
	return new Promise((resolve, reject) => {
		const child = spawn("git", fullArgs, { cwd, env: buildGitEnv() })
		let out = ""
		let finished = false
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8")
		})
		child.stderr.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8")
		})
		const timer = setTimeout(() => {
			if (finished) return
			finished = true
			child.kill("SIGKILL")
			resolve({ code: null, out, settled: false })
		}, limitMs)
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED" || finished)
				return
			finished = true
			clearTimeout(timer)
			reject(error)
		})
		child.stdin.end()
		child.on("error", (error) => {
			if (finished) return
			finished = true
			clearTimeout(timer)
			reject(error)
		})
		child.on("close", (code, signal) => {
			if (finished) return
			finished = true
			clearTimeout(timer)
			if (code !== null) {
				resolve({ code, out, settled: true })
				return
			}
			reject(new GitCommandError(args, -1, out, `killed by ${signal ?? "signal"}`))
		})
	})
}

/**
 * Spawn the real `git` binary and capture its result. This is the foundation of
 * the verifiable-rewards rig: every oracle assertion runs canonical git through
 * here. See the design spec §8.6.
 */
export async function spawnGit(
	args: string[],
	opts: SpawnGitOptions = {},
): Promise<SpawnGitResult> {
	const fullArgs = [...PINNED_CONFIG_ARGS, ...args]
	return new Promise((resolve, reject) => {
		const child = spawn("git", fullArgs, {
			cwd: opts.cwd,
			env: buildGitEnv(),
		})
		// git may close its stdin before we finish writing/ending it (it already has what
		// it needs — e.g. a rejected push), surfacing a benign EPIPE/EOF on our write. The
		// real outcome is the exit code via 'close' below, so that case is ignored; without
		// any handler the stream error would crash the worker and (under the test pool) be
		// pinned on an unrelated later test. Any OTHER stdin error is a genuine fault — fail
		// loud by rejecting.
		child.stdin.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") reject(err)
		})
		if (opts.input !== undefined) child.stdin.write(opts.input)
		child.stdin.end()

		const stdout: Buffer[] = []
		const stderr: Buffer[] = []

		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
		child.on("error", reject)
		child.on("close", (rawCode, signal) => {
			const outBytes = Buffer.concat(stdout)
			const out = outBytes.toString("utf8")
			const err = Buffer.concat(stderr).toString("utf8")
			// A null exit code means the child died by SIGNAL — never success. A
			// killed fsck/index-pack/clone that resolved as exit 0 would launder
			// incomplete output into a green oracle.
			if (rawCode === null) {
				reject(
					new GitCommandError(args, -1, out, `killed by ${signal ?? "signal"}: ${err}`),
				)
				return
			}
			if (rawCode !== 0) {
				reject(new GitCommandError(args, rawCode, out, err))
				return
			}
			resolve({ code: rawCode, stderr: err, stdout: out, stdoutBytes: outBytes })
		})
	})
}

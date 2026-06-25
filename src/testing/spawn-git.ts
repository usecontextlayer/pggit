import { spawn } from "node:child_process"

export type SpawnGitResult = {
	code: number
	stdout: string
	/** Raw stdout bytes — use this for binary git output (packs, tree objects). */
	stdoutBytes: Buffer
	stderr: string
}

export type SpawnGitOptions = {
	cwd?: string
	/** Bytes to write to git's stdin (e.g. rev-list args for `pack-objects --revs`). */
	input?: Buffer | string
}

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
function buildGitEnv(): NodeJS.ProcessEnv {
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
		child.on("close", (rawCode) => {
			const code = rawCode ?? 0
			const outBytes = Buffer.concat(stdout)
			const out = outBytes.toString("utf8")
			const err = Buffer.concat(stderr).toString("utf8")
			if (code !== 0) {
				reject(new GitCommandError(args, code, out, err))
				return
			}
			resolve({ code, stderr: err, stdout: out, stdoutBytes: outBytes })
		})
	})
}

/**
 * A real git repository with the shape that makes undeltified serving expensive: a
 * single flat directory that gains one entry per commit, so every commit rewrites a
 * tree that grows linearly and the history's tree bytes grow QUADRATICALLY.
 *
 * This is CodeCreators' `komal` workspace repo in miniature (`.engine/runs/…`, one
 * run directory per synthesizer run), and it is the fixture the delta work is judged
 * on: correctness generalizes from fuzzing, but the SIZE properties only mean
 * something against the shape that actually occurs.
 *
 * Built with `git fast-import` (one process, no per-commit spawn) under the pinned
 * identity and clock, so the object set is byte-reproducible run to run.
 */
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requireGitOid } from "@/testing/git-fixtures"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`

/** The flat, append-only directory whose tree object is the expensive one. */
export const RUNS_DIR = ".engine/runs/planner-updates"

export type AppendOnlyRepoOptions = {
	/** Commits that append a run directory (each adds two blobs + a subtree). */
	runs: number
	/** Files in the `docs/` tree laid down by the seeding commit. */
	docs?: number
}

/** Deterministic filler of a given length (hex, so it is poorly compressible). */
function filler(salt: string, len: number): string {
	let out = ""
	while (out.length < len) {
		out += createHash("sha1").update(`${salt}-${out.length}`).digest("hex")
	}
	return out.slice(0, len)
}

/** A uuid-shaped run directory name — 36 chars, so a tree entry costs ~63 bytes,
 * which is what the real repo measures. */
export function runDirName(i: number): string {
	const h = createHash("sha1").update(`run-${i}`).digest("hex")
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function buildStream(opts: Required<AppendOnlyRepoOptions>): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (content: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return m
	}

	const seeded: string[] = []
	for (let i = 0; i < opts.docs; i++) {
		const m = blob(`# doc ${i}\n\n${filler(`doc-${i}-v0`, 800)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)

	for (let i = 0; i < opts.runs; i++) {
		const dir = runDirName(i)
		const record = blob(`{"run":"${dir}","payload":"${filler(`rec-${i}`, 400)}"}\n`)
		const stderr = blob(`${filler(`err-${i}`, 120)}\n`)
		const cm = next()
		const msg = `run ${i}`
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${prev}\n` +
				`M 100644 :${record} ${RUNS_DIR}/${dir}/record.json\n` +
				`M 100644 :${stderr} ${RUNS_DIR}/${dir}/stderr\n`,
		)
		prev = cm
	}
	return out.join("")
}

/** Create the repository in a fresh temp dir and return its path. The caller owns
 * cleanup (`rmSync(dir, { recursive: true, force: true })`). */
export async function createAppendOnlyRepo(opts: AppendOnlyRepoOptions): Promise<string> {
	const resolved = { docs: opts.docs ?? 8, runs: opts.runs }
	const dir = mkdtempSync(join(tmpdir(), "pggit-append-only-"))
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: buildStream(resolved) })
	return dir
}

/** The OID of the append-only directory's tree at a given revision — the object whose
 * successive versions the delta encoder must collapse. */
export async function runsTreeAt(dir: string, rev: string): Promise<string> {
	const out = await spawnGit(["rev-parse", `${rev}:${RUNS_DIR}`], { cwd: dir })
	return requireGitOid(out.stdout.trim(), `rev-parse ${rev}:${RUNS_DIR}`)
}

/** Commit OIDs oldest-first. */
export async function commitsOldestFirst(dir: string): Promise<string[]> {
	const out = await spawnGit(["rev-list", "--reverse", "HEAD"], { cwd: dir })
	return out.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((oid) => requireGitOid(oid, "rev-list --reverse HEAD"))
}

/** One object's raw bytes, binary-safe. */
export async function readObject(
	dir: string,
	oid: string,
	type: string,
): Promise<Buffer> {
	return (await spawnGit(["cat-file", type, oid], { cwd: dir })).stdoutBytes
}

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
import type { Oid } from "@/object/oid"
import { parseRevListObjectOids, requireGitOid } from "@/testing/git-fixtures"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
export const FAST_IMPORT_COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`

/** The flat, append-only directory whose tree object is the expensive one. */
export const RUNS_DIR = ".engine/runs/planner-updates"

type AppendOnlyRepoOptions = {
	/** Commits that append a run directory (each adds two blobs + a subtree). */
	runs: number
	/** Files in the `docs/` tree laid down by the seeding commit. */
	docs?: number
}

/** Deterministic filler of a given length (hex, so it is poorly compressible). */
export function deterministicFiller(salt: string, len: number): string {
	let out = ""
	while (out.length < len) {
		out += createHash("sha1").update(`${salt}-${out.length}`).digest("hex")
	}
	return out.slice(0, len)
}

/** A deterministic UUID-shaped name derived from `seed`. */
export function uuidFromSeed(seed: string): string {
	const h = createHash("sha1").update(seed).digest("hex")
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

class FastImportStream {
	readonly #chunks: string[] = []
	#mark = 0

	append(chunk: string): void {
		this.#chunks.push(chunk)
	}

	nextMark(): number {
		return ++this.#mark
	}

	blob(content: string): number {
		const mark = this.nextMark()
		this.append(`blob\nmark :${mark}\ndata ${Buffer.byteLength(content)}\n${content}\n`)
		return mark
	}

	render(): string {
		return this.#chunks.join("")
	}
}

/** A uuid-shaped run directory name — 36 chars, so a tree entry costs ~63 bytes,
 * which is what the real repo measures. */
export function runDirName(i: number): string {
	return uuidFromSeed(`run-${i}`)
}

function buildStream(opts: Required<AppendOnlyRepoOptions>): string {
	const stream = new FastImportStream()

	const seeded: string[] = []
	for (let i = 0; i < opts.docs; i++) {
		const m = stream.blob(`# doc ${i}\n\n${deterministicFiller(`doc-${i}-v0`, 800)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = stream.nextMark()
	stream.append(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)

	for (let i = 0; i < opts.runs; i++) {
		const dir = runDirName(i)
		const record = stream.blob(
			`{"run":"${dir}","payload":"${deterministicFiller(`rec-${i}`, 400)}"}\n`,
		)
		const stderr = stream.blob(`${deterministicFiller(`err-${i}`, 120)}\n`)
		const cm = stream.nextMark()
		const msg = `run ${i}`
		stream.append(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${msg.length}\n${msg}\nfrom :${prev}\n` +
				`M 100644 :${record} ${RUNS_DIR}/${dir}/record.json\n` +
				`M 100644 :${stderr} ${RUNS_DIR}/${dir}/stderr\n`,
		)
		prev = cm
	}
	return stream.render()
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

/** Build the fixed append-only source shared by the lifecycle breakage suites. */
export async function buildLifecycleSource(
	dir: string,
	mainCommits: number,
): Promise<void> {
	const stream = new FastImportStream()

	const seeded: string[] = []
	for (let i = 0; i < 6; i++) {
		const m = stream.blob(`# doc ${i}\n\n${deterministicFiller(`doc-${i}-v0`, 600)}\n`)
		seeded.push(`M 100644 :${m} docs/doc-${i}.md`)
	}
	let prev = stream.nextMark()
	stream.append(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	for (let i = 0; i < mainCommits; i++) {
		const run = uuidFromSeed(`m-run-${i}`)
		const record = stream.blob(
			`{"run":"${run}","payload":"${deterministicFiller(`m-rec-${i}`, 400)}"}\n`,
		)
		const stderr = stream.blob(`${deterministicFiller(`m-err-${i}`, 120)}\n`)
		const commit = stream.nextMark()
		const message = `main run ${i}`
		stream.append(
			`commit refs/heads/main\nmark :${commit}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${message.length}\n${message}\nfrom :${prev}\n` +
				`M 100644 :${record} ${RUNS_DIR}/${run}/record.json\n` +
				`M 100644 :${stderr} ${RUNS_DIR}/${run}/stderr\n`,
		)
		prev = commit
	}

	await spawnGit(["init", "-q", "-b", "main", dir])
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: stream.render() })
}

/** Append the two-file run shape used by destructive lifecycle lineages. */
export async function appendLifecycleLineage(
	dir: string,
	branch: string,
	fromOid: string,
	salt: string,
	count: number,
): Promise<void> {
	const stream = new FastImportStream()
	let prev: string | number = requireGitOid(fromOid, "lifecycle lineage base")
	for (let i = 0; i < count; i++) {
		const run = uuidFromSeed(`${salt}-${i}`)
		const record = stream.blob(
			`{"run":"${run}","payload":"${deterministicFiller(`${salt}-rec-${i}`, 400)}"}\n`,
		)
		const stderr = stream.blob(`${deterministicFiller(`${salt}-err-${i}`, 120)}\n`)
		const commit = stream.nextMark()
		const message = `${salt} ${i}`
		stream.append(
			`commit refs/heads/${branch}\nmark :${commit}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${message.length}\n${message}\n` +
				`from ${typeof prev === "string" ? prev : `:${prev}`}\n` +
				`M 100644 :${record} ${RUNS_DIR}/${run}/record.json\n` +
				`M 100644 :${stderr} ${RUNS_DIR}/${run}/stderr\n`,
		)
		prev = commit
	}
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: stream.render() })
}

/** Append the single-file run shape used by branch-producing lifecycle suites. */
export async function appendLifecycleBranch(
	dir: string,
	branch: string,
	fromOid: string,
	salt: string,
	count: number,
): Promise<string> {
	const stream = new FastImportStream()
	let prev: string | number = requireGitOid(fromOid, "lifecycle branch base")
	for (let i = 0; i < count; i++) {
		const run = uuidFromSeed(`${salt}-${i}`)
		const record = stream.blob(
			`{"run":"${run}","payload":"${deterministicFiller(`${salt}-r-${i}`, 300)}"}\n`,
		)
		const commit = stream.nextMark()
		const message = `${salt} ${i}`
		stream.append(
			`commit refs/heads/${branch}\nmark :${commit}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${message.length}\n${message}\n` +
				`from ${typeof prev === "string" ? prev : `:${prev}`}\n` +
				`M 100644 :${record} ${RUNS_DIR}/${run}/record.json\n`,
		)
		prev = commit
	}
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: stream.render() })
	const tip = await spawnGit(["rev-parse", branch], { cwd: dir })
	return requireGitOid(tip.stdout.trim(), `rev-parse ${branch}`)
}

/** The OID of the append-only directory's tree at a given revision — the object whose
 * successive versions the delta encoder must collapse. */
export async function runsTreeAt(dir: string, rev: string): Promise<string> {
	const out = await spawnGit(["rev-parse", `${rev}:${RUNS_DIR}`], { cwd: dir })
	return requireGitOid(out.stdout.trim(), `rev-parse ${rev}:${RUNS_DIR}`)
}

/** Commit OIDs for one revision, oldest-first. */
export async function commitsOldestFirst(dir: string, revision = "HEAD"): Promise<Oid[]> {
	const out = await spawnGit(["rev-list", "--reverse", revision], { cwd: dir })
	return parseRevListObjectOids(out.stdout)
}

/** One object's raw bytes, binary-safe. */
export async function readObject(
	dir: string,
	oid: string,
	type: string,
): Promise<Buffer> {
	return (await spawnGit(["cat-file", type, oid], { cwd: dir })).stdoutBytes
}

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"
import { mulberry32, type Scenario } from "./scenarios"

// Raw fast-import "when": <unix-ts> <tz>, matching spawn-git's PINNED_DATE clock
// (@1700000000 +0000) so generated commit OIDs are reproducible.
const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`

/** Deterministic path for file `i`: `pathDepth` dirs of `treeWidth` fanout. */
function filePath(i: number, s: Scenario): string {
	const parts: string[] = []
	let n = i
	for (let d = 0; d < s.pathDepth; d++) {
		parts.push(`d${n % s.treeWidth}`)
		n = Math.floor(n / s.treeWidth)
	}
	parts.push(`f${i}.md`)
	return parts.join("/")
}

/** Printable-ASCII blob of a random in-range length (ASCII ⇒ byteLength === length). */
function blobContent(salt: string, s: Scenario, rnd: () => number): string {
	const len = s.blobMinBytes + Math.floor(rnd() * (s.blobMaxBytes - s.blobMinBytes + 1))
	let str = `# ${salt}\n`
	while (str.length < len) str += String.fromCharCode(32 + Math.floor(rnd() * 95))
	return str.slice(0, len)
}

/** Build a git fast-import stream for the scenario (one initial commit + churn). */
function buildStream(s: Scenario, rnd: () => number): string {
	const out: string[] = []
	let mark = 0
	const nextMark = () => ++mark
	const blobMark: number[] = []

	const emitBlob = (content: string): number => {
		const m = nextMark()
		out.push(`blob\nmark :${m}\ndata ${content.length}\n${content}\n`)
		return m
	}
	const emitCommit = (msg: string, parent: number | null, changed: number[]): number => {
		const cm = nextMark()
		const from = parent === null ? "" : `from :${parent}\n`
		let body = `commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\n${from}`
		for (const i of changed) body += `M 100644 :${blobMark[i]} ${filePath(i, s)}\n`
		out.push(body)
		return cm
	}

	// Commit 0: every file.
	const all: number[] = []
	for (let i = 0; i < s.blobCount; i++) {
		blobMark[i] = emitBlob(blobContent(`f${i}-v0`, s, rnd))
		all.push(i)
	}
	let prev = emitCommit("c0", null, all)

	// Commits 1..historyLen-1: churn a deterministic subset (new blob versions).
	for (let c = 1; c < s.historyLen; c++) {
		const changed: number[] = []
		for (let k = 0; k < s.churn; k++) {
			const i = Math.floor(rnd() * s.blobCount)
			blobMark[i] = emitBlob(blobContent(`f${i}-v${c}`, s, rnd))
			changed.push(i)
		}
		prev = emitCommit(`c${c}`, prev, changed)
	}

	// Extra branch refs (stresses ls-refs / negotiation in the adversarial shape).
	for (let r = 0; r < s.refCount; r++) {
		out.push(`reset refs/heads/branch${r}\nfrom :${prev}\n`)
	}

	return out.join("")
}

/**
 * Generate a real git repo for `scenario` via `git fast-import` and return its
 * path. Pinned identity/clock + seeded RNG make the object set reproducible.
 */
export async function generateRepo(scenario: Scenario, seed: number): Promise<string> {
	const stream = buildStream(scenario, mulberry32(seed))
	const dir = mkdtempSync(join(tmpdir(), `pggit-perf-${scenario.name}-`))
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: stream })
	return dir
}

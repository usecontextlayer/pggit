/**
 * NEGATIVE RESULTS — the GROWING shapes of the adversarial repo-shape sweep that
 * pggit's delta-pack pipeline SURVIVED. Every shape here was built to break it and
 * did not. These are the delta-heavy shapes — the tier only engages when trees GROW —
 * so every one of them is an append-only directory that gains one entry per commit
 * (the shared `growing()` builder), pairing each version of the growing tree with its
 * predecessor so the delta actually wins: plain growth, gitlinks, exotic-but-valid
 * UTF-8 directory names, a mode-cycling path, a two-content toggle, maximally
 * repetitive entry names, and a 10,000-commit linear history.
 *
 * The pipeline, the `Shape` contract and every verdict live in `@/testing/shape-sweep`
 * — this file registers shapes and drives them, one `it` each. Its siblings carry the
 * rest of the sweep: `-static` (one-shot structural shapes), `-mutating` (history and
 * ref surgery), `-scale` (the oversized fixtures). The split is recorded in
 * `docs/2026-08-20-test-efficiency.md`; the shapes and their verdicts are unchanged.
 */
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, it } from "vitest"
import type { GitServer } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import { createRepack, type Repack } from "@/store/repack"
import {
	deterministicFiller,
	FAST_IMPORT_COMMITTER,
	runDirName,
} from "@/testing/append-only-repo"
import {
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { fastImport, growing, LINEAR, runShape, type Shape } from "@/testing/shape-sweep"
import { spawnGit } from "@/testing/spawn-git"

const shapes = new Map<string, Shape>()
const shape = (name: string, s: Shape): void => void shapes.set(name, s)

// ── delta-heavy adversarial shapes (the tier only engages when trees GROW) ──

// A. append-only growing dir, plain — the design's own motivating shape (baseline).
shape("growing-plain", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(deterministicFiller(`e${i}`, 300))} runs/${runDirName(i)}/record.json`,
	}),
	extend: async (dir) => {
		const tip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dir })
		).stdout.trim()
		const out: string[] = []
		let mark = 0
		let prev = 0
		for (let i = 300; i < 340; i++) {
			const b = ++mark
			const body = deterministicFiller(`e${i}`, 300)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nx${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${b} runs/${runDirName(i)}/record.json\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
	minDeltasServed: 1,
})

// B. growing dir made of GITLINKS — mode 160000 entries the repack's diff filters out.
shape("growing-gitlinks", {
	build: growing({
		commits: 300,
		entry: (i) =>
			`M 160000 ${createHash("sha1").update(`sub-${i}`).digest("hex")} mods/${runDirName(i)}`,
		extraChanges: (i, blob) => [
			`M 100644 :${blob(deterministicFiller(`g${i}`, 200))} mods/${runDirName(i)}/inner.txt`,
			// churn a gitlink that already exists, at a DEEP path
			`M 160000 ${createHash("sha1").update(`churn-${i}`).digest("hex")} deep/a/b/c/mod`,
		],
	}),
	minDeltasServed: 1,
})

// C. growing dir whose subdirectory names are exotic-but-VALID UTF-8: NFC "é"
// beside NFD "é" (distinct byte sequences that render identically), a CJK name,
// and a 4-byte emoji. This replaced the raw-non-UTF-8 collision shape D16 now
// rejects at ingest (see pg-corrupt--non-utf8-path-collision for the rejection
// contract). Unlike that old pair these CANNOT collide — valid-UTF-8 decode is
// injective — which is exactly what this shape pins: they must key distinctly
// through the repack's decoded names and survive the pipeline identical to git.
shape("growing-utf8-exotic", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		let prev = 0
		// fast-import quoted paths take C-style octal escapes for raw bytes.
		const dirs = ["\\303\\251", "e\\314\\201", "\\344\\270\\255", "\\360\\237\\226\\245"]
		for (let i = 0; i < 200; i++) {
			const changes: string[] = []
			for (const [k, d] of dirs.entries()) {
				const m = ++mark
				const body = deterministicFiller(`n${i}-${k}`, 120)
				out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
				changes.push(`M 100644 :${m} "${d}/${runDirName(i)}.json"`)
			}
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nc${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					`${changes.join("\n")}\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
	minDeltasServed: 1,
})

// D. growing dir + a single path cycling file → exec → symlink → directory.
shape("growing-modeswap", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(deterministicFiller(`m${i}`, 250))} runs/${runDirName(i)}/rec`,
		extraChanges: (i, blob) => {
			const m = blob(deterministicFiller(`p${i}`, 30 + (i % 7)))
			const phase = i % 4
			if (phase === 0) return [`D p`, `M 100644 :${m} p`]
			if (phase === 1) return [`D p`, `M 100755 :${m} p`]
			if (phase === 2) return [`D p`, `M 120000 :${m} p`]
			return [`D p`, `M 100644 :${m} p/inner`]
		},
	}),
	minDeltasServed: 1,
})

// F. a growing dir whose entries alternate between two blob contents forever
//    (the shape that produced delta CYCLES in the pre-star harness).
shape("growing-toggle", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(deterministicFiller(`t${i}`, 240))} runs/${runDirName(i)}/rec`,
		extraChanges: (i, blob) => [
			`M 100644 :${blob(i % 2 === 0 ? "A".repeat(500) : "B".repeat(500))} toggle/x`,
			`M 100644 :${blob(i % 2 === 0 ? "B".repeat(500) : "A".repeat(500))} toggle/y`,
		],
	}),
	minDeltasServed: 1,
})

// L. a GROWING directory whose entry names are adversarial AND maximally
//    repetitive — 64 identical bytes per name, so the delta encoder's 16-byte
//    block index degenerates to a few keys and its CHAIN_LIMIT=64 candidate cap
//    is hit on every position. Names also cover the "a-b" < "a.b" < "a/" tree
//    sort adjacency, spaces, tabs, quotes, and pure-numeric segments.
shape("growing-repetitive-names", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(deterministicFiller(`r${i}`, 200))} "${"a".repeat(64)}${String(i).padStart(6, "0")}"`,
		extraChanges: (i, blob) => {
			const m = blob(deterministicFiller(`s${i}`, 100))
			const n = i % 6
			const name = ["x-y", "x.y", "x y", "x\\ty", 'x\\"y', String(i % 97)][n] as string
			return [
				`M 100644 :${m} "dir/${name}/leaf${String(i).padStart(6, "0")}"`,
				`M 100644 :${m} "${"z".repeat(120)}/${String(i).padStart(6, "0")}"`,
			]
		},
	}),
	async extend(dir) {
		const tip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dir })
		).stdout.trim()
		const out: string[] = []
		let mark = 0
		let prev = 0
		for (let i = 300; i < 350; i++) {
			const b = ++mark
			const body = deterministicFiller(`r${i}`, 200)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nq${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${b} "${"a".repeat(64)}${String(i).padStart(6, "0")}"\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
	minDeltasServed: 1,
})

// J. a long linear history — 10k commits, one file changing (scale + timing).
shape("linear-10k", {
	build: growing({
		commits: LINEAR,
		entry: (i, blob) =>
			`M 100644 :${blob(deterministicFiller(`l${i}`, 400))} src/main.txt`,
	}),
	minDeltasServed: 1,
})

/** The sweep list: every registered adversarial shape. */
const SWEEP = [...shapes.entries()]

describe("shapes — the adversarial sweep: growing trees (negative results)", () => {
	let db: IsolatedDb
	let server: GitServer
	let repack: Repack
	let gc: Gc

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		repack = createRepack(db.sql)
		gc = createGc(db.sql)
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
	})

	for (const [name, s] of SWEEP) {
		it(`${name}: survives push → repack → clone → fetch → gc, identical to a file:// control`, async () => {
			await runShape({ gc, repack, server }, name, s)
		}, 600_000)
	}
})

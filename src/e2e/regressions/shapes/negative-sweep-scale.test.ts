/**
 * NEGATIVE RESULTS — the OVERSIZED shapes of the adversarial repo-shape sweep that
 * pggit's delta-pack pipeline SURVIVED. Both shapes here were built to break it and
 * did not, and what makes them adversarial is fixture SIZE: one directory holding
 * 20,000 entries churned across commits, and a 120-level path chain that every commit
 * of a growing dir at its bottom rewrites end to end. `WIDE` lives with the sweep's
 * other scale constants in the driver — the shapes are only adversarial AT these
 * sizes, so the sizes are pinned, never tuned for runtime.
 *
 * The pipeline, the `Shape` contract and every verdict live in `@/testing/shape-sweep`
 * — this file registers shapes and drives them, one `it` each. Its siblings carry the
 * rest of the sweep: `-static` (one-shot structural shapes), `-growing` (the
 * append-only growth tier), `-mutating` (history and ref surgery). The split is
 * recorded in `docs/2026-08-20-test-efficiency.md`; the shapes and their verdicts are
 * unchanged.
 */
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
import { fastImport, growing, runShape, type Shape, WIDE } from "@/testing/shape-sweep"

const shapes = new Map<string, Shape>()
const shape = (name: string, s: Shape): void => void shapes.set(name, s)

// ───────────────────────── the shapes ─────────────────────────

// 9. Wide tree churn: 20k entries in one directory, mutated across commits.
shape("wide-tree", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		const seed: string[] = []
		for (let i = 0; i < WIDE; i++) {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata 6\n${deterministicFiller(`w${i}`, 5)}\n\n`)
			seed.push(`M 100644 :${m} wide/${i}.txt`)
		}
		let prev = ++mark
		out.push(
			`commit refs/heads/main\nmark :${prev}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nc0\n${seed.join("\n")}\n\n`,
		)
		for (let c = 0; c < 60; c++) {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata 6\n${deterministicFiller(`u${c}`, 5)}\n\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nc${c % 10}\nfrom :${prev}\nM 100644 :${m} wide/${c}.txt\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
})

// E. deep nesting AND growth: a 120-level chain with a growing dir at the bottom.
shape("deep-growing", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(deterministicFiller(`d${i}`, 250))} ${Array.from({ length: 120 }, (_, k) => `l${k}`).join("/")}/${runDirName(i)}/rec`,
	}),
	minDeltasServed: 1,
})

/** The sweep list: every registered adversarial shape. */
const SWEEP = [...shapes.entries()]

describe("shapes — the adversarial sweep: oversized fixtures (negative results)", () => {
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

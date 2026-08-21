/**
 * NEGATIVE RESULTS — the HISTORY-SURGERY shapes of the adversarial repo-shape sweep
 * that pggit's delta-pack pipeline SURVIVED. Every shape here was built to break it
 * and did not. What makes these adversarial is the commit graph and the ref namespace
 * rather than any single tree: orphan branches sharing identical trees, root commits
 * appearing mid-history, an ANCHOR orphaned over the wire while a DELTA against it
 * stays reachable, a `mergetag` header carrying a whole tag object inside a commit,
 * and `monster` — everything at once across 400 commits.
 *
 * The pipeline, the `Shape` contract and every verdict live in `@/testing/shape-sweep`
 * — this file registers shapes and drives them, one `it` each. Its siblings carry the
 * rest of the sweep: `-static` (one-shot structural shapes), `-growing` (the
 * append-only growth tier), `-scale` (the oversized fixtures). The split is recorded in
 * `docs/2026-08-20-test-efficiency.md`; the shapes and their verdicts are unchanged.
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
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
import { fastImport, growing, runShape, type Shape } from "@/testing/shape-sweep"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

const shapes = new Map<string, Shape>()
const shape = (name: string, s: Shape): void => void shapes.set(name, s)

// ───────────────────────── the shapes ─────────────────────────

// 10. Orphan branches sharing identical trees (tree reuse across unrelated history).
shape("orphan-shared-trees", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		out.push(`blob\nmark :${++mark}\ndata 3\nab\n\n`)
		const b = mark
		for (let br = 0; br < 6; br++) {
			let prev = 0
			for (let i = 0; i < 40; i++) {
				const cm = ++mark
				out.push(
					`commit refs/heads/o${br}\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nm${i % 7}\n` +
						(prev ? `from :${prev}\n` : "") +
						`M 100644 :${b} d/${i}.txt\n\n`,
				)
				prev = cm
			}
		}
		await fastImport(dir, out.join(""))
	},
})

// 11. First-parent chain diverging from topo order + root commit appearing mid-history.
shape("mid-history-roots", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		const blob = (s: string): number => {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(s)}\n${s}\n`)
			return m
		}
		let prev = 0
		for (let i = 0; i < 40; i++) {
			// each step merges in a brand-new ROOT commit as the SECOND parent
			const rb = blob(`root-${i}\n`)
			const rc = ++mark
			out.push(
				`commit refs/heads/tmp\nmark :${rc}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nrt\nM 100644 :${rb} roots/${i}.txt\n\n`,
			)
			const mb = blob(`main-${i}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nmn\n` +
					(prev ? `from :${prev}\n` : "") +
					`merge :${rc}\nM 100644 :${mb} main/${i}.txt\nM 100644 :${rb} roots/${i}.txt\n\n`,
			)
			prev = cm
		}
		out.push(`reset refs/heads/tmp\nfrom ${"0".repeat(40)}\n\n`)
		await fastImport(dir, out.join(""))
	},
})

// H. orphan an ANCHOR while a DELTA against it stays reachable (design N3), driven
//    entirely over the wire: a second ref reuses a mid-lineage tree, then `main` is
//    DELETED (pggit denies non-fast-forward pushes, so ref deletion is the orphan
//    generator a real client actually has).
shape("orphan-anchor-tree-reuse", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(deterministicFiller(`o${i}`, 260))} runs/${runDirName(i)}/rec`,
	}),
	minDeltasServed: 1,
	async mutate(dir, url, mirror, mk) {
		// (1) mid-lineage trees get their own root commits on their own refs, so many
		//     DELTA trees are reachable through a path that is not main.
		for (let n = 120; n < 300; n += 8) {
			const tree = (
				await spawnGit(["rev-parse", `refs/heads/main~${300 - 1 - n}^{tree}`], {
					cwd: dir,
				})
			).stdout.trim()
			const c = (
				await spawnGit(["commit-tree", tree, "-m", `keep${n}`], { cwd: dir, input: "" })
			).stdout.trim()
			await spawnGit(["update-ref", `refs/heads/keep${n}`, c], { cwd: dir })
		}
		await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: dir })
		await spawnGit(["push", "-q", mirror, "refs/heads/*:refs/heads/*"], { cwd: dir })

		// (2) the only orphan generator a wire client has (pggit denies deletes and
		//     non-fast-forwards): a DENIED push still ingests its objects.
		const side = join(mk("orphan-side"), "s")
		await spawnGit(["clone", "-q", dir, side])
		await spawnGit(["reset", "-q", "--hard", "HEAD~150"], { cwd: side })
		const out: string[] = []
		let mark = 0
		let prev = 0
		const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: side })).stdout.trim()
		for (let i = 0; i < 60; i++) {
			const b = ++mark
			const body = deterministicFiller(`rw${i}`, 260)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nr${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${b} rewritten/${runDirName(i)}/rec\n\n`,
			)
			prev = cm
		}
		await fastImport(side, out.join(""))
		const denied = await attemptGit(
			["push", "-q", "--force", url, "refs/heads/main:refs/heads/main"],
			side,
		)
		if (denied.ok || !/non-fast-forward/.test(denied.stderr)) {
			throw new Error(`expected a non-fast-forward rejection: ${denied.stderr}`)
		}
	},
})

// K. mergetag / gpgsig-style multi-line commit headers — ingest derives ordered
//    parents from commit content, so an embedded tag object inside a commit
//    header is the adversarial input for that parser; repack consumes the row.
shape("mergetag", {
	async build(dir) {
		// (the sweep already `git init -q -b main`s `dir`, so this shape starts from a
		// worktree it can check out and merge in)
		const out: string[] = []
		let mark = 0
		let prev = 0
		for (let i = 0; i < 40; i++) {
			const b = ++mark
			const body = deterministicFiller(`mt${i}`, 200)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nc${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					`M 100644 :${b} runs/${runDirName(i)}/rec\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
		// a real annotated tag on a side branch, merged with --no-ff so git writes a
		// `mergetag` header (an entire tag object embedded in the commit headers,
		// blank lines included).
		for (let r = 0; r < 6; r++) {
			await spawnGit(["checkout", "-q", "-B", `side${r}`, `main~${r * 3}`], { cwd: dir })
			await spawnGit(["commit", "-q", "--allow-empty", "-m", `side${r}`], { cwd: dir })
			await spawnGit(
				[
					"tag",
					"-a",
					"-m",
					`annotated ${r}\n\nwith a blank line\nparent 0000000000000000000000000000000000000000\n`,
					`s${r}`,
				],
				{ cwd: dir },
			)
			await spawnGit(["checkout", "-q", "main"], { cwd: dir })
			await spawnGit(["merge", "-q", "--no-ff", "-m", `merge s${r}`, `s${r}`], {
				cwd: dir,
			})
		}
	},
})

// I. everything at once: growing dir + gitlinks + symlinks + exec + NFC/NFD
//    look-alike dirs (valid UTF-8 — raw non-UTF-8 is rejected at ingest since
//    D16) + a deep path + a wide dir + mode churn + merges + tags, 400 commits.
shape("monster", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		const blob = (s: string): number => {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(s)}\n${s}\n`)
			return m
		}
		const deep = Array.from({ length: 40 }, (_, k) => `lvl${k}`).join("/")
		let prev = 0
		let side = 0
		for (let i = 0; i < 400; i++) {
			const changes: string[] = [
				`M 100644 :${blob(deterministicFiller(`rec${i}`, 300))} runs/${runDirName(i)}/record.json`,
				`M 100644 :${blob(deterministicFiller(`err${i}`, 40))} runs/${runDirName(i)}/stderr`,
				`M 160000 ${createHash("sha1").update(`sub${i}`).digest("hex")} runs/${runDirName(i)}/mod`,
				`M 120000 :${blob(`../${runDirName(i % 7)}`)} links/l${i % 11}`,
				`M 100755 :${blob(deterministicFiller(`sh${i}`, 90))} bin/run${i % 13}.sh`,
				`M 100644 :${blob(deterministicFiller(`d${i}`, 120))} ${deep}/${runDirName(i)}.txt`,
				`M 100644 :${blob(deterministicFiller(`w${i}`, 60))} wide/${i % 500}.txt`,
				`M 100644 :${blob(deterministicFiller(`nu${i}`, 80))} "\\303\\251/${runDirName(i)}"`,
				`M 100644 :${blob(deterministicFiller(`nu2${i}`, 80))} "e\\314\\201/${runDirName(i)}"`,
			]
			const phase = i % 4
			const pm = blob(deterministicFiller(`p${i}`, 25 + (i % 5)))
			if (phase === 0) changes.push("D p", `M 100644 :${pm} p`)
			else if (phase === 1) changes.push("D p", `M 100755 :${pm} p`)
			else if (phase === 2) changes.push("D p", `M 120000 :${pm} p`)
			else changes.push("D p", `M 100644 :${pm} p/inner`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nc${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					(i > 0 && i % 50 === 0 && side ? `merge :${side}\n` : "") +
					`${changes.join("\n")}\n\n`,
			)
			prev = cm
			if (i % 50 === 25) {
				// an independent side ROOT commit merged in 25 commits later
				const sc = ++mark
				out.push(
					`commit refs/heads/side\nmark :${sc}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\ns${i % 10}\n` +
						`M 100644 :${blob(deterministicFiller(`sd${i}`, 200))} side/${runDirName(i)}.txt\n\n`,
				)
				side = sc
			}
			if (i % 97 === 0) {
				out.push(
					`tag v${i}\nfrom :${cm}\ntagger ${FAST_IMPORT_COMMITTER}\ndata 3\nt${i % 10}\n\n`,
				)
			}
		}
		await fastImport(dir, out.join(""))
	},
	async extend(dir) {
		const tip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dir })
		).stdout.trim()
		const out: string[] = []
		let mark = 0
		let prev = 0
		for (let i = 400; i < 460; i++) {
			const b = ++mark
			const body = deterministicFiller(`x${i}`, 300)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\ny${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${b} runs/${runDirName(i)}/record.json\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
	minDeltasServed: 1,
})

/** The sweep list: every registered adversarial shape. */
const SWEEP = [...shapes.entries()]

describe("shapes — the adversarial sweep: history surgery (negative results)", () => {
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

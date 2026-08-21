/**
 * NEGATIVE RESULTS — the STRUCTURAL shapes of the adversarial repo-shape sweep that
 * pggit's delta-pack pipeline SURVIVED. Every shape here was built to break it and
 * did not. Each is laid down by ONE fast-import build whose structure IS the whole
 * adversary: a 2,000-level path nest, submodule gitlinks, mode churn at a single
 * path, adversarially-sorted names, a two-content toggle, octopus/criss-cross
 * merges, tag chains, and blob edge cases.
 *
 * The pipeline, the `Shape` contract and every verdict live in `@/testing/shape-sweep`
 * — this file registers shapes and drives them, one `it` each. Its siblings carry the
 * rest of the sweep: `-growing` (the append-only growth tier), `-mutating` (history
 * and ref surgery), `-scale` (the oversized fixtures). The split is recorded in
 * `docs/2026-08-20-test-efficiency.md`; the shapes and their verdicts are unchanged.
 */
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, it } from "vitest"
import type { GitServer } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import { createRepack, type Repack } from "@/store/repack"
import { deterministicFiller, FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import {
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { DEPTH, fastImport, runShape, type Shape } from "@/testing/shape-sweep"
import { spawnGit } from "@/testing/spawn-git"

const shapes = new Map<string, Shape>()
const shape = (name: string, s: Shape): void => void shapes.set(name, s)

// ───────────────────────── the shapes ─────────────────────────

// 1. Deep nesting: a/a/a/... N levels, changed across two commits.
shape("deep-nesting", {
	async build(dir) {
		const path = `${Array.from({ length: DEPTH }, () => "a").join("/")}/f.txt`
		const out: string[] = []
		out.push(`blob\nmark :1\ndata 3\nv1\n\n`)
		out.push(
			`commit refs/heads/main\nmark :2\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nc1\nM 100644 :1 ${path}\n\n`,
		)
		out.push(`blob\nmark :3\ndata 3\nv2\n\n`)
		out.push(
			`commit refs/heads/main\nmark :4\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nc2\nfrom :2\nM 100644 :3 ${path}\n\n`,
		)
		await fastImport(dir, out.join(""))
	},
	async extend(dir) {
		const tip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dir })
		).stdout.trim()
		const path = `${Array.from({ length: DEPTH }, () => "a").join("/")}/f.txt`
		await fastImport(
			dir,
			`blob\nmark :1\ndata 3\nv3\n\ncommit refs/heads/main\nmark :2\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nc3\nfrom ${tip}\nM 100644 :1 ${path}\n\n`,
		)
	},
})

// 2. Gitlinks (submodule entries) evolving across commits, inside a nested dir.
shape("gitlinks", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		const fake = (i: number): string =>
			createHash("sha1").update(`fake-commit-${i}`).digest("hex")
		out.push(`blob\nmark :${++mark}\ndata 2\nx\n\n`)
		const blob = mark
		let prev = 0
		for (let i = 0; i < 80; i++) {
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nc${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					`M 100644 :${blob} sub/keep${i}.txt\n` +
					`M 160000 ${fake(i)} sub/mod\n` +
					`M 160000 ${fake(i + 1000)} other/deep/mod2\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
})

// 3. Mode churn at one path: file ↔ exec ↔ symlink ↔ directory.
shape("mode-churn", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		let prev = 0
		const commit = (body: string): void => {
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\ncm\n` +
					(prev ? `from :${prev}\n` : "") +
					`${body}\n\n`,
			)
			prev = cm
		}
		for (let i = 0; i < 60; i++) {
			const m = ++mark
			out.push(
				`blob\nmark :${m}\ndata ${8 + (i % 3)}\n${deterministicFiller(`b${i}`, 8 + (i % 3))}\n`,
			)
			const phase = i % 4
			if (phase === 0) commit(`D p\nM 100644 :${m} p`)
			else if (phase === 1) commit(`D p\nM 100755 :${m} p`)
			else if (phase === 2) commit(`D p\nM 120000 :${m} p`)
			else commit(`D p\nM 100644 :${m} p/inner.txt`)
		}
		await fastImport(dir, out.join(""))
	},
})

// 4. Adversarially-sorted / weird names, wide tree, exotic (valid-UTF-8) names.
shape("weird-names", {
	async build(dir) {
		const names = [
			"a",
			"a-b",
			"a.b",
			"a b",
			"a\tb",
			'a"b',
			"a\\b",
			"0",
			"00",
			"1",
			"\u00e9",
			"\u0301e",
			"z".repeat(200),
		]
		const out: string[] = []
		let mark = 0
		let prev = 0
		for (let c = 0; c < 70; c++) {
			const changes: string[] = []
			for (const [i, n] of names.entries()) {
				const m = ++mark
				const body = `${n}-${c}-${i}\n`
				out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
				// each name is both a dir and (differently-named) file segment
				changes.push(
					`M 100644 :${m} "${n.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\t", "\\t")}/leaf"`,
				)
			}
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\ncm\n` +
					(prev ? `from :${prev}\n` : "") +
					`${changes.join("\n")}\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
})

// 5. Content toggle: one file alternating between exactly two contents.
shape("toggle", {
	async build(dir) {
		const out: string[] = []
		out.push(`blob\nmark :1\ndata 6\nAAAAA\n\n`)
		out.push(`blob\nmark :2\ndata 6\nBBBBB\n\n`)
		let prev = 0
		let mark = 2
		for (let i = 0; i < 200; i++) {
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nt${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					`M 100644 :${i % 2 === 0 ? 1 : 2} d/f.txt\nM 100644 :${i % 2 === 0 ? 2 : 1} d/g.txt\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
	async extend(dir) {
		const tip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dir })
		).stdout.trim()
		const out: string[] = []
		out.push(`blob\nmark :1\ndata 6\nAAAAA\n\n`)
		out.push(`blob\nmark :2\ndata 6\nBBBBB\n\n`)
		let prev = 0
		let mark = 2
		for (let i = 200; i < 300; i++) {
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nt${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${i % 2 === 0 ? 1 : 2} d/f.txt\nM 100644 :${i % 2 === 0 ? 2 : 1} d/g.txt\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
})

// 6. Merges: octopus, criss-cross, orphan roots merged in mid-history.
shape("merges", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		const blob = (s: string): number => {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(s)}\n${s}\n`)
			return m
		}
		// eight independent roots
		const roots: number[] = []
		for (let i = 0; i < 8; i++) {
			const b = blob(`root ${i}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/r${i}\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nr${i}\nM 100644 :${b} shared/f${i}.txt\n\n`,
			)
			roots.push(cm)
		}
		// octopus merge of all eight
		const oct = ++mark
		out.push(
			`commit refs/heads/main\nmark :${oct}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\noct\nfrom :${roots[0]}\n` +
				roots
					.slice(1)
					.map((r) => `merge :${r}\n`)
					.join("") +
				`M 100644 :${blob("octopus\n")} shared/oct.txt\n\n`,
		)
		// criss-cross
		const a1 = ++mark
		out.push(
			`commit refs/heads/A\nmark :${a1}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\na1\nfrom :${oct}\nM 100644 :${blob("a1\n")} shared/a.txt\n\n`,
		)
		const b1 = ++mark
		out.push(
			`commit refs/heads/B\nmark :${b1}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nb1\nfrom :${oct}\nM 100644 :${blob("b1\n")} shared/b.txt\n\n`,
		)
		const a2 = ++mark
		out.push(
			`commit refs/heads/A\nmark :${a2}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\na2\nfrom :${a1}\nmerge :${b1}\nM 100644 :${blob("a2\n")} shared/a.txt\n\n`,
		)
		const b2 = ++mark
		out.push(
			`commit refs/heads/B\nmark :${b2}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nb2\nfrom :${b1}\nmerge :${a1}\nM 100644 :${blob("b2\n")} shared/b.txt\n\n`,
		)
		const fin = ++mark
		out.push(
			`commit refs/heads/main\nmark :${fin}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nfin\nfrom :${a2}\nmerge :${b2}\nM 100644 :${blob("fin\n")} shared/fin.txt\n\n`,
		)
		await fastImport(dir, out.join(""))
	},
})

// 7. Tag chains: tag→tag→tag→commit, tags on trees and blobs, lightweight mixed.
shape("tags", {
	async build(dir) {
		const b = (
			await spawnGit(["hash-object", "-w", "--stdin"], { cwd: dir, input: "blobby\n" })
		).stdout.trim()
		const treeRaw = Buffer.concat([Buffer.from("100644 f\0"), Buffer.from(b, "hex")])
		const t = (
			await spawnGit(["hash-object", "-w", "-t", "tree", "--stdin"], {
				cwd: dir,
				input: treeRaw,
			})
		).stdout.trim()
		const c = (
			await spawnGit(["commit-tree", t, "-m", "c1"], { cwd: dir, input: "" })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/main", c], { cwd: dir })
		// annotated chain t1 -> t2 -> t3 -> commit
		await spawnGit(["tag", "-a", "-m", "t1", "t1", c], { cwd: dir })
		await spawnGit(["tag", "-a", "-m", "t2", "t2", "t1"], { cwd: dir })
		await spawnGit(["tag", "-a", "-m", "t3", "t3", "t2"], { cwd: dir })
		await spawnGit(["tag", "-a", "-m", "tt", "tag-on-tree", t], { cwd: dir })
		await spawnGit(["tag", "-a", "-m", "tb", "tag-on-blob", b], { cwd: dir })
		await spawnGit(["tag", "light", c], { cwd: dir })
	},
})

// 8. Blob edge cases: empty blob, 1-byte, huge zero run, identical blobs at paths.
shape("blob-edges", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		const raw = (bytes: Buffer, path: string): string => {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata ${bytes.length}\n${bytes.toString("latin1")}\n`)
			return `M 100644 :${m} ${path}`
		}
		const changes = [
			raw(Buffer.alloc(0), "empty"),
			raw(Buffer.from("x"), "one"),
			raw(Buffer.alloc(3_000_000), "zeros.bin"),
			raw(Buffer.from("tree 0\0", "latin1"), "looks-like-tree"),
			raw(
				Buffer.from(`commit 0\0tree ${"0".repeat(40)}\n`, "latin1"),
				"looks-like-commit",
			),
			raw(Buffer.from("same"), "dup/a"),
			raw(Buffer.from("same"), "dup/b"),
		]
		out.push(
			`commit refs/heads/main\nmark :${++mark}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\nc1\n${changes.join("\n")}\n\n`,
		)
		// empty tree + empty commit
		out.push(
			`commit refs/heads/empty\nmark :${++mark}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 2\ne1\ndeleteall\n\n`,
		)
		await fastImport(dir, out.join(""))
	},
})

/** The sweep list: every registered adversarial shape. */
const SWEEP = [...shapes.entries()]

describe("shapes — the adversarial sweep: structural shapes (negative results)", () => {
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

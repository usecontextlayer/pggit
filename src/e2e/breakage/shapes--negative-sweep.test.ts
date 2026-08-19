/**
 * NEGATIVE RESULTS — the adversarial repo-shape sweep that pggit's delta-pack
 * pipeline SURVIVED. Every shape here was built to break it and did not.
 *
 * Converted from `breakage/shapes--negative-sweep.ts` (exit 0 = every shape held
 * up · exit 1 = a shape diverged from real git). The script's verdict is a pure
 * CORRECTNESS property over hermetically-built repos, so it lands here as a plain
 * e2e test — one `it` per shape, GREEN today, and a regression detector forever.
 *
 * The sweep runs every shape EXCEPT `many-tiny-objects`, which is the one
 * confirmed defect and has its own destination test
 * (`shapes--repack-param-limit-many-small-objects.test.ts`). Its definition is
 * kept below so the shape catalogue stays whole; only the sweep list excludes it,
 * exactly as the source script's default did.
 *
 * Each shape builds a REAL git repo in $TMPDIR and drives the whole pipeline over
 * the real wire — `git push` → `createRepack().repack()` → `git clone` →
 * incremental `git fetch` → `createGc().gc()` → repack → clone — judging ONLY what
 * real git observes: clone/fetch success, `git fsck --strict`, byte-identical
 * object sets (an OID IS the object's bytes) and ref sets, all against a plain
 * `file://` bare remote driven through the identical dance. Partial-clone filters
 * (`blob:none`, `tree:0`) are exercised against the repacked repo too.
 *
 * The REF_DELTA count served per shape is the proof the delta path was actually
 * on: a shape that serves 0 deltas proves nothing about deltified serving. It is
 * read through `{ instrument: true }` + `collectedRuns()` (which is why the app is
 * built instrumented here) and asserted as a floor on every shape built so the
 * delta wins; shapes that legitimately serve none (`tags`, `blob-edges`) simply
 * omit `minDeltasServed`, so the exception is stated rather than assumed.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { type GitServer, serveOnPort } from "@/server"
import { createGc, type Gc } from "@/store/gc"
import { createRepack, type Repack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
const WHO = `pggit oracle <oracle@pggit.test> ${WHEN}`

const PUSH_REFSPECS = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]

// Fixture scale. These were the source script's env-overridable defaults; the
// shapes are only adversarial AT these sizes (a 20-level nest or a 200-commit
// linear history exercises nothing), so they are pinned constants here.
const TINY_N = 66_000
const DEPTH = 2000
const WIDE = 20_000
const LINEAR = 10_000

type Mk = (tag: string) => string

type Shape = {
	build: (dir: string) => Promise<void>
	extend?: (dir: string) => Promise<void>
	/** arbitrary ref surgery pushed to BOTH remotes (deletes, orphan refs, …) */
	mutate?: (dir: string, url: string, mirror: string, mk: Mk) => Promise<void>
	/** `extend` rewrites history — push with --force and compare fresh clones.
	 * NOTE: pggit REFUSES every non-fast-forward push and every ref deletion
	 * ("refs only advance", src/protocol/receive-pack.ts), so no wire client can
	 * rewind a ref; the only orphan generator over the wire is a DENIED push,
	 * which `orphan-anchor-tree-reuse` uses. */
	force?: boolean
	/** Floor on the REF_DELTA entries the post-repack clone must be served. Set on
	 * every shape built so "the delta actually wins"; omitted where a shape
	 * legitimately serves none (`tags`, `blob-edges`), so that exception is stated
	 * rather than inferred from silence. */
	minDeltasServed?: number
}

const shapes = new Map<string, Shape>()
const shape = (name: string, s: Shape): void => void shapes.set(name, s)

async function objectList(dir: string): Promise<string[]> {
	const r = await spawnGit(
		[
			"cat-file",
			"--batch-all-objects",
			"--batch-check=%(objectname) %(objecttype) %(objectsize)",
		],
		{ cwd: dir },
	)
	return r.stdout.trim().split("\n").filter(Boolean).sort()
}

async function refList(dir: string): Promise<string[]> {
	// `show-ref` exits 1 on a repo with no refs at all (the `blob-edges` control
	// before its first push) — that is "no refs", not a fault.
	const r = await spawnGit(["show-ref"], { cwd: dir }).catch(() => ({ stdout: "" }))
	return r.stdout.trim().split("\n").filter(Boolean).sort()
}

// ───────────────────────── helpers for building shapes ─────────────────────────

/** Feed a fast-import stream into `dir`. */
async function fastImport(dir: string, stream: string): Promise<void> {
	await spawnGit(["fast-import", "--quiet", "--done"], {
		cwd: dir,
		input: `${stream}done\n`,
	})
}

function filler(salt: string, len: number): string {
	let out = ""
	while (out.length < len)
		out += createHash("sha1").update(`${salt}${out.length}`).digest("hex")
	return out.slice(0, len)
}

// ───────────────────────── the shapes ─────────────────────────

// 1. Many tiny objects — the phase-2 coverage sweep batches by BYTES only.
//    THE ONE CONFIRMED DEFECT: excluded from the sweep list below, converted in
//    `shapes--repack-param-limit-many-small-objects.test.ts`.
shape("many-tiny-objects", {
	async build(dir) {
		const N = TINY_N
		const out: string[] = []
		let mark = 0
		const changes: string[] = []
		for (let i = 0; i < N; i++) {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata ${String(i).length + 1}\n${i}\n\n`)
			changes.push(`M 100644 :${m} f/${i}.txt`)
		}
		out.push(
			`commit refs/heads/main\nmark :${++mark}\ncommitter ${WHO}\ndata 4\nseed\n${changes.join("\n")}\n\n`,
		)
		await fastImport(dir, out.join(""))
	},
})

// 2. Deep nesting: a/a/a/... N levels, changed across two commits.
shape("deep-nesting", {
	async build(dir) {
		const path = `${Array.from({ length: DEPTH }, () => "a").join("/")}/f.txt`
		const out: string[] = []
		out.push(`blob\nmark :1\ndata 3\nv1\n\n`)
		out.push(
			`commit refs/heads/main\nmark :2\ncommitter ${WHO}\ndata 2\nc1\nM 100644 :1 ${path}\n\n`,
		)
		out.push(`blob\nmark :3\ndata 3\nv2\n\n`)
		out.push(
			`commit refs/heads/main\nmark :4\ncommitter ${WHO}\ndata 2\nc2\nfrom :2\nM 100644 :3 ${path}\n\n`,
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
			`blob\nmark :1\ndata 3\nv3\n\ncommit refs/heads/main\nmark :2\ncommitter ${WHO}\ndata 2\nc3\nfrom ${tip}\nM 100644 :1 ${path}\n\n`,
		)
	},
})

// 3. Gitlinks (submodule entries) evolving across commits, inside a nested dir.
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
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 2\nc${i % 10}\n` +
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

// 4. Mode churn at one path: file ↔ exec ↔ symlink ↔ directory.
shape("mode-churn", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		let prev = 0
		const commit = (body: string): void => {
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 2\ncm\n` +
					(prev ? `from :${prev}\n` : "") +
					`${body}\n\n`,
			)
			prev = cm
		}
		for (let i = 0; i < 60; i++) {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata ${8 + (i % 3)}\n${filler(`b${i}`, 8 + (i % 3))}\n`)
			const phase = i % 4
			if (phase === 0) commit(`D p\nM 100644 :${m} p`)
			else if (phase === 1) commit(`D p\nM 100755 :${m} p`)
			else if (phase === 2) commit(`D p\nM 120000 :${m} p`)
			else commit(`D p\nM 100644 :${m} p/inner.txt`)
		}
		await fastImport(dir, out.join(""))
	},
})

// 5. Adversarially-sorted / weird names, wide tree, exotic (valid-UTF-8) names.
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
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 2\ncm\n` +
					(prev ? `from :${prev}\n` : "") +
					`${changes.join("\n")}\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
})

// 6. Content toggle: one file alternating between exactly two contents.
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
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nt${i % 10}\n` +
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
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nt${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${i % 2 === 0 ? 1 : 2} d/f.txt\nM 100644 :${i % 2 === 0 ? 2 : 1} d/g.txt\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
})

// 7. Merges: octopus, criss-cross, orphan roots merged in mid-history.
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
				`commit refs/heads/r${i}\nmark :${cm}\ncommitter ${WHO}\ndata 2\nr${i}\nM 100644 :${b} shared/f${i}.txt\n\n`,
			)
			roots.push(cm)
		}
		// octopus merge of all eight
		const oct = ++mark
		out.push(
			`commit refs/heads/main\nmark :${oct}\ncommitter ${WHO}\ndata 3\noct\nfrom :${roots[0]}\n` +
				roots
					.slice(1)
					.map((r) => `merge :${r}\n`)
					.join("") +
				`M 100644 :${blob("octopus\n")} shared/oct.txt\n\n`,
		)
		// criss-cross
		const a1 = ++mark
		out.push(
			`commit refs/heads/A\nmark :${a1}\ncommitter ${WHO}\ndata 2\na1\nfrom :${oct}\nM 100644 :${blob("a1\n")} shared/a.txt\n\n`,
		)
		const b1 = ++mark
		out.push(
			`commit refs/heads/B\nmark :${b1}\ncommitter ${WHO}\ndata 2\nb1\nfrom :${oct}\nM 100644 :${blob("b1\n")} shared/b.txt\n\n`,
		)
		const a2 = ++mark
		out.push(
			`commit refs/heads/A\nmark :${a2}\ncommitter ${WHO}\ndata 2\na2\nfrom :${a1}\nmerge :${b1}\nM 100644 :${blob("a2\n")} shared/a.txt\n\n`,
		)
		const b2 = ++mark
		out.push(
			`commit refs/heads/B\nmark :${b2}\ncommitter ${WHO}\ndata 2\nb2\nfrom :${b1}\nmerge :${a1}\nM 100644 :${blob("b2\n")} shared/b.txt\n\n`,
		)
		const fin = ++mark
		out.push(
			`commit refs/heads/main\nmark :${fin}\ncommitter ${WHO}\ndata 3\nfin\nfrom :${a2}\nmerge :${b2}\nM 100644 :${blob("fin\n")} shared/fin.txt\n\n`,
		)
		await fastImport(dir, out.join(""))
	},
})

// 8. Tag chains: tag→tag→tag→commit, tags on trees and blobs, lightweight mixed.
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

// 9. Blob edge cases: empty blob, 1-byte, huge zero run, identical blobs at paths.
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
			`commit refs/heads/main\nmark :${++mark}\ncommitter ${WHO}\ndata 2\nc1\n${changes.join("\n")}\n\n`,
		)
		// empty tree + empty commit
		out.push(
			`commit refs/heads/empty\nmark :${++mark}\ncommitter ${WHO}\ndata 2\ne1\ndeleteall\n\n`,
		)
		await fastImport(dir, out.join(""))
	},
})

// 10. Wide tree churn: 20k entries in one directory, mutated across commits.
shape("wide-tree", {
	async build(dir) {
		const out: string[] = []
		let mark = 0
		const seed: string[] = []
		for (let i = 0; i < WIDE; i++) {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata 6\n${filler(`w${i}`, 5)}\n\n`)
			seed.push(`M 100644 :${m} wide/${i}.txt`)
		}
		let prev = ++mark
		out.push(
			`commit refs/heads/main\nmark :${prev}\ncommitter ${WHO}\ndata 2\nc0\n${seed.join("\n")}\n\n`,
		)
		for (let c = 0; c < 60; c++) {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata 6\n${filler(`u${c}`, 5)}\n\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nc${c % 10}\nfrom :${prev}\nM 100644 :${m} wide/${c}.txt\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
})

// 11. Orphan branches sharing identical trees (tree reuse across unrelated history).
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
					`commit refs/heads/o${br}\nmark :${cm}\ncommitter ${WHO}\ndata 3\nm${i % 7}\n` +
						(prev ? `from :${prev}\n` : "") +
						`M 100644 :${b} d/${i}.txt\n\n`,
				)
				prev = cm
			}
		}
		await fastImport(dir, out.join(""))
	},
})

// 12. First-parent chain diverging from topo order + root commit appearing mid-history.
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
				`commit refs/heads/tmp\nmark :${rc}\ncommitter ${WHO}\ndata 2\nrt\nM 100644 :${rb} roots/${i}.txt\n\n`,
			)
			const mb = blob(`main-${i}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 2\nmn\n` +
					(prev ? `from :${prev}\n` : "") +
					`merge :${rc}\nM 100644 :${mb} main/${i}.txt\nM 100644 :${rb} roots/${i}.txt\n\n`,
			)
			prev = cm
		}
		out.push(`reset refs/heads/tmp\nfrom ${"0".repeat(40)}\n\n`)
		await fastImport(dir, out.join(""))
	},
})

// ── delta-heavy adversarial shapes (the tier only engages when trees GROW) ──

/** An append-only directory that gains one entry per commit, so each version of
 * the growing tree pairs with its predecessor and the delta actually wins. */
function growing(opts: {
	commits: number
	/** extra fast-import file commands per commit `i`, given a mark allocator */
	extraChanges?: (i: number, blob: (s: string) => number) => string[]
	/** entry added at commit `i` inside the growing dir */
	entry: (i: number, blob: (s: string) => number) => string
	branch?: string
}): (dir: string) => Promise<void> {
	return async (dir: string) => {
		const out: string[] = []
		let mark = 0
		const blob = (s: string): number => {
			const m = ++mark
			out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(s)}\n${s}\n`)
			return m
		}
		let prev = 0
		for (let i = 0; i < opts.commits; i++) {
			const changes = [opts.entry(i, blob), ...(opts.extraChanges?.(i, blob) ?? [])]
			const cm = ++mark
			out.push(
				`commit refs/heads/${opts.branch ?? "main"}\nmark :${cm}\ncommitter ${WHO}\ndata 3\nc${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					`${changes.join("\n")}\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	}
}

const uuidish = (i: number): string => {
	const h = createHash("sha1").update(`run-${i}`).digest("hex")
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// A. append-only growing dir, plain — the design's own motivating shape (baseline).
shape("growing-plain", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(filler(`e${i}`, 300))} runs/${uuidish(i)}/record.json`,
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
			const body = filler(`e${i}`, 300)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nx${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${b} runs/${uuidish(i)}/record.json\n\n`,
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
			`M 160000 ${createHash("sha1").update(`sub-${i}`).digest("hex")} mods/${uuidish(i)}`,
		extraChanges: (i, blob) => [
			`M 100644 :${blob(filler(`g${i}`, 200))} mods/${uuidish(i)}/inner.txt`,
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
				const body = filler(`n${i}-${k}`, 120)
				out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
				changes.push(`M 100644 :${m} "${d}/${uuidish(i)}.json"`)
			}
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nc${i % 10}\n` +
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
		entry: (i, blob) => `M 100644 :${blob(filler(`m${i}`, 250))} runs/${uuidish(i)}/rec`,
		extraChanges: (i, blob) => {
			const m = blob(filler(`p${i}`, 30 + (i % 7)))
			const phase = i % 4
			if (phase === 0) return [`D p`, `M 100644 :${m} p`]
			if (phase === 1) return [`D p`, `M 100755 :${m} p`]
			if (phase === 2) return [`D p`, `M 120000 :${m} p`]
			return [`D p`, `M 100644 :${m} p/inner`]
		},
	}),
	minDeltasServed: 1,
})

// E. deep nesting AND growth: a 120-level chain with a growing dir at the bottom.
shape("deep-growing", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(filler(`d${i}`, 250))} ${Array.from({ length: 120 }, (_, k) => `l${k}`).join("/")}/${uuidish(i)}/rec`,
	}),
	minDeltasServed: 1,
})

// F. a growing dir whose entries alternate between two blob contents forever
//    (the shape that produced delta CYCLES in the pre-star harness).
shape("growing-toggle", {
	build: growing({
		commits: 300,
		entry: (i, blob) => `M 100644 :${blob(filler(`t${i}`, 240))} runs/${uuidish(i)}/rec`,
		extraChanges: (i, blob) => [
			`M 100644 :${blob(i % 2 === 0 ? "A".repeat(500) : "B".repeat(500))} toggle/x`,
			`M 100644 :${blob(i % 2 === 0 ? "B".repeat(500) : "A".repeat(500))} toggle/y`,
		],
	}),
	minDeltasServed: 1,
})

// H. orphan an ANCHOR while a DELTA against it stays reachable (design N3), driven
//    entirely over the wire: a second ref reuses a mid-lineage tree, then `main` is
//    DELETED (pggit denies non-fast-forward pushes, so ref deletion is the orphan
//    generator a real client actually has).
shape("orphan-anchor-tree-reuse", {
	build: growing({
		commits: 300,
		entry: (i, blob) => `M 100644 :${blob(filler(`o${i}`, 260))} runs/${uuidish(i)}/rec`,
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
			const body = filler(`rw${i}`, 260)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nr${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${b} rewritten/${uuidish(i)}/rec\n\n`,
			)
			prev = cm
		}
		await fastImport(side, out.join(""))
		await spawnGit(["push", "-q", "--force", url, "refs/heads/main:refs/heads/main"], {
			cwd: side,
		}).catch(() => {
			/* expected: refs only advance — but the pack was ingested */
		})
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
				`M 100644 :${blob(filler(`rec${i}`, 300))} runs/${uuidish(i)}/record.json`,
				`M 100644 :${blob(filler(`err${i}`, 40))} runs/${uuidish(i)}/stderr`,
				`M 160000 ${createHash("sha1").update(`sub${i}`).digest("hex")} runs/${uuidish(i)}/mod`,
				`M 120000 :${blob(`../${uuidish(i % 7)}`)} links/l${i % 11}`,
				`M 100755 :${blob(filler(`sh${i}`, 90))} bin/run${i % 13}.sh`,
				`M 100644 :${blob(filler(`d${i}`, 120))} ${deep}/${uuidish(i)}.txt`,
				`M 100644 :${blob(filler(`w${i}`, 60))} wide/${i % 500}.txt`,
				`M 100644 :${blob(filler(`nu${i}`, 80))} "\\303\\251/${uuidish(i)}"`,
				`M 100644 :${blob(filler(`nu2${i}`, 80))} "e\\314\\201/${uuidish(i)}"`,
			]
			const phase = i % 4
			const pm = blob(filler(`p${i}`, 25 + (i % 5)))
			if (phase === 0) changes.push("D p", `M 100644 :${pm} p`)
			else if (phase === 1) changes.push("D p", `M 100755 :${pm} p`)
			else if (phase === 2) changes.push("D p", `M 120000 :${pm} p`)
			else changes.push("D p", `M 100644 :${pm} p/inner`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nc${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					(i > 0 && i % 50 === 0 && side ? `merge :${side}\n` : "") +
					`${changes.join("\n")}\n\n`,
			)
			prev = cm
			if (i % 50 === 25) {
				// an independent side ROOT commit merged in 25 commits later
				const sc = ++mark
				out.push(
					`commit refs/heads/side\nmark :${sc}\ncommitter ${WHO}\ndata 3\ns${i % 10}\n` +
						`M 100644 :${blob(filler(`sd${i}`, 200))} side/${uuidish(i)}.txt\n\n`,
				)
				side = sc
			}
			if (i % 97 === 0) {
				out.push(`tag v${i}\nfrom :${cm}\ntagger ${WHO}\ndata 3\nt${i % 10}\n\n`)
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
			const body = filler(`x${i}`, 300)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\ny${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${b} runs/${uuidish(i)}/record.json\n\n`,
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
		entry: (i, blob) => `M 100644 :${blob(filler(`l${i}`, 400))} src/main.txt`,
	}),
	minDeltasServed: 1,
})

// K. mergetag / gpgsig-style multi-line commit headers — repack parses parent
//    ORDER out of commit CONTENT, so an embedded tag object inside a commit
//    header is the adversarial input for that parser.
shape("mergetag", {
	async build(dir) {
		// (the sweep already `git init -q -b main`s `dir`, so this shape starts from a
		// worktree it can check out and merge in)
		const out: string[] = []
		let mark = 0
		let prev = 0
		for (let i = 0; i < 40; i++) {
			const b = ++mark
			const body = filler(`mt${i}`, 200)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nc${i % 10}\n` +
					(prev ? `from :${prev}\n` : "") +
					`M 100644 :${b} runs/${uuidish(i)}/rec\n\n`,
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

// L. a GROWING directory whose entry names are adversarial AND maximally
//    repetitive — 64 identical bytes per name, so the delta encoder's 16-byte
//    block index degenerates to a few keys and its CHAIN_LIMIT=64 candidate cap
//    is hit on every position. Names also cover the "a-b" < "a.b" < "a/" tree
//    sort adjacency, spaces, tabs, quotes, and pure-numeric segments.
shape("growing-repetitive-names", {
	build: growing({
		commits: 300,
		entry: (i, blob) =>
			`M 100644 :${blob(filler(`r${i}`, 200))} "${"a".repeat(64)}${String(i).padStart(6, "0")}"`,
		extraChanges: (i, blob) => {
			const m = blob(filler(`s${i}`, 100))
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
			const body = filler(`r${i}`, 200)
			out.push(`blob\nmark :${b}\ndata ${Buffer.byteLength(body)}\n${body}\n`)
			const cm = ++mark
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${WHO}\ndata 3\nq${i % 10}\n` +
					(prev ? `from :${prev}\n` : `from ${tip}\n`) +
					`M 100644 :${b} "${"a".repeat(64)}${String(i).padStart(6, "0")}"\n\n`,
			)
			prev = cm
		}
		await fastImport(dir, out.join(""))
	},
	minDeltasServed: 1,
})

/** The sweep list: every shape EXCEPT the one confirmed defect, which has its own
 * destination test. This is exactly the source script's no-argument default. */
const SWEEP = [...shapes.keys()].filter((k) => k !== "many-tiny-objects")

describe("shapes — the adversarial repo-shape sweep (negative results)", () => {
	let db: IsolatedDb
	let server: GitServer
	let repack: Repack
	let gc: Gc

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		repack = createRepack(db.sql)
		gc = createGc(db.sql)
		// `instrument: true` is load-bearing: the per-shape REF_DELTA readout below is
		// only collected when the app wraps each request in a collector.
		server = await serveOnPort(
			createGitApp(createGitDeps(db.sql), { instrument: true }),
			0,
		)
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
	})

	/**
	 * Drive one shape through the whole pipeline against a `file://` bare remote
	 * running the identical dance. Every judgement is real git's: clone/fetch
	 * success, `fsck --strict`, and byte-identical object/ref sets.
	 */
	async function runShape(name: string): Promise<void> {
		const s = shapes.get(name)
		if (!s) throw new Error(`unknown shape ${name}`)

		const scratch: string[] = []
		const mk: Mk = (tag) => {
			const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
			scratch.push(d)
			return d
		}

		try {
			const src = join(mk(name), "src")
			await spawnGit(["init", "-q", "-b", "main", src])
			await s.build(src)
			const srcObjs = await objectList(src)
			console.log(
				`shape ${name} — source: ${srcObjs.length} objects, ${(await refList(src)).length} refs`,
			)

			// The oracle: a plain bare git remote driven through the identical dance.
			const mirror = join(mk(`${name}-mirror`), "m.git")
			await spawnGit(["init", "-q", "--bare", mirror])
			await spawnGit(["config", "uploadpack.allowFilter", "true"], { cwd: mirror })
			await spawnGit(["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: mirror })
			await spawnGit(["push", "-q", mirror, ...PUSH_REFSPECS], { cwd: src })
			const ctl = join(mk(`${name}-ctl`), "c.git")
			await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, ctl])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: ctl })
			const ctlObjs = await objectList(ctl)

			const url = `http://127.0.0.1:${server.port}/${name}`
			await spawnGit(["push", "-q", url, ...PUSH_REFSPECS], { cwd: src })

			const pre = join(mk(`${name}-pre`), "c.git")
			await spawnGit(["clone", "-q", "--bare", url, pre])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: pre })
			const preObjs = await objectList(pre)
			expect(preObjs.length).toBe(ctlObjs.length)
			expect(preObjs.join("\n")).toBe(ctlObjs.join("\n"))

			const t0 = Date.now()
			const res = await repack.repack(name)
			console.log(
				`shape ${name} — repack: ${res.wholes} wholes + ${res.deltas} deltas in ${Date.now() - t0}ms`,
			)

			const post = join(mk(`${name}-post`), "c.git")
			resetCollected()
			await spawnGit(["clone", "-q", "--bare", url, post])
			const fr = collectedRuns().find((r) => r.label === "fetch")
			const deltasServed = fr?.counters.get("deltasServed") ?? 0
			console.log(
				`shape ${name} — served: ${deltasServed} REF_DELTA entries, ` +
					`pack ${fr?.counters.get("packBytes") ?? 0} B`,
			)
			// The proof the delta path was actually ON for this shape. Every shape
			// carrying a floor is built so the delta wins; without this the whole sweep
			// stays green with deltified serving deleted.
			if (s.minDeltasServed !== undefined) {
				expect(
					deltasServed,
					`${name}: the delta serve path was not exercised`,
				).toBeGreaterThanOrEqual(s.minDeltasServed)
			}
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: post })
			const postObjs = await objectList(post)
			expect(postObjs.length).toBe(ctlObjs.length)
			expect(postObjs.join("\n")).toBe(ctlObjs.join("\n"))

			// partial-clone filters against the repacked repo (a delta whose base is
			// filtered OUT of the served set must fall back to its whole form).
			for (const f of ["blob:none", "tree:0"]) {
				const pf = join(mk(`${name}-pf`), "c.git")
				const cf = join(mk(`${name}-cf`), "c.git")
				await spawnGit(["clone", "-q", "--bare", `--filter=${f}`, `file://${mirror}`, cf])
				await spawnGit(["clone", "-q", "--bare", `--filter=${f}`, url, pf])
				// "usable" asserted, not assumed — every other clone in this function
				// is fsck'd and these were not.
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: pf })
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: cf })
				const pgSet = new Set(await objectList(pf))
				const ctlSet = new Set(await objectList(cf))
				if (f === "tree:0") {
					// tree:0 is a KNOWN pre-existing gap (pggit ignores it and ships a
					// superset — src/e2e/transport-filter-tree0.test.ts). Pin the
					// documented behaviour rather than nothing: the served set must
					// CONTAIN the control's, so a change in the shape of the gap fails
					// loudly instead of passing unnoticed.
					expect(
						[...ctlSet].filter((o) => !pgSet.has(o)),
						`${name}: pggit's tree:0 clone is MISSING objects the control served`,
					).toEqual([])
				} else {
					expect([...pgSet].sort().join("\n")).toBe([...ctlSet].sort().join("\n"))
				}
			}

			const postRefs = await refList(post)
			const ctlRefs = await refList(ctl)
			expect(postRefs).toEqual(ctlRefs)

			if (s.extend) {
				await s.extend(src)
				const pushArgs = s.force ? ["push", "-q", "--force"] : ["push", "-q"]
				await spawnGit([...pushArgs, mirror, ...PUSH_REFSPECS], { cwd: src })
				await spawnGit([...pushArgs, url, ...PUSH_REFSPECS], { cwd: src })
				const res2 = await repack.repack(name)
				console.log(
					`shape ${name} — repack2: ${res2.wholes} wholes + ${res2.deltas} deltas`,
				)
				await spawnGit(["fetch", "-q", "--tags", "--force", url, ...PUSH_REFSPECS], {
					cwd: post,
				})
				await spawnGit(
					["fetch", "-q", "--tags", "--force", `file://${mirror}`, ...PUSH_REFSPECS],
					{
						cwd: ctl,
					},
				)
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: post })
				const inc = await objectList(post)
				const ctl2 = await objectList(ctl)
				expect(inc.length).toBe(ctl2.length)
				expect(inc.join("\n")).toBe(ctl2.join("\n"))
			}

			if (s.mutate) {
				await s.mutate(src, url, mirror, mk)
				const resM = await repack.repack(name)
				console.log(
					`shape ${name} — repackM: ${resM.wholes} wholes + ${resM.deltas} deltas`,
				)
				const mp = join(mk(`${name}-mp`), "c.git")
				const mc = join(mk(`${name}-mc`), "c.git")
				await spawnGit(["clone", "-q", "--bare", url, mp])
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: mp })
				await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, mc])
				expect((await objectList(mp)).join("\n")).toBe((await objectList(mc)).join("\n"))
				expect(await refList(mp)).toEqual(await refList(mc))
			}

			const gcRes = await gc.gc(name, { graceSeconds: 0 })
			const res3 = await repack.repack(name)
			console.log(
				`shape ${name} — gc: ${gcRes.deletedObjects} objs; repack3: ${res3.wholes}+${res3.deltas}`,
			)
			const gcd = join(mk(`${name}-gcd`), "c.git")
			await spawnGit(["clone", "-q", "--bare", url, gcd])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: gcd })
			const gcdObjs = await objectList(gcd)
			const ctlFresh = join(mk(`${name}-ctlf`), "c.git")
			await spawnGit(["clone", "-q", "--bare", `file://${mirror}`, ctlFresh])
			const ctlFinal = await objectList(ctlFresh)
			expect(gcdObjs.length).toBe(ctlFinal.length)
			expect(gcdObjs.join("\n")).toBe(ctlFinal.join("\n"))
		} finally {
			for (const d of scratch) rmSync(d, { force: true, recursive: true })
		}
	}

	for (const name of SWEEP) {
		it(`${name}: survives push → repack → clone → fetch → gc, identical to a file:// control`, async () => {
			await runShape(name)
		}, 600_000)
	}
})

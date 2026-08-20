/**
 * WIRE — seeded differential fuzz over repository SHAPES, against a plain bare git
 * remote. (Converted from `breakage/wire--shape-fuzz-differential.ts`.)
 *
 * The repack pass recovers "lineages" by diffing each commit's root tree against
 * its FIRST parent's and recursing into same-NAME subtrees. That recursion is where
 * a wrong base pairing (or a type confusion between a tree entry and a blob /
 * symlink / gitlink entry of the same name) would be born, and the serve rule then
 * has to survive whatever it produced. Shapes real repos have and the append-only
 * fixture does not:
 *
 *   - merges (root tree pairs with FIRST parent only), octopus merges
 *   - orphan roots, empty commits (tree reused verbatim), reverts (old tree reused)
 *   - a path that flips between blob / subtree / symlink / gitlink across commits
 *   - non-UTF8 and case-colliding directory names (the pairing map is keyed by a
 *     utf8-decoded name)
 *   - deep nesting and wide flat directories in the same tree
 *   - annotated tags and tag-of-tag chains over the above
 *
 * Every generated repo is pushed to BOTH pggit (then repacked) and a plain bare git
 * remote, then cloned from each; the two clones must agree object-for-object and
 * byte-for-byte, and pggit's clone must be `fsck --strict` clean. The seeds are
 * pinned, so a failing shape is reproducible.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import { objectsByType } from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const SHAPES = 8
const SEED0 = 1
/** Commits per generated repo — long enough to cross ANCHOR_EVERY=32 segments. */
const COMMITS = 110
const SINGLE_REF_FETCHES = ["refs/heads/main", "refs/tags/outer", "refs/tags/ontree"]

type ShapeResult = {
	seed: number
	clone: TestResult<{
		fsck: TestResult<void>
		pggitInventory: string
		gitInventory: string
		pggitBytes: string
		gitBytes: string
		blobless: TestResult<void>
		singleRefs: Map<string, TestResult<void>>
	}>
}

/** mulberry32 — a tiny deterministic PRNG so a failing shape is reproducible. */
function rng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Directory/file name bytes — every fragment VALID UTF-8, since D16 rejects a
 * non-UTF-8 path at ingest (that contract has its own tests:
 * `pg-corrupt--non-utf8-path-collision`, `non-utf8-paths`). The exotic coverage
 * lives in look-alikes a normalizing layer could collapse: NFC "é" beside NFD
 * "é" (distinct bytes, identical rendering) and a case-folding pair. */
const NAME_BYTES: Buffer[] = [
	Buffer.from("alpha"),
	Buffer.from("Alpha"), // case-collides with the above on case-folding paths
	Buffer.from("beta"),
	Buffer.from([0xc3, 0xa9]), // valid utf8 "é" (NFC)
	Buffer.from([0x65, 0xcc, 0x81]), // valid utf8 "é" (NFD) — renders like NFC, distinct bytes
	Buffer.from("nested"),
	Buffer.from("wide"),
	Buffer.from("a".repeat(120)),
	Buffer.from("z-with space-and\ttab"),
]

type Entry = { mode: string; type: string; oid: string; name: Buffer }

/** Build a tree object from entries via `mktree -z` (NUL-separated → raw name bytes). */
async function mktree(dir: string, entries: Entry[]): Promise<string> {
	const parts: Buffer[] = []
	for (const e of entries) {
		parts.push(Buffer.from(`${e.mode} ${e.type} ${e.oid}\t`), e.name, Buffer.from([0x00]))
	}
	const out = await spawnGit(["mktree", "-z"], { cwd: dir, input: Buffer.concat(parts) })
	return out.stdout.trim()
}

async function hashBlob(dir: string, content: string): Promise<string> {
	const out = await spawnGit(["hash-object", "-w", "-t", "blob", "--stdin"], {
		cwd: dir,
		input: content,
	})
	return out.stdout.trim()
}

/** Generate one repository shape into `dir`. */
async function generate(dir: string, seed: number): Promise<void> {
	const rand = rng(seed)
	const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length) % xs.length] as T
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })

	const blobs: string[] = []
	for (let i = 0; i < 24; i++) {
		blobs.push(await hashBlob(dir, `blob ${seed}-${i}\n`.repeat(3)))
	}
	const emptyBlob = await hashBlob(dir, "")

	// The evolving directory model: path (as a joined key) → entry list.
	type Dir = Map<string, Entry>
	const wide: Dir = new Map()
	const nested: Dir = new Map()
	const root: Dir = new Map()

	const dirToEntries = (d: Dir): Entry[] => [...d.values()]
	let head: string | null = null
	const commits: string[] = []

	for (let i = 0; i < COMMITS; i++) {
		// The wide flat directory grows by one entry per commit (the shape that makes
		// the star topology matter), with occasional churn.
		wide.set(`w${i}`, {
			mode: "100644",
			name: Buffer.from(`entry-${String(i).padStart(4, "0")}-${seed}`),
			oid: pick(blobs),
			type: "blob",
		})
		if (i % 7 === 3 && wide.size > 4) {
			const victim = [...wide.keys()][1] as string
			wide.delete(victim)
		}

		// A path whose KIND flips: blob → subtree → symlink → gitlink → back.
		const flipName = Buffer.from("flip")
		const kinds: Entry[] = [
			{ mode: "100644", name: flipName, oid: pick(blobs), type: "blob" },
			{ mode: "100755", name: flipName, oid: pick(blobs), type: "blob" },
			{ mode: "120000", name: flipName, oid: pick(blobs), type: "blob" },
		]
		const flip = kinds[i % kinds.length] as Entry
		nested.set("flip", flip)
		if (i % 5 === 0) {
			// Occasionally `flip` becomes a real subtree instead.
			const sub = await mktree(dir, [
				{ mode: "100644", name: Buffer.from("inner"), oid: pick(blobs), type: "blob" },
				{
					mode: "100644",
					name: Buffer.from(`n${i}`),
					oid: pick([...blobs, emptyBlob]),
					type: "blob",
				},
			])
			nested.set("flip", { mode: "40000", name: flipName, oid: sub, type: "tree" })
		}
		// Deep nesting under a randomly picked (sometimes invalid-utf8) name.
		let deep = await mktree(dir, [
			{ mode: "100644", name: Buffer.from("leaf"), oid: pick(blobs), type: "blob" },
		])
		for (let d = 0; d < 3; d++) {
			deep = await mktree(dir, [
				{ mode: "40000", name: pick(NAME_BYTES), oid: deep, type: "tree" },
				{ mode: "100644", name: Buffer.from(`d${d}`), oid: pick(blobs), type: "blob" },
			])
		}
		nested.set("deep", {
			mode: "40000",
			name: Buffer.from("deep"),
			oid: deep,
			type: "tree",
		})

		const wideTree = await mktree(dir, dirToEntries(wide))
		const nestedTree = await mktree(dir, dirToEntries(nested))
		root.set("wide", {
			mode: "40000",
			name: Buffer.from("wide"),
			oid: wideTree,
			type: "tree",
		})
		root.set("nested", {
			mode: "40000",
			name: Buffer.from("nested"),
			oid: nestedTree,
			type: "tree",
		})
		// Two sibling directories whose names are DIFFERENT invalid-utf8 bytes: the
		// repack pairing map decodes names as utf8, which collapses both to U+FFFD.
		for (const [key, nameBytes] of [
			["bad1", NAME_BYTES[3] as Buffer],
			["bad2", NAME_BYTES[4] as Buffer],
		] as const) {
			const t = await mktree(dir, [
				{
					mode: "100644",
					name: Buffer.from(`${key}-${i}`),
					oid: pick(blobs),
					type: "blob",
				},
			])
			root.set(key, { mode: "40000", name: nameBytes, oid: t, type: "tree" })
		}
		// A gitlink pointing at a real commit from this repo (dangling is legal too).
		if (commits.length > 0 && i % 11 === 6) {
			root.set("sub", {
				mode: "160000",
				name: Buffer.from("sub"),
				oid: pick(commits),
				type: "commit",
			})
		}

		const rootTree = await mktree(dir, dirToEntries(root))

		// Parents: usually the previous commit; sometimes a merge; sometimes an orphan.
		const args = ["commit-tree", rootTree, "-m", `c${i}`]
		const roll = rand()
		if (head === null || roll < 0.04) {
			// orphan root — no parents
		} else if (roll < 0.14 && commits.length > 3) {
			args.push("-p", head, "-p", pick(commits)) // merge
		} else if (roll < 0.17 && commits.length > 6) {
			args.push("-p", head, "-p", pick(commits), "-p", pick(commits)) // octopus
		} else {
			args.push("-p", head)
		}
		const commit = (await spawnGit(args, { cwd: dir })).stdout.trim()
		commits.push(commit)
		head = commit

		if (i % 29 === 17) {
			await spawnGit(["update-ref", `refs/heads/br${i}`, commit], { cwd: dir })
			// Branching back in time: continue from an older commit for a while.
			head = pick(commits)
		}
		if (i % 23 === 9) {
			// An "empty" commit: the SAME tree, a new commit object.
			const same = (
				await spawnGit(["commit-tree", rootTree, "-p", commit, "-m", `empty${i}`], {
					cwd: dir,
				})
			).stdout.trim()
			commits.push(same)
			head = same
		}
	}

	await spawnGit(["update-ref", "refs/heads/main", head as string], { cwd: dir })

	// Annotated tags, including a tag-of-tag chain and a tag on a TREE.
	const t1 = (
		await spawnGit(["mktag"], {
			cwd: dir,
			input: `object ${pick(commits)}\ntype commit\ntag inner\ntagger pggit oracle <oracle@pggit.test> 1700000000 +0000\n\ninner\n`,
		})
	).stdout.trim()
	const t2 = (
		await spawnGit(["mktag"], {
			cwd: dir,
			input: `object ${t1}\ntype tag\ntag outer\ntagger pggit oracle <oracle@pggit.test> 1700000000 +0000\n\nouter\n`,
		})
	).stdout.trim()
	await spawnGit(["update-ref", "refs/tags/outer", t2], { cwd: dir })
	await spawnGit(["update-ref", "refs/tags/inner", t1], { cwd: dir })

	const treeOid = (
		await spawnGit(["rev-parse", "refs/heads/main^{tree}"], { cwd: dir })
	).stdout.trim()
	const t3 = (
		await spawnGit(["mktag"], {
			cwd: dir,
			input: `object ${treeOid}\ntype tree\ntag ontree\ntagger pggit oracle <oracle@pggit.test> 1700000000 +0000\n\non a tree\n`,
		})
	).stdout.trim()
	await spawnGit(["update-ref", "refs/tags/ontree", t3], { cwd: dir })
}

/** Sorted `<oid> <type> <size>` for every object present locally. */
async function inventory(dir: string): Promise<string> {
	const res = await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], {
		cwd: dir,
	})
	return res.stdout.split("\n").filter(Boolean).sort().join("\n")
}

/** sha256 over every object's raw bytes, in oid order — the byte-level oracle. */
async function bytesDigest(dir: string): Promise<string> {
	const oids = (await objectsByType(dir)).map((object) => object.oid).sort()
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
	})
	return createHash("sha256").update(res.stdoutBytes).digest("hex")
}

describe("wire — generated repository shapes match a plain git remote exactly", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	const shapes: ShapeResult[] = []

	beforeAll(async () => {
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const repack = createRepack(db.sql)

		for (let s = 0; s < SHAPES; s++) {
			const seed = SEED0 + s * 7919
			const src = mk(`src${seed}`)
			await generate(src, seed)

			const bare = join(mk(`bare${seed}`), "oracle.git")
			await spawnGit(["init", "-q", "--bare", bare])
			await spawnGit(["config", "uploadpack.allowFilter", "true"], { cwd: bare })
			await spawnGit(
				[
					"push",
					"-q",
					`file://${bare}`,
					"refs/heads/*:refs/heads/*",
					"refs/tags/*:refs/tags/*",
				],
				{ cwd: src },
			)

			// Each shape gets its own repo NAME in the one schema — repack, GC and the
			// serve path are all per-repo, so the shapes cannot see each other.
			const repo = `workspace/fuzz/s${seed}`
			const url = repoUrl(server, repo)
			await spawnGit(
				["push", "-q", url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
				{ cwd: src },
			)
			await repack.repack(repo)

			const dP = join(mk(`cP${seed}`), "c")
			const dG = join(mk(`cG${seed}`), "c")
			const clone = await captureTestResult(() =>
				spawnGit([
					"-c",
					"protocol.version=2",
					"-c",
					"transfer.fsckobjects=true",
					"-c",
					"fetch.fsckobjects=true",
					"clone",
					"-q",
					"--no-checkout",
					url,
					dP,
				]),
			)
			await spawnGit(["clone", "-q", "--no-checkout", `file://${bare}`, dG])
			if (clone.kind === "failed") {
				shapes.push({ clone, seed })
				continue
			}

			const fsck = await captureTestResult(async () => {
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dP })
			})

			// Blobless clone over the same state.
			const dF = join(mk(`cF${seed}`), "c")
			const blobless = await captureTestResult(async () => {
				await spawnGit([
					"-c",
					"protocol.version=2",
					"-c",
					"transfer.fsckobjects=true",
					"clone",
					"-q",
					"--filter=blob:none",
					"--no-checkout",
					url,
					dF,
				])
				await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dF })
			})

			// Single-ref fetches: each ref's own closure is a different served set, so
			// each exercises the delta-eligibility rule differently.
			const singleRefs = new Map<string, TestResult<void>>()
			for (const ref of SINGLE_REF_FETCHES) {
				const one = join(mk(`one${seed}`), "c")
				await spawnGit(["init", "-q", one])
				singleRefs.set(
					ref,
					await captureTestResult(async () => {
						await spawnGit(
							[
								"-c",
								"protocol.version=2",
								"-c",
								"transfer.fsckobjects=true",
								"fetch",
								"-q",
								url,
								`${ref}:refs/probe/got`,
							],
							{ cwd: one },
						)
						await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: one })
					}),
				)
			}

			shapes.push({
				clone: {
					kind: "succeeded",
					value: {
						blobless,
						fsck,
						gitBytes: await bytesDigest(dG),
						gitInventory: await inventory(dG),
						pggitBytes: await bytesDigest(dP),
						pggitInventory: await inventory(dP),
						singleRefs,
					},
				},
				seed,
			})
		}
	}, 1_200_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("clones every generated shape from pggit, fsck-clean", () => {
		expect(shapes.length).toBe(SHAPES)
		for (const s of shapes) {
			const at = `seed ${s.seed}`
			expect(s.clone.kind, testResultContext(s.clone, at)).toBe("succeeded")
			if (s.clone.kind === "succeeded") {
				expect(
					s.clone.value.fsck.kind,
					testResultContext(s.clone.value.fsck, `${at} fsck`),
				).toBe("succeeded")
			}
		}
	})

	it("serves the same object set and the same object BYTES as a plain git remote", () => {
		for (const s of shapes) {
			if (s.clone.kind === "failed") continue
			expect(s.clone.value.pggitInventory, `seed ${s.seed}`).toBe(
				s.clone.value.gitInventory,
			)
			expect(s.clone.value.pggitBytes, `seed ${s.seed}`).toBe(s.clone.value.gitBytes)
		}
	})

	it("serves a blobless clone of every generated shape", () => {
		for (const s of shapes) {
			if (s.clone.kind === "failed") continue
			const result = s.clone.value.blobless
			expect(result.kind, testResultContext(result, `seed ${s.seed}`)).toBe("succeeded")
		}
	})

	it("serves each ref's own closure on a single-ref fetch of every shape", () => {
		for (const s of shapes) {
			if (s.clone.kind === "failed") continue
			for (const ref of SINGLE_REF_FETCHES) {
				const result = s.clone.value.singleRefs.get(ref)
				const at = `seed ${s.seed} — ${ref}`
				expect(result?.kind, result ? testResultContext(result, at) : at).toBe(
					"succeeded",
				)
			}
		}
	})
})

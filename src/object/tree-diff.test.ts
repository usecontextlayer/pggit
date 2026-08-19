import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { diffFileLists } from "@/object/tree-diff"
import { spawnGit } from "@/testing/spawn-git"

/**
 * tree-diff vs `git diff-tree` — the oracle test written BEFORE the
 * implementation (spine S3). `diffFileLists(read, beforeTree, afterTree)` must
 * report exactly what `git diff-tree -r --no-renames` reports for the same pair
 * of commits: removed paths, and added/changed files with their (mode, blob).
 * Mode-only changes count as changed (R14: the diff pairs by name and compares
 * (mode, oid), not oid alone).
 */

type Change = { status: string; path: string; mode: string; oid: string }

/** `git diff-tree -r --no-renames A B` parsed: status + AFTER-side mode/oid. */
async function gitDiff(dir: string, a: string, b: string): Promise<Change[]> {
	const out = await spawnGit(["diff-tree", "-r", "--no-renames", "-z", a, b], {
		cwd: dir,
	})
	const fields = out.stdout.split("\0").filter(Boolean)
	const changes: Change[] = []
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const meta = fields[i] as string
		const path = fields[i + 1] as string
		// :<oldmode> <newmode> <oldoid> <newoid> <status>
		const [, newMode, , newOid, status] = meta.replace(/^:/, "").split(/\s+/)
		changes.push({
			mode: (newMode as string).replace(/^0+/, "") || "0",
			oid: newOid as string,
			path,
			status: status as string,
		})
	}
	return changes
}

/** A TreeReader over an on-disk git repo (cat-file per oid). */
function repoReader(dir: string) {
	return async (oid: string) => {
		return (await spawnGit(["cat-file", "tree", oid], { cwd: dir })).stdoutBytes
	}
}

async function treeOf(dir: string, rev: string): Promise<string> {
	return (await spawnGit(["rev-parse", `${rev}^{tree}`], { cwd: dir })).stdout.trim()
}

describe("diffFileLists — file-level tree diff vs `git diff-tree -r`", () => {
	let dir = ""
	const commits: string[] = []

	/** Write files (null content = delete), commit, record the oid. */
	async function commit(files: Record<string, string | null>): Promise<void> {
		for (const [path, content] of Object.entries(files)) {
			const full = join(dir, path)
			if (content === null) {
				rmSync(full)
			} else {
				mkdirSync(dirname(full), { recursive: true })
				writeFileSync(full, content)
			}
		}
		await spawnGit(["add", "-A"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", `c${commits.length}`], { cwd: dir })
		commits.push((await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim())
	}

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pggit-treediff-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		// c0: a nested baseline.
		await commit({
			"a.txt": "one\n",
			"dir/inner.txt": "inner\n",
			"dir/sub/deep.txt": "deep\n",
			"z.txt": "zed\n",
		})
		// c1: add + change + remove across levels; untouched subtree stays.
		await commit({
			"a.txt": "one-changed\n",
			"b.txt": "new\n",
			"dir/inner.txt": null,
			"dir/other.txt": "other\n",
		})
		// c2: mode-only change (chmod +x) — content identical.
		await spawnGit(["update-index", "--chmod=+x", "b.txt"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "chmod"], { cwd: dir })
		commits.push((await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim())
		// c3: replace a whole subtree with a file of the same name, and vice versa.
		rmSync(join(dir, "dir/sub"), { force: true, recursive: true })
		writeFileSync(join(dir, "dir/sub"), "now-a-file\n")
		rmSync(join(dir, "z.txt"))
		mkdirSync(join(dir, "z.txt"))
		writeFileSync(join(dir, "z.txt/nested.txt"), "was-a-file\n")
		await spawnGit(["add", "-A"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "swap"], { cwd: dir })
		commits.push((await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim())
	}, 120_000)

	afterAll(() => {
		if (dir) rmSync(dir, { force: true, recursive: true })
	})

	/** Compare diffFileLists against git for the commit pair (i → j). */
	async function assertMatchesGit(i: number, j: number): Promise<void> {
		const read = repoReader(dir)
		const before = await treeOf(dir, commits[i] as string)
		const after = await treeOf(dir, commits[j] as string)
		const got = await diffFileLists(read, before, after)

		const expected = await gitDiff(dir, commits[i] as string, commits[j] as string)
		const expectedRemoved = expected
			.filter((c) => c.status === "D")
			.map((c) => c.path)
			.sort()
		const expectedUpserts = expected
			.filter((c) => c.status === "A" || c.status === "M" || c.status === "T")
			.map((c) => `${c.path} ${c.mode} ${c.oid}`)
			.sort()

		expect([...got.removed].sort()).toEqual(expectedRemoved)
		expect(got.upserts.map((u) => `${u.path} ${u.mode} ${u.blobOid}`).sort()).toEqual(
			expectedUpserts,
		)
	}

	it("adds + changes + removals across levels, untouched subtrees pruned", async () => {
		await assertMatchesGit(0, 1)
	})

	it("a mode-only change (chmod) is reported as changed", async () => {
		await assertMatchesGit(1, 2)
	})

	it("a file↔directory swap at one path", async () => {
		await assertMatchesGit(2, 3)
	})

	it("the reverse direction of every pair matches too", async () => {
		await assertMatchesGit(1, 0)
		await assertMatchesGit(3, 2)
	})

	it("identical trees diff to nothing", async () => {
		const read = repoReader(dir)
		const t = await treeOf(dir, commits[0] as string)
		const got = await diffFileLists(read, t, t)
		expect(got.removed).toEqual([])
		expect(got.upserts).toEqual([])
	})
})

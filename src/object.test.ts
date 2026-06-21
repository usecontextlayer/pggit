import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { commitTreeOid, computeOid, type GitObjectType, treeEntries } from "@/object"
import { parseLsTree } from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"

describe("computeOid", () => {
	it("computes a blob OID matching git hash-object", async () => {
		const content = Buffer.from("hello\n")
		const dir = mkdtempSync(join(tmpdir(), "pggit-oid-"))
		try {
			const file = join(dir, "obj")
			writeFileSync(file, content)
			const { stdout } = await spawnGit(["hash-object", "-t", "blob", file])
			expect(computeOid("blob", content)).toBe(stdout.trim())
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("matches git for every object type in a real repo (blob, tree, commit, tag)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-oid-all-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "hello\n")
			writeFileSync(join(dir, "b.txt"), "world\n")
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "seed"], { cwd: dir })
			await spawnGit(["tag", "-a", "v1", "-m", "release"], { cwd: dir })

			const list = await spawnGit(
				["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
				{ cwd: dir },
			)
			const typesSeen = new Set<string>()
			for (const line of list.stdout.trim().split("\n")) {
				const [oid, type] = line.split(" ")
				if (!oid || !type) throw new Error(`unexpected batch-check line: ${line}`)
				const raw = await spawnGit(["cat-file", type, oid], { cwd: dir })
				expect(computeOid(type as GitObjectType, raw.stdoutBytes)).toBe(oid)
				typesSeen.add(type)
			}
			expect(typesSeen).toEqual(new Set(["blob", "tree", "commit", "tag"]))
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe("treeEntries", () => {
	it("parses mode, name, oid for each entry, matching git ls-tree", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-tree-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			mkdirSync(join(dir, "sub"))
			writeFileSync(join(dir, "a.txt"), "alpha\n")
			writeFileSync(join(dir, "sub", "b.txt"), "beta\n")
			writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n")
			chmodSync(join(dir, "run.sh"), 0o755)
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })

			const treeOid = (
				await spawnGit(["rev-parse", "HEAD^{tree}"], { cwd: dir })
			).stdout.trim()
			const raw = await spawnGit(["cat-file", "tree", treeOid], { cwd: dir })

			// Oracle: `git ls-tree` lines are `<mode> <type> <oid>\t<name>`, with the
			// mode zero-padded to 6 (git's display form). parseTreeEntries returns the
			// raw stored mode ("40000" for a subtree), so pad it to compare.
			const expected = parseLsTree(
				(await spawnGit(["ls-tree", treeOid], { cwd: dir })).stdout,
			).map((e) => ({ mode: e.mode, name: e.path, oid: e.oid }))
			const got = treeEntries(raw.stdoutBytes).map((e) => ({
				mode: e.mode.padStart(6, "0"),
				name: e.name,
				oid: e.oid,
			}))
			expect(got).toEqual(expected)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe("commitTreeOid", () => {
	it("extracts the root tree oid from a commit, matching git", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-commit-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })

			const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
			const raw = await spawnGit(["cat-file", "commit", head], { cwd: dir })
			const expected = (
				await spawnGit(["rev-parse", "HEAD^{tree}"], { cwd: dir })
			).stdout.trim()
			expect(commitTreeOid(raw.stdoutBytes)).toBe(expected)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

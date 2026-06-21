import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ObjectReader } from "@/graph-walk"
import type { GitObjectType } from "@/object"
import { buildFileList } from "@/repo-view/build-file-list"
import { parseLsTree } from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"

/** An ObjectReader backed by a real git repo's object database (no Postgres). */
function gitObjectReader(dir: string): ObjectReader {
	return async (oid) => {
		const type = (await spawnGit(["cat-file", "-t", oid], { cwd: dir })).stdout.trim()
		const content = (await spawnGit(["cat-file", type, oid], { cwd: dir })).stdoutBytes
		return { content, type: type as GitObjectType }
	}
}

describe("buildFileList", () => {
	it("lists every file (path, mode, blob oid) for a commit, matching git ls-tree -r", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-bfl-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			mkdirSync(join(dir, "sub"))
			writeFileSync(join(dir, "a.txt"), "alpha\n")
			writeFileSync(join(dir, "sub", "b.txt"), "beta\n")
			writeFileSync(join(dir, "dup.txt"), "alpha\n") // same content as a.txt → shared blob
			writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n")
			chmodSync(join(dir, "run.sh"), 0o755)
			symlinkSync("a.txt", join(dir, "link")) // mode 120000, content = "a.txt"
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })

			const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
			const { files, blobs } = await buildFileList(gitObjectReader(dir), head)

			// Oracle: `git ls-tree -r` → `<mode> blob <oid>\t<path>` (recursive, blobs only).
			const expected = parseLsTree(
				(await spawnGit(["ls-tree", "-r", head], { cwd: dir })).stdout,
			)
				.map((e) => ({ blobOid: e.oid, mode: e.mode, path: e.path }))
				.sort((a, b) => a.path.localeCompare(b.path))
			const got = [...files].sort((a, b) => a.path.localeCompare(b.path))
			expect(got).toEqual(expected)

			// Every emitted blob's content matches git.
			for (const blob of blobs) {
				const raw = (await spawnGit(["cat-file", "blob", blob.oid], { cwd: dir }))
					.stdoutBytes
				expect(blob.content).toEqual(raw)
			}
			// Identical content (a.txt == dup.txt) is deduped to one blob; 4 unique
			// contents: "alpha\n", "beta\n", "#!/bin/sh\n", and the symlink target "a.txt".
			expect(blobs.length).toBe(new Set(blobs.map((b) => b.oid)).size)
			expect(blobs.length).toBe(4)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

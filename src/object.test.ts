import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { computeOid, type GitObjectType } from "@/object"
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

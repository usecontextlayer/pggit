import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	commitTreeOid,
	computeOid,
	type GitObjectType,
	treeEntries,
} from "@/object/object"
import { expectGitFormatError } from "@/testing/format-error"
import { spawnGit } from "@/testing/spawn-git"

/** A well-formed tree entry: `<mode> <name>\0<20-byte oid>`. */
function treeEntry(mode: string, name: string, oidByte: number): Buffer {
	return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.alloc(20, oidByte)])
}

describe("computeOid", () => {
	// The single-blob case is subsumed by this all-types differential (it runs the
	// same git-oracle comparison over blob+tree+commit+tag in a real repo).
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
	it("parses a well-formed tree (single + multiple entries)", () => {
		const tree = Buffer.concat([
			treeEntry("100644", "a.txt", 0xab),
			treeEntry("40000", "sub", 0xcd),
		])
		expect(treeEntries(tree)).toEqual([
			{ mode: "100644", name: "a.txt", oid: "ab".repeat(20) },
			{ mode: "40000", name: "sub", oid: "cd".repeat(20) },
		])
	})

	it("returns no entries for the empty tree", () => {
		expect(treeEntries(Buffer.alloc(0))).toEqual([])
	})

	it("names containing a space are split at the NUL, not the first space", () => {
		const tree = treeEntry("100644", "my file.txt", 0x11)
		expect(treeEntries(tree)).toEqual([
			{ mode: "100644", name: "my file.txt", oid: "11".repeat(20) },
		])
	})

	// Fail loud (CLAUDE.md): a malformed/truncated tree must THROW, not silently
	// return a short list — a short list would make `isConnected` report a corrupt
	// object connected, silently accepting bad data. Asserted by the stable code,
	// not the message text.
	it("throws on an entry with no NUL terminator", () => {
		expect(expectGitFormatError(() => treeEntries(Buffer.from("100644 a.txt")))).toBe(
			"malformed-tree",
		)
	})

	it("throws on a truncated trailing OID (fewer than 20 bytes)", () => {
		const truncated = Buffer.concat([
			Buffer.from("100644 a.txt\0"),
			Buffer.alloc(5, 0xab),
		])
		expect(expectGitFormatError(() => treeEntries(truncated))).toBe("malformed-tree")
	})

	it("throws on trailing garbage after a complete entry", () => {
		const tree = Buffer.concat([treeEntry("100644", "a.txt", 0xab), Buffer.from("xx")])
		expect(expectGitFormatError(() => treeEntries(tree))).toBe("malformed-tree")
	})
})

describe("commitTreeOid fail loud", () => {
	// Reachable on the repo-view projection path (build-file-list walks a pushed
	// commit's tree via commitTreeOid), so the guard is real, not dead defense.
	it("throws on a commit with no tree header", () => {
		expect(
			expectGitFormatError(() => commitTreeOid(Buffer.from("parent abc\n\nmsg\n"))),
		).toBe("missing-tree-header")
	})
})

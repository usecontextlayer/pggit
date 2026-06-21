import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	commitTreeOid,
	computeOid,
	type GitObjectType,
	referencedOids,
	treeEntries,
} from "@/object"
import { spawnGit } from "@/testing/spawn-git"

/** A well-formed tree entry: `<mode> <name>\0<20-byte oid>`. */
function treeEntry(mode: string, name: string, oidByte: number): Buffer {
	return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.alloc(20, oidByte)])
}

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
	// object connected, silently accepting bad data.
	it("throws on an entry with no NUL terminator", () => {
		expect(() => treeEntries(Buffer.from("100644 a.txt"))).toThrow(/malformed/)
	})

	it("throws on a truncated trailing OID (fewer than 20 bytes)", () => {
		const truncated = Buffer.concat([
			Buffer.from("100644 a.txt\0"),
			Buffer.alloc(5, 0xab),
		])
		expect(() => treeEntries(truncated)).toThrow(/malformed/)
	})

	it("throws on trailing garbage after a complete entry", () => {
		const tree = Buffer.concat([treeEntry("100644", "a.txt", 0xab), Buffer.from("xx")])
		expect(() => treeEntries(tree)).toThrow(/malformed/)
	})
})

describe("commitTreeOid / referencedOids fail loud", () => {
	it("commitTreeOid throws on a commit with no tree header", () => {
		expect(() => commitTreeOid(Buffer.from("parent abc\n\nmsg\n"))).toThrow(
			/no tree header/,
		)
	})

	it("referencedOids of a tree propagates the malformed-tree throw", () => {
		expect(() => referencedOids("tree", Buffer.from("100644 a.txt"))).toThrow(/malformed/)
	})
})

import { describe, expect, it } from "vitest"
import { GitFormatError } from "@/git-format-error"
import { deriveEdges, EDGE_KIND } from "@/object-edges"

/** A tree blob: `<mode> <name>\0<20-byte oid>` repeated. */
function tree(entries: { mode: string; name: string; oid: Buffer }[]): Buffer {
	return Buffer.concat(
		entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, "latin1"), e.oid]),
	)
}

const oid = (byte: number): Buffer => Buffer.alloc(20, byte)

describe("deriveEdges — the §4.3 standing rule", () => {
	it("a blob references nothing", () => {
		expect(deriveEdges("blob", Buffer.from("hello\n"))).toEqual([])
	})

	it("a commit → its tree (kind 1) then each parent (kind 2)", () => {
		const t = "a".repeat(40)
		const p1 = "b".repeat(40)
		const p2 = "c".repeat(40)
		const commit = Buffer.from(
			`tree ${t}\nparent ${p1}\nparent ${p2}\n` +
				"author a <a> 0 +0000\ncommitter a <a> 0 +0000\n\nmerge\n",
			"latin1",
		)
		expect(deriveEdges("commit", commit)).toEqual([
			{ child: t, kind: EDGE_KIND.COMMIT_TREE },
			{ child: p1, kind: EDGE_KIND.COMMIT_PARENT },
			{ child: p2, kind: EDGE_KIND.COMMIT_PARENT },
		])
	})

	it("a root commit (no parent) → only its tree", () => {
		const t = "a".repeat(40)
		const commit = Buffer.from(
			`tree ${t}\nauthor a <a> 0 +0000\ncommitter a <a> 0 +0000\n\nroot\n`,
			"latin1",
		)
		expect(deriveEdges("commit", commit)).toEqual([
			{ child: t, kind: EDGE_KIND.COMMIT_TREE },
		])
	})

	it("a tree → ONLY its subtrees (kind 3); blobs and gitlinks are not edges", () => {
		const sub = oid(0x11)
		const blob = oid(0x22)
		const gitlink = oid(0x33)
		const t = tree([
			{ mode: "40000", name: "dir", oid: sub },
			{ mode: "100644", name: "file.txt", oid: blob },
			{ mode: "160000", name: "submodule", oid: gitlink },
		])
		expect(deriveEdges("tree", t)).toEqual([
			{ child: sub.toString("hex"), kind: EDGE_KIND.TREE_SUBTREE },
		])
	})

	it("an annotated tag → its target (kind 5)", () => {
		const target = "d".repeat(40)
		const tag = Buffer.from(
			`object ${target}\ntype commit\ntag v1\ntagger a <a> 0 +0000\n\nrel\n`,
			"latin1",
		)
		expect(deriveEdges("tag", tag)).toEqual([
			{ child: target, kind: EDGE_KIND.TAG_TARGET },
		])
	})

	it("rejects a commit whose tree header is not a well-formed oid", () => {
		const commit = Buffer.from(`tree ${"z".repeat(40)}\n\nbad\n`, "latin1")
		try {
			deriveEdges("commit", commit)
			expect.fail("expected deriveEdges to throw on a malformed oid")
		} catch (e) {
			expect(e).toBeInstanceOf(GitFormatError)
			expect((e as GitFormatError).code).toBe("malformed-oid")
		}
	})
})

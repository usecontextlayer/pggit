import { describe, expect, it } from "vitest"
import { deriveCommitRow, deriveTagRow } from "@/object/derive"
import { GitFormatError } from "@/object/format-error"

/** Assert `fn` throws a GitFormatError and return its stable code. */
function formatErrorCode(fn: () => unknown): string {
	try {
		fn()
	} catch (e) {
		expect(e).toBeInstanceOf(GitFormatError)
		return (e as GitFormatError).code
	}
	return expect.fail("expected a GitFormatError")
}

describe("deriveCommitRow — content → git_commit row values", () => {
	it("a merge commit: tree, parents in CONTENT order, committer epoch", () => {
		const t = "a".repeat(40)
		const p1 = "b".repeat(40)
		const p2 = "c".repeat(40)
		const commit = Buffer.from(
			`tree ${t}\nparent ${p1}\nparent ${p2}\n` +
				"author a <a> 1699999999 +0100\ncommitter c <c> 1700000123 +0000\n\nmerge\n",
			"latin1",
		)
		expect(deriveCommitRow(commit)).toEqual({
			commitTime: 1_700_000_123,
			parents: [p1, p2],
			treeOid: t,
		})
	})

	it("a root commit has no parents; a negative epoch (pre-1970) parses", () => {
		const t = "a".repeat(40)
		const commit = Buffer.from(
			`tree ${t}\nauthor a <a> 0 +0000\ncommitter c <c> -172800 +0000\n\nroot\n`,
			"latin1",
		)
		expect(deriveCommitRow(commit)).toEqual({
			commitTime: -172_800,
			parents: [],
			treeOid: t,
		})
	})

	it("a mergetag payload's continuation lines cannot shadow the committer header", () => {
		const t = "a".repeat(40)
		const p = "b".repeat(40)
		// A `mergetag` header embeds a whole tag object as continuation lines, each
		// prefixed with a space — INCLUDING the tag's own blank line, which becomes
		// a lone-space line, and any message line that LOOKS like a committer
		// header. The parser must skip all of them and take the real one.
		const commit = Buffer.from(
			`tree ${t}\nparent ${p}\nmergetag object ${p}\n type commit\n tag v1\n` +
				` tagger t <t> 1600000000 +0000\n \n committer fake <f> 1111111111 +0000\n` +
				`author a <a> 1700000000 +0000\ncommitter c <c> 1700000456 +0000\n\nmsg\n`,
			"latin1",
		)
		expect(deriveCommitRow(commit).commitTime).toBe(1_700_000_456)
	})

	it("rejects a malformed tree oid, a missing committer, and a garbled epoch — loudly, by code", () => {
		const good = "a".repeat(40)
		expect(
			formatErrorCode(() =>
				deriveCommitRow(
					// A committer is present so the malformed TREE oid is what throws.
					Buffer.from(
						`tree ${"z".repeat(40)}\ncommitter c <c> 0 +0000\n\nbad\n`,
						"latin1",
					),
				),
			),
		).toBe("malformed-oid")
		expect(
			formatErrorCode(() =>
				deriveCommitRow(
					Buffer.from(`tree ${good}\nauthor a <a> 0 +0000\n\nno-committer\n`, "latin1"),
				),
			),
		).toBe("missing-committer-header")
		expect(
			formatErrorCode(() =>
				deriveCommitRow(
					Buffer.from(`tree ${good}\ncommitter c <c> soon +0000\n\nbad\n`, "latin1"),
				),
			),
		).toBe("malformed-committer-time")
	})
})

describe("deriveTagRow — content → git_tag row values", () => {
	it("target oid + target type NAME (serialization to code is the store's)", () => {
		const target = "d".repeat(40)
		const tag = Buffer.from(
			`object ${target}\ntype commit\ntag v1\ntagger a <a> 0 +0000\n\nrel\n`,
			"latin1",
		)
		expect(deriveTagRow(tag)).toEqual({ targetOid: target, targetType: "commit" })
	})

	it("a tag-of-tag derives type 'tag'", () => {
		const target = "e".repeat(40)
		const tag = Buffer.from(
			`object ${target}\ntype tag\ntag outer\ntagger a <a> 0 +0000\n\nouter\n`,
			"latin1",
		)
		expect(deriveTagRow(tag).targetType).toBe("tag")
	})

	it("rejects a missing object header, a missing type, and an unknown type — loudly, by code", () => {
		const target = "d".repeat(40)
		expect(
			formatErrorCode(() =>
				deriveTagRow(Buffer.from(`type commit\ntag v1\n\nrel\n`, "latin1")),
			),
		).toBe("missing-tag-object")
		expect(
			formatErrorCode(() =>
				deriveTagRow(Buffer.from(`object ${target}\ntag v1\n\nrel\n`, "latin1")),
			),
		).toBe("missing-tag-type")
		expect(
			formatErrorCode(() =>
				deriveTagRow(
					Buffer.from(`object ${target}\ntype dragon\ntag v1\n\nrel\n`, "latin1"),
				),
			),
		).toBe("unknown-tag-type")
	})
})

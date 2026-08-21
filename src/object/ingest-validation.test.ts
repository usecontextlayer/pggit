import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { deriveCommitRow, deriveTagRow } from "@/object/ingest-validation"
import { expectGitFormatError } from "@/testing/format-error"
import { spawnGit } from "@/testing/spawn-git"

/**
 * Row derivation from commit/tag content. The SHAPES git can produce are driven
 * from a real repo (git is the only authority on its own serialization); the
 * malformed cases stay hand-authored, because canonical git will not emit them.
 */

describe("deriveCommitRow — real git commits (git is the oracle)", () => {
	let dir = ""
	/** The merge commit's raw bytes, and git's own reading of the same commit. */
	let mergeContent: Buffer = Buffer.alloc(0)
	let mergeParents: string[] = []
	let mergeTree = ""
	let mergeTime = 0

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pggit-derive-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		writeFileSync(join(dir, "f.txt"), "one\n")
		await spawnGit(["add", "-A"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })

		// A side branch, tagged with a SIGNED annotated tag: `git merge` embeds a
		// `mergetag` header only for a signed tag (verified on git 2.55 — merging an
		// UNSIGNED annotated tag emits no such header). The key is generated into the
		// temp dir, so this stays hermetic and needs no identity from the machine.
		await spawnGit(["checkout", "-q", "-b", "side"], { cwd: dir })
		writeFileSync(join(dir, "g.txt"), "two\n")
		await spawnGit(["add", "-A"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "c2"], { cwd: dir })
		execFileSync("ssh-keygen", [
			"-t",
			"ed25519",
			"-N",
			"",
			"-q",
			"-f",
			join(dir, "signing-key"),
		])
		// The tag MESSAGE carries a line that looks like a `committer` header. Inside
		// the mergetag it becomes a space-prefixed continuation line — the shadowing
		// hazard, written by git rather than transcribed.
		writeFileSync(join(dir, "tagmsg.txt"), "rel\ncommitter fake <f> 1111111111 +0000\n")
		await spawnGit(
			[
				"-c",
				"gpg.format=ssh",
				"-c",
				`user.signingkey=${join(dir, "signing-key.pub")}`,
				"tag",
				"-s",
				"v1",
				"-F",
				join(dir, "tagmsg.txt"),
			],
			{ cwd: dir },
		)

		await spawnGit(["checkout", "-q", "main"], { cwd: dir })
		writeFileSync(join(dir, "h.txt"), "three\n")
		await spawnGit(["add", "-A"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "c3"], { cwd: dir })
		await spawnGit(["merge", "--no-ff", "-m", "merged", "v1"], { cwd: dir })

		mergeContent = (await spawnGit(["cat-file", "commit", "HEAD"], { cwd: dir }))
			.stdoutBytes
		const revList = await spawnGit(["rev-list", "--parents", "-n", "1", "HEAD"], {
			cwd: dir,
		})
		mergeParents = revList.stdout.trim().split(" ").slice(1)
		mergeTree = (await spawnGit(["rev-parse", "HEAD^{tree}"], { cwd: dir })).stdout.trim()
		mergeTime = Number(
			(await spawnGit(["log", "-1", "--format=%ct", "HEAD"], { cwd: dir })).stdout.trim(),
		)
	}, 120_000)

	afterAll(() => {
		if (dir) rmSync(dir, { force: true, recursive: true })
	})

	it("a merge commit: tree, parents in git's CONTENT order, committer epoch", () => {
		// The fixture really is a merge — parent ORDER is only a claim if there are two.
		expect(mergeParents).toHaveLength(2)
		expect(deriveCommitRow(mergeContent)).toEqual({
			commitTime: mergeTime,
			parents: mergeParents,
			treeOid: mergeTree,
		})
	})

	it("git's own mergetag continuation lines cannot shadow the committer header", () => {
		// Precondition, established from the bytes git wrote: the commit carries a
		// mergetag whose continuation lines include one that reads as a committer.
		const text = mergeContent.toString("latin1")
		expect(text).toContain("\nmergetag object ")
		expect(text).toContain("\n committer fake <f> 1111111111 +0000\n")

		expect(deriveCommitRow(mergeContent).commitTime).toBe(mergeTime)
		expect(mergeTime).not.toBe(1_111_111_111)
	})
})

describe("deriveCommitRow — content → git_commit row values", () => {
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

	it("a mergetag BEFORE the committer header cannot shadow it either", () => {
		const t = "a".repeat(40)
		const p = "b".repeat(40)
		// Hand-authored on purpose: git serializes `mergetag` AFTER author/committer
		// (the real-git case above), so this ORDER — where a first-match parser would
		// take the continuation line — is a shape only a hostile writer emits.
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
			expectGitFormatError(() =>
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
			expectGitFormatError(() =>
				deriveCommitRow(
					Buffer.from(`tree ${good}\nauthor a <a> 0 +0000\n\nno-committer\n`, "latin1"),
				),
			),
		).toBe("missing-committer-header")
		expect(
			expectGitFormatError(() =>
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
			expectGitFormatError(() =>
				deriveTagRow(Buffer.from(`type commit\ntag v1\n\nrel\n`, "latin1")),
			),
		).toBe("missing-tag-object")
		expect(
			expectGitFormatError(() =>
				deriveTagRow(Buffer.from(`object ${target}\ntag v1\n\nrel\n`, "latin1")),
			),
		).toBe("missing-tag-type")
		expect(
			expectGitFormatError(() =>
				deriveTagRow(
					Buffer.from(`object ${target}\ntype dragon\ntag v1\n\nrel\n`, "latin1"),
				),
			),
		).toBe("unknown-tag-type")
	})
})

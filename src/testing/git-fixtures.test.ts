import { describe, expect, it } from "vitest"
import {
	parseLsTree,
	parseVerifyPackObjectOids,
	parseVerifyPackObjects,
} from "@/testing/git-fixtures"

describe("git fixture output parsers", () => {
	it("parses complete ls-tree rows exactly", () => {
		const oid = "a".repeat(40)
		expect(parseLsTree(`100644 blob ${oid}\tdir/a file.txt\n`)).toEqual([
			{ mode: "100644", oid, path: "dir/a file.txt" },
		])
	})

	it("rejects a malformed ls-tree row instead of shortening the oracle", () => {
		const oid = "a".repeat(40)
		expect(() =>
			parseLsTree(`100644 blob ${oid}\tgood.txt\n100644 blob not-an-oid\tbad.txt\n`),
		).toThrow(/unexpected git oid/)
	})

	it("parses every verify-pack object row and its documented summaries", () => {
		const a = "a".repeat(40)
		const b = "b".repeat(40)
		expect(
			parseVerifyPackObjectOids(
				`${b} blob   7 16 12\n${a} tree   29 40 28 1 ${b}\nnon delta: 1 object\nchain length = 1: 1 object\n/tmp/x.pack: ok\n`,
			),
		).toEqual([a, b])
		expect(
			parseVerifyPackObjects(
				`${b} blob   7 16 12\n${a} tree   29 40 28 1 ${b}\nnon delta: 1 object\nchain length = 1: 1 object\n/tmp/x.pack: ok\n`,
			),
		).toEqual([
			{
				kind: "whole",
				offset: 12,
				oid: b,
				packedSize: 16,
				size: 7,
				type: "blob",
			},
			{
				baseOid: b,
				depth: 1,
				kind: "delta",
				offset: 28,
				oid: a,
				packedSize: 40,
				size: 29,
				type: "tree",
			},
		])
	})

	it("rejects one malformed verify-pack row even when another row parsed", () => {
		const oid = "a".repeat(40)
		expect(() =>
			parseVerifyPackObjectOids(
				`${oid} blob   7 16 12\n${"b".repeat(40)} blob unexpected\n/tmp/x.pack: ok\n`,
			),
		).toThrow(/unexpected verify-pack line/)
	})
})

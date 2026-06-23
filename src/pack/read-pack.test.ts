import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { computeOid } from "@/object/object"
import { readPack } from "@/pack/read-pack"
import { writePack } from "@/pack/write-pack"
import { spawnGit } from "@/testing/spawn-git"

describe("readPack", () => {
	it("round-trips objects written by writePack (all base types)", async () => {
		const objects = [
			{ content: Buffer.from("hello\n"), type: "blob" as const },
			{ content: Buffer.from([0, 1, 2, 254, 255]), type: "blob" as const },
			{ content: Buffer.from("treebytes"), type: "tree" as const },
			{ content: Buffer.from("commitbytes\n"), type: "commit" as const },
			{ content: Buffer.from("tagbytes\n"), type: "tag" as const },
		]
		const parsed = await readPack(writePack(objects))
		expect(parsed.map((p) => ({ content: p.content, type: p.type }))).toEqual(objects)
		for (const p of parsed) {
			expect(p.oid).toBe(computeOid(p.type, p.content))
		}
	})

	it("reads a real git-produced (undeltified) pack matching the repo's objects", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-rp-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			writeFileSync(join(dir, "a.txt"), "hello\n")
			writeFileSync(join(dir, "b.txt"), "world\n".repeat(50))
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "seed"], { cwd: dir })
			await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: dir })
			// Force a single pack with NO deltas (window/depth 0).
			await spawnGit(["repack", "-adq", "--window=0", "--depth=0"], { cwd: dir })

			const packDir = join(dir, ".git/objects/pack")
			const packName = readdirSync(packDir).find((f) => f.endsWith(".pack"))
			if (!packName) throw new Error("no pack produced")
			const parsed = await readPack(readFileSync(join(packDir, packName)))

			const list = await spawnGit(
				["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
				{ cwd: dir },
			)
			const expected = list.stdout.trim().split("\n").sort()
			expect(parsed.map((p) => p.oid).sort()).toEqual(expected)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("reads a real git pack containing OFS deltas, recovering all objects", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pggit-rp-delta-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dir })
			const big = "lorem ipsum dolor sit amet\n".repeat(400)
			writeFileSync(join(dir, "big.txt"), big)
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "v1"], { cwd: dir })
			// A near-identical large blob ⇒ git will deltify one against the other.
			writeFileSync(join(dir, "big.txt"), `${big}one more line\n`)
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "v2"], { cwd: dir })
			await spawnGit(["repack", "-adq"], { cwd: dir }) // default ⇒ deltas ON

			const packDir = join(dir, ".git/objects/pack")
			const packName = readdirSync(packDir).find((f) => f.endsWith(".pack"))
			if (!packName) throw new Error("no pack produced")
			const idxName = packName.replace(/\.pack$/, ".idx")

			// Guard against a vacuous test: confirm the pack actually has ≥1 delta.
			// verify-pack delta lines carry a trailing base-OID; base objects don't.
			const verify = await spawnGit(["verify-pack", "-v", join(packDir, idxName)], {
				cwd: dir,
			})
			const deltaCount = verify.stdout
				.split("\n")
				.filter((l) => /^[0-9a-f]{40} \S.* [0-9a-f]{40}$/.test(l)).length
			expect(deltaCount).toBeGreaterThan(0)

			const parsed = await readPack(readFileSync(join(packDir, packName)))
			const list = await spawnGit(
				["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
				{ cwd: dir },
			)
			const expected = list.stdout.trim().split("\n").sort()
			expect(parsed.map((p) => p.oid).sort()).toEqual(expected)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

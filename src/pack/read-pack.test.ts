import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { computeOid } from "@/object/object"
import { readPack } from "@/pack/read-pack"
import { writePack } from "@/pack/write-pack"
import { allObjectOids, parseVerifyPackObjects } from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

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
		await withTempDir("pggit-rp-", async (dir) => {
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

			const expected = await allObjectOids(dir)
			expect(parsed.map((p) => p.oid).sort()).toEqual(expected)
		})
	})

	// Both delta wire forms, each read from a REAL git pack. The form is PINNED by
	// config rather than inherited from git's default: `git repack` always passes
	// `--delta-base-offset` to pack-objects according to `repack.useDeltaBaseOffset`
	// (which is why `pack.useOfsDelta` is inert on this path — verified on git
	// 2.55), so a future default flip cannot silently drop a form from the suite.
	// And the form is MEASURED, not assumed: a REF_DELTA entry carries its base
	// object id as 20 raw bytes inside the pack body, an OFS_DELTA carries a
	// back-offset varint instead — `verify-pack -v` renders both identically, so
	// the presence of those bytes is the only observable that tells them apart.
	for (const form of [
		{ embedsBaseOid: false, name: "OFS", useDeltaBaseOffset: true },
		{ embedsBaseOid: true, name: "REF", useDeltaBaseOffset: false },
	]) {
		it(`reads a real git pack containing ${form.name} deltas, recovering all objects`, async () => {
			await withTempDir("pggit-rp-delta-", async (dir) => {
				await spawnGit(["init", "-q"], { cwd: dir })
				const big = "lorem ipsum dolor sit amet\n".repeat(400)
				writeFileSync(join(dir, "big.txt"), big)
				await spawnGit(["add", "."], { cwd: dir })
				await spawnGit(["commit", "-q", "-m", "v1"], { cwd: dir })
				// A near-identical large blob ⇒ git will deltify one against the other.
				writeFileSync(join(dir, "big.txt"), `${big}one more line\n`)
				await spawnGit(["add", "."], { cwd: dir })
				await spawnGit(["commit", "-q", "-m", "v2"], { cwd: dir })
				await spawnGit(
					[
						"-c",
						`repack.useDeltaBaseOffset=${form.useDeltaBaseOffset}`,
						"repack",
						"-adq",
					],
					{ cwd: dir },
				)

				const packDir = join(dir, ".git/objects/pack")
				const packName = readdirSync(packDir).find((f) => f.endsWith(".pack"))
				if (!packName) throw new Error("no pack produced")
				const packBytes = readFileSync(join(packDir, packName))
				const idxName = packName.replace(/\.pack$/, ".idx")

				// The pack really is deltified: verify-pack delta lines carry a trailing
				// base OID; base objects don't.
				const verify = await spawnGit(["verify-pack", "-v", join(packDir, idxName)], {
					cwd: dir,
				})
				const baseOids = parseVerifyPackObjects(verify.stdout).flatMap((object) =>
					object.kind === "delta" ? [object.baseOid] : [],
				)
				expect(baseOids.length).toBeGreaterThan(0)
				// …and every delta in it is THIS test's wire form.
				for (const base of baseOids) {
					expect(packBytes.includes(Buffer.from(base, "hex"))).toBe(form.embedsBaseOid)
				}

				const parsed = await readPack(packBytes)
				const expected = await allObjectOids(dir)
				expect(parsed.map((p) => p.oid).sort()).toEqual(expected)
			})
		})
	}
})

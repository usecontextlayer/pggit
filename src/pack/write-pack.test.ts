import { writeFileSync } from "node:fs"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { computeOid } from "@/object/object"
import { type PackInputObject, writePack } from "@/pack/write-pack"
import {
	allObjectOids,
	loadAllObjects,
	parseVerifyPackObjectOids,
} from "@/testing/git-fixtures"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

/** Index our pack with real git; return the OIDs git resolved from it (sorted). */
async function oidsGitResolves(pack: Buffer): Promise<string[]> {
	return withTempDir("pggit-wp-", async (dir) => {
		const packPath = join(dir, "test.pack")
		writeFileSync(packPath, pack)
		await spawnGit(["init", "-q"], { cwd: dir })
		// index-pack fully validates: header, every object inflates, SHA-1 trailer,
		// and self-containment (all delta bases present). Throws on any failure.
		await spawnGit(["index-pack", "-v", packPath], { cwd: dir })
		const verify = await spawnGit(["verify-pack", "-v", join(dir, "test.idx")], {
			cwd: dir,
		})
		return parseVerifyPackObjectOids(verify.stdout)
	})
}

describe("writePack", () => {
	it("writes an undeltified pack git accepts, with exactly the seeded objects", async () => {
		const objects = [
			{ content: Buffer.from("hello\n"), type: "blob" as const },
			{ content: Buffer.from("world\n"), type: "blob" as const },
		]
		const pack = writePack(objects)

		const expected = objects.map((o) => computeOid(o.type, o.content)).sort()
		expect(await oidsGitResolves(pack)).toEqual(expected)
	})

	it("writes a pack of all object types that git resolves identically", async () => {
		await withTempDir("pggit-wp-src-", async (src) => {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "hello\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "seed"], { cwd: src })
			await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: src })

			const objects = await loadAllObjects(src)
			const expected = await allObjectOids(src)

			expect(await oidsGitResolves(writePack(objects))).toEqual(expected.sort())
		})
	})

	it("round-trips arbitrary blob sets through real git (generative)", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.uint8Array({ maxLength: 500, minLength: 0 }), {
					maxLength: 8,
					minLength: 1,
				}),
				async (blobs) => {
					// Dedup by OID — the writer is handed distinct objects (graph-walk's job).
					const byOid = new Map<string, PackInputObject>()
					for (const b of blobs) {
						const obj = { content: Buffer.from(b), type: "blob" as const }
						byOid.set(computeOid(obj.type, obj.content), obj)
					}
					const pack = writePack([...byOid.values()])
					expect(await oidsGitResolves(pack)).toEqual([...byOid.keys()].sort())
				},
			),
			// Pinned seed (424_242) for a deterministic gate, matching the sibling specs.
			{ numRuns: 12, seed: 424_242 },
		)
	})
})

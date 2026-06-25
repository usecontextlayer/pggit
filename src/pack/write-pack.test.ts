import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { computeOid, type GitObjectType } from "@/object/object"
import { type PackInputObject, writePack } from "@/pack/write-pack"
import { spawnGit } from "@/testing/spawn-git"

/** Index our pack with real git; return the OIDs git resolved from it (sorted). */
async function oidsGitResolves(pack: Buffer): Promise<string[]> {
	const dir = mkdtempSync(join(tmpdir(), "pggit-wp-"))
	try {
		const packPath = join(dir, "test.pack")
		writeFileSync(packPath, pack)
		await spawnGit(["init", "-q"], { cwd: dir })
		// index-pack fully validates: header, every object inflates, SHA-1 trailer,
		// and self-containment (all delta bases present). Throws on any failure.
		await spawnGit(["index-pack", "-v", packPath], { cwd: dir })
		const verify = await spawnGit(["verify-pack", "-v", join(dir, "test.idx")], {
			cwd: dir,
		})
		const oids: string[] = []
		for (const line of verify.stdout.split("\n")) {
			const oid = /^([0-9a-f]{40}) (commit|tree|blob|tag)/.exec(line)?.[1]
			if (oid) oids.push(oid)
		}
		return oids.sort()
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
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
		const src = mkdtempSync(join(tmpdir(), "pggit-wp-src-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "hello\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "seed"], { cwd: src })
			await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: src })

			const list = await spawnGit(
				["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
				{ cwd: src },
			)
			const objects: PackInputObject[] = []
			const expected: string[] = []
			for (const line of list.stdout.trim().split("\n")) {
				const [oid, type] = line.split(" ")
				if (!oid || !type) throw new Error(`bad batch line: ${line}`)
				const raw = await spawnGit(["cat-file", type, oid], { cwd: src })
				objects.push({ content: raw.stdoutBytes, type: type as GitObjectType })
				expected.push(oid)
			}

			expect(await oidsGitResolves(writePack(objects))).toEqual(expected.sort())
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
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

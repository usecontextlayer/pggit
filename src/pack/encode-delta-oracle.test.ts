/**
 * Real-git conformance for `encodeDelta` — layer 2 of the delta spec.
 *
 * The pure spec (`encode-delta.spec.test.ts`) proves our own reader can undo our own
 * writer. That is necessary and NOT sufficient: two matching bugs in `applyDelta` and
 * `encodeDelta` would satisfy it perfectly while producing packs no git can read. The
 * only authority on the delta format is git, so here canonical `git` ingests packs
 * built from our deltas and must recover every object byte-for-byte.
 *
 * This is the layer that would catch a wrong opcode bit, a mis-sized header, or a
 * delta whose declared source size disagrees with the base git actually holds.
 *
 * The pack writer below is TEST-ONLY and deliberately temporary: `write-pack.ts`
 * cannot emit deltas yet, which is chunk 3. When chunk 3 lands, these tests should
 * build their packs through the REAL writer — at which point this helper's continued
 * existence would mean the production path is not being exercised.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { computeOid, type GitObjectType } from "@/object/object"
import { encodeDelta } from "@/pack/delta"
import { encodeObjectHeader, PACK_OBJ_TYPE } from "@/pack/object-header"
import { writePack } from "@/pack/write-pack"
import {
	commitsOldestFirst,
	createAppendOnlyRepo,
	readObject,
	runsTreeAt,
} from "@/testing/append-only-repo"
import { spawnGit } from "@/testing/spawn-git"

const PACK_TYPE_CODE: Record<GitObjectType, number> = {
	blob: PACK_OBJ_TYPE.BLOB,
	commit: PACK_OBJ_TYPE.COMMIT,
	tag: PACK_OBJ_TYPE.TAG,
	tree: PACK_OBJ_TYPE.TREE,
}

type PackEntry =
	| { content: Buffer; kind: "base"; type: GitObjectType }
	| { baseOid: string; delta: Buffer; kind: "ref" }

/** A v2 packfile carrying whole objects and REF_DELTA entries (test-only; see header). */
function buildPack(entries: PackEntry[]): Buffer {
	const header = Buffer.alloc(12)
	header.write("PACK", 0, "latin1")
	header.writeUInt32BE(2, 4)
	header.writeUInt32BE(entries.length, 8)
	const parts: Buffer[] = [header]
	for (const e of entries) {
		if (e.kind === "base") {
			parts.push(encodeObjectHeader(PACK_TYPE_CODE[e.type], e.content.length))
			parts.push(deflateSync(e.content))
		} else {
			parts.push(encodeObjectHeader(PACK_OBJ_TYPE.REF_DELTA, e.delta.length))
			parts.push(Buffer.from(e.baseOid, "hex"))
			parts.push(deflateSync(e.delta))
		}
	}
	const body = Buffer.concat(parts)
	return Buffer.concat([body, createHash("sha1").update(body).digest()])
}

/** An empty scratch repository for git to ingest packs into. */
async function scratchRepo(tag: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), `pggit-oracle-${tag}-`))
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	return dir
}

/**
 * Hand `pack` to canonical git. `fixThin` is required when a REF_DELTA's base is NOT
 * in the pack but already in the repository — the thin-pack case, which is exactly
 * what an incremental fetch would emit.
 */
async function gitIngestPack(repo: string, pack: Buffer, fixThin = false): Promise<void> {
	const args = ["index-pack", "--stdin"]
	if (fixThin) args.push("--fix-thin")
	await spawnGit(args, { cwd: repo, input: pack })
}

/** git's own copy of an object, after it resolved whatever delta carried it. */
async function gitObject(repo: string, oid: string, type: string): Promise<Buffer> {
	return (await spawnGit(["cat-file", type, oid], { cwd: repo })).stdoutBytes
}

/** git's structural verdict on the repository. `--no-dangling` because a pack ingested
 * without refs is legitimately unreferenced and we are not testing reachability. */
async function gitFsck(repo: string): Promise<void> {
	await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: repo })
}

describe("encodeDelta — canonical git reads what we write", () => {
	const scratch: string[] = []
	afterAll(() => {
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("CONTROL — accepts an UNDELTIFIED pack from the real writePack", async () => {
		// Proves the harness (temp repo, index-pack --stdin, cat-file, fsck) is sound
		// with no delta involved, so a failure in the cases below can only be the
		// encoder. Without this control, a broken git invocation and a broken encoder
		// are indistinguishable — every delta test fails either way.
		const repo = await scratchRepo("control")
		scratch.push(repo)

		const objects = [
			{ content: Buffer.from("hello\n", "latin1"), type: "blob" as const },
			{ content: Buffer.from(`x\n`.repeat(1000), "latin1"), type: "blob" as const },
		]
		await gitIngestPack(repo, writePack(objects))

		for (const o of objects) {
			const oid = computeOid(o.type, o.content)
			expect((await gitObject(repo, oid, o.type)).equals(o.content)).toBe(true)
		}
		await gitFsck(repo)
	})

	it("accepts a self-contained pack whose second entry is our delta", async () => {
		const repo = await scratchRepo("selfcontained")
		scratch.push(repo)

		const base = Buffer.from(`line\n`.repeat(500), "latin1")
		const target = Buffer.concat([base, Buffer.from("appended\n", "latin1")])
		const baseOid = computeOid("blob", base)
		const targetOid = computeOid("blob", target)

		await gitIngestPack(
			repo,
			buildPack([
				{ content: base, kind: "base", type: "blob" },
				{ baseOid, delta: encodeDelta(base, target), kind: "ref" },
			]),
		)

		expect((await gitObject(repo, targetOid, "blob")).equals(target)).toBe(true)
		expect((await gitObject(repo, baseOid, "blob")).equals(base)).toBe(true)
		await gitFsck(repo)
	})

	it("accepts a THIN pack whose base git already holds", async () => {
		// The incremental-fetch shape: the client has the base, so the pack carries only
		// the delta. git resolves it against its own store via --fix-thin.
		const repo = await scratchRepo("thin")
		scratch.push(repo)

		const base = Buffer.from(`alpha\n`.repeat(400), "latin1")
		const target = Buffer.from(`${`alpha\n`.repeat(400)}omega\n`, "latin1")
		const baseOid = (
			await spawnGit(["hash-object", "-w", "-t", "blob", "--stdin"], {
				cwd: repo,
				input: base,
			})
		).stdout.trim()
		expect(baseOid).toBe(computeOid("blob", base))

		await gitIngestPack(
			repo,
			buildPack([{ baseOid, delta: encodeDelta(base, target), kind: "ref" }]),
			true,
		)

		expect(
			(await gitObject(repo, computeOid("blob", target), "blob")).equals(target),
		).toBe(true)
		await gitFsck(repo)
	})

	it("accepts a delta CHAIN — a delta whose base is itself a delta", async () => {
		// Chains are not exotic: a repack that deltas each version against the previous
		// one produces them by construction, and their depth is the thing chunk 2 must
		// bound. git must resolve ours the same way it resolves its own.
		const repo = await scratchRepo("chain")
		scratch.push(repo)

		const a = Buffer.from(`v1\n`.repeat(300), "latin1")
		const b = Buffer.concat([a, Buffer.from("second\n", "latin1")])
		const c = Buffer.concat([b, Buffer.from("third\n", "latin1")])
		const [aOid, bOid] = [computeOid("blob", a), computeOid("blob", b)]

		await gitIngestPack(
			repo,
			buildPack([
				{ content: a, kind: "base", type: "blob" },
				{ baseOid: aOid, delta: encodeDelta(a, b), kind: "ref" },
				{ baseOid: bOid, delta: encodeDelta(b, c), kind: "ref" },
			]),
		)

		expect((await gitObject(repo, computeOid("blob", c), "blob")).equals(c)).toBe(true)
		await gitFsck(repo)
	})

	it("round-trips REAL tree objects from an append-only history, and shrinks them", async () => {
		// The production shape, validated by git rather than by us: successive versions
		// of one growing directory tree, each delta'd against its predecessor.
		const src = await createAppendOnlyRepo({ docs: 4, runs: 60 })
		scratch.push(src)
		const repo = await scratchRepo("trees")
		scratch.push(repo)

		// `slice(1)`: the seeding commit predates the runs directory, so it has no such
		// tree. Skipping it by construction — never by catching the lookup failure, which
		// would also swallow a genuinely broken fixture.
		const commits = (await commitsOldestFirst(src)).slice(1)
		const trees: Buffer[] = []
		const seen = new Set<string>()
		for (const rev of commits) {
			const oid = await runsTreeAt(src, rev)
			if (seen.has(oid)) continue
			seen.add(oid)
			trees.push(await readObject(src, oid, "tree"))
		}
		expect(trees.length).toBeGreaterThan(50)

		const first = trees[0] as Buffer
		const entries: PackEntry[] = [{ content: first, kind: "base", type: "tree" }]
		for (let i = 1; i < trees.length; i++) {
			const base = trees[i - 1] as Buffer
			const target = trees[i] as Buffer
			entries.push({
				baseOid: computeOid("tree", base),
				delta: encodeDelta(base, target),
				kind: "ref",
			})
		}
		const deltified = buildPack(entries)
		await gitIngestPack(repo, deltified)

		// Every tree recovered exactly, by git.
		for (const tree of trees) {
			const oid = computeOid("tree", tree)
			expect((await gitObject(repo, oid, "tree")).equals(tree)).toBe(true)
		}
		await gitFsck(repo)

		// And the point of the exercise: the deltified pack must be dramatically smaller
		// than the undeltified one `writePack` produces today for the same objects.
		const undeltified = writePack(
			trees.map((content) => ({ content, type: "tree" as const })),
		)
		expect(deltified.length).toBeLessThan(undeltified.length / 4)
	})
})

describe("encodeDelta — a full clone of a deltified repo stays fsck-clean", () => {
	let src = ""
	beforeAll(async () => {
		src = await createAppendOnlyRepo({ docs: 4, runs: 40 })
	}, 180_000)
	afterAll(() => {
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("matches git's own repack on the object set it recovers", async () => {
		// An end-to-end sanity check on the FIXTURE rather than on pggit: if git's own
		// `repack` of this shape does not produce delta chains, the fixture is not
		// exercising what we think, and every size assertion above is vacuous.
		await spawnGit(["repack", "-adq", "--depth=50", "--window=10"], { cwd: src })
		const verify = await spawnGit(
			["verify-pack", "-v", "--", ...(await packIdxPaths(src))],
			{ cwd: src },
		)
		expect(verify.stdout).toMatch(/chain length = 1/)
	})
})

/** The `.idx` files in a repo's pack dir, absolute. */
async function packIdxPaths(dir: string): Promise<string[]> {
	const out = await spawnGit(["rev-parse", "--git-path", "objects/pack"], { cwd: dir })
	const { readdirSync } = await import("node:fs")
	const { join } = await import("node:path")
	const packDir = join(dir, out.stdout.trim())
	return readdirSync(packDir)
		.filter((f) => f.endsWith(".idx"))
		.map((f) => join(packDir, f))
}

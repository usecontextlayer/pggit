import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { graphWalk } from "@/graph-walk"
import type { GitObjectType } from "@/object"
import { spawnGit } from "@/testing/spawn-git"

type Obj = { type: GitObjectType; content: Buffer }

/** Load every object in a repo into an in-memory map — a reader source for the walk. */
async function loadAllObjects(dir: string): Promise<Map<string, Obj>> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const map = new Map<string, Obj>()
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (!oid || !type) continue
		const raw = await spawnGit(["cat-file", type, oid], { cwd: dir })
		map.set(oid, { content: raw.stdoutBytes, type: type as GitObjectType })
	}
	return map
}

async function revListObjects(dir: string, ref: string): Promise<string[]> {
	const out = await spawnGit(["rev-list", "--objects", ref], { cwd: dir })
	return out.stdout
		.trim()
		.split("\n")
		.map((l) => l.split(" ")[0])
		.filter((o): o is string => Boolean(o))
		.sort()
}

describe("graphWalk", () => {
	let dir: string
	let objects: Map<string, Obj>

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pggit-gw-"))
		await spawnGit(["init", "-q"], { cwd: dir })
		mkdirSync(join(dir, "sub"))
		writeFileSync(join(dir, "a.txt"), "alpha\n")
		writeFileSync(join(dir, "sub", "b.txt"), "beta\n")
		await spawnGit(["add", "."], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })
		writeFileSync(join(dir, "a.txt"), "alpha updated\n")
		writeFileSync(join(dir, "sub", "c.txt"), "gamma\n")
		await spawnGit(["add", "."], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "c2"], { cwd: dir })
		await spawnGit(["tag", "-a", "v1", "-m", "release"], { cwd: dir })
		objects = await loadAllObjects(dir)
	}, 60_000)

	afterAll(() => {
		rmSync(dir, { force: true, recursive: true })
	})

	const reader = async (oid: string): Promise<Obj> => {
		const o = objects.get(oid)
		if (!o) throw new Error(`missing object ${oid}`)
		return o
	}

	it("reaches the same object set as `git rev-list --objects HEAD`", async () => {
		const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
		const walked = [...(await graphWalk([tip], reader))].sort()
		expect(walked).toEqual(await revListObjects(dir, "HEAD"))
	})

	it("reaches through an annotated tag (tag → commit → trees → blobs)", async () => {
		const tagOid = (await spawnGit(["rev-parse", "v1"], { cwd: dir })).stdout.trim()
		const walked = [...(await graphWalk([tagOid], reader))].sort()
		expect(walked).toEqual(await revListObjects(dir, "v1"))
	})
})

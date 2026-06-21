import type { GitObjectType } from "@/object"
import type { ObjectStore } from "@/object-store"
import type { PackInputObject } from "@/pack/write-pack"
import type { RefStore } from "@/refs-store"
import { spawnGit } from "@/testing/spawn-git"

/** Every object in a real repo, as pack inputs (content read binary-safe). */
export async function loadAllObjects(dir: string): Promise<PackInputObject[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const objs: PackInputObject[] = []
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (!oid || !type) continue
		const raw = await spawnGit(["cat-file", type, oid], { cwd: dir })
		objs.push({ content: raw.stdoutBytes, type: type as GitObjectType })
	}
	return objs
}

/** Parse `git ls-tree[-r]` output: `<mode> <type> <oid>\t<name-or-path>`. */
export function parseLsTree(
	stdout: string,
): { mode: string; oid: string; path: string }[] {
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const tab = line.indexOf("\t")
			if (tab < 0) throw new Error(`unexpected ls-tree line: ${line}`)
			const path = line.slice(tab + 1)
			const [mode, , oid] = line.slice(0, tab).split(" ")
			if (mode === undefined || oid === undefined) {
				throw new Error(`unexpected ls-tree meta: ${line}`)
			}
			return { mode, oid, path }
		})
}

/** Sorted list of every object OID in a real repo. */
export async function allObjectOids(dir: string): Promise<string[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
		{ cwd: dir },
	)
	return list.stdout.trim().split("\n").sort()
}

/**
 * A repo's local branches + tags as sorted {name, oid} pairs — matching what the
 * RefStore stores (an annotated tag's ref points at the tag object). For asserting
 * a push landed exactly the client's refs.
 */
export async function refsOf(dir: string): Promise<{ name: string; oid: string }[]> {
	const out = await spawnGit(
		["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/", "refs/tags/"],
		{ cwd: dir },
	)
	return out.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [oid, name] = line.split(" ")
			if (!oid || !name) throw new Error(`bad for-each-ref line: ${line}`)
			return { name, oid }
		})
		.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Mirror a real repo's full object set + refs (+ HEAD symref) into the Postgres
 * store under `repoId`. The differential harness seeds with this, then drives
 * real `git` against the served result.
 */
export async function seedRepoIntoStore(
	repoId: string,
	srcDir: string,
	stores: { objects: ObjectStore; refs: RefStore },
): Promise<void> {
	await stores.objects.putPack(repoId, await loadAllObjects(srcDir))
	const showRef = await spawnGit(["show-ref"], { cwd: srcDir })
	for (const line of showRef.stdout.trim().split("\n")) {
		const [oid, name] = line.split(" ")
		if (oid && name) await stores.refs.setRef(repoId, name, oid)
	}
	const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: srcDir })).stdout.trim()
	await stores.refs.setSymref(repoId, "HEAD", head)
}

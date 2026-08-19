import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { GitObjectType } from "@/object/object"
import type { PackInputObject } from "@/pack/write-pack"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { spawnGit } from "@/testing/spawn-git"

const OBJECT_TYPES = new Set<GitObjectType>(["blob", "commit", "tag", "tree"])

function objectType(value: string, line: string): GitObjectType {
	if (!OBJECT_TYPES.has(value as GitObjectType)) {
		throw new Error(`unexpected git object-list line: ${line}`)
	}
	return value as GitObjectType
}

/** Validate one SHA-1 oid emitted by canonical git before it enters an oracle set. */
export function requireGitOid(value: string, context: string): string {
	if (!/^[0-9a-f]{40}$/.test(value)) {
		throw new Error(`unexpected git oid ${JSON.stringify(value)} in ${context}`)
	}
	return value
}

/** Every object in a real repo, as pack inputs (content read binary-safe). */
export async function loadAllObjects(dir: string): Promise<PackInputObject[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const objs: PackInputObject[] = []
	for (const line of list.stdout.trim().split("\n").filter(Boolean)) {
		const [oid, type] = line.split(" ")
		if (oid === undefined || type === undefined || line.split(" ").length !== 2) {
			throw new Error(`unexpected git object-list line: ${line}`)
		}
		const parsedOid = requireGitOid(oid, `object-list line ${JSON.stringify(line)}`)
		const parsedType = objectType(type, line)
		const raw = await spawnGit(["cat-file", parsedType, parsedOid], { cwd: dir })
		objs.push({ content: raw.stdoutBytes, type: parsedType })
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
			const meta = line.slice(0, tab).split(" ")
			if (meta.length !== 3 || path.length === 0) {
				throw new Error(`unexpected ls-tree meta: ${line}`)
			}
			const [mode, type, oid] = meta as [string, string, string]
			if (!/^[0-7]{6}$/.test(mode)) {
				throw new Error(`unexpected ls-tree mode: ${line}`)
			}
			objectType(type, line)
			return {
				mode,
				oid: requireGitOid(oid, `ls-tree line ${JSON.stringify(line)}`),
				path,
			}
		})
}

/** Sorted list of every object OID in a real repo. */
export async function allObjectOids(dir: string): Promise<string[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
		{ cwd: dir },
	)
	return list.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => requireGitOid(line, `object-list line ${JSON.stringify(line)}`))
		.sort()
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
			const split = line.indexOf(" ")
			if (split < 0 || split === line.length - 1) {
				throw new Error(`unexpected for-each-ref line: ${line}`)
			}
			return {
				name: line.slice(split + 1),
				oid: requireGitOid(
					line.slice(0, split),
					`for-each-ref line ${JSON.stringify(line)}`,
				),
			}
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
	for (const line of showRef.stdout.trim().split("\n").filter(Boolean)) {
		const split = line.indexOf(" ")
		if (split < 0 || split === line.length - 1) {
			throw new Error(`unexpected show-ref line: ${line}`)
		}
		await stores.refs.setRef(
			repoId,
			line.slice(split + 1),
			requireGitOid(line.slice(0, split), `show-ref line ${JSON.stringify(line)}`),
		)
	}
	const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: srcDir })).stdout.trim()
	await stores.refs.setSymref(repoId, "HEAD", head)
}

export const PACK_DIR = ".git/objects/pack"

/** The `.pack` filenames in a real repo's pack dir. */
export function packFiles(dir: string): string[] {
	return readdirSync(join(dir, PACK_DIR)).filter((f) => f.endsWith(".pack"))
}

export type VerifyPackObject = { oid: string; delta: boolean }

/** Every object row inside one `git verify-pack -v` report, including whether it
 * is deltified. Summary rows are validated and omitted from the result. */
export function parseVerifyPackObjects(stdout: string): VerifyPackObject[] {
	const objects: VerifyPackObject[] = []
	for (const line of stdout.trim().split("\n").filter(Boolean)) {
		const object = line.match(
			/^([0-9a-f]{40})\s+(commit|tree|blob|tag)\s+\d+\s+\d+\s+\d+(?:\s+(\d+)\s+([0-9a-f]{40}))?$/,
		)
		if (object?.[1]) {
			objects.push({ delta: object[3] !== undefined, oid: object[1] })
			continue
		}
		if (
			/^non delta: \d+ objects?$/.test(line) ||
			/^chain length = \d+: \d+ objects?$/.test(line) ||
			/\.pack: ok$/.test(line)
		) {
			continue
		}
		throw new Error(`unexpected verify-pack line: ${line}`)
	}
	// git never writes an empty pack, so zero parsed rows means verify-pack's
	// output format moved and the scrape above went blind — fail, don't return [].
	if (objects.length === 0) {
		throw new Error("parsed zero objects from git verify-pack -v")
	}
	return objects
}

/** The sorted OIDs inside one pack, per `git verify-pack -v`. */
export function parseVerifyPackObjectOids(stdout: string): string[] {
	return parseVerifyPackObjects(stdout)
		.map((object) => object.oid)
		.sort()
}

/** The OIDs inside one pack, per `git verify-pack -v` (the bytes git received). */
export async function packObjectOids(dir: string, packFile: string): Promise<string[]> {
	const idx = join(dir, PACK_DIR, packFile.replace(/\.pack$/, ".idx"))
	const out = await spawnGit(["verify-pack", "-v", idx], { cwd: dir })
	return parseVerifyPackObjectOids(out.stdout)
}

/** Every object in a real repo as `{oid, type}` (one `cat-file --batch-all-objects`
 * scan). */
export async function objectsByType(
	dir: string,
): Promise<{ oid: string; type: GitObjectType }[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const out: { oid: string; type: GitObjectType }[] = []
	for (const line of list.stdout.trim().split("\n").filter(Boolean)) {
		const [oid, type] = line.split(" ")
		if (oid === undefined || type === undefined || line.split(" ").length !== 2) {
			throw new Error(`unexpected git object-list line: ${line}`)
		}
		out.push({
			oid: requireGitOid(oid, `object-list line ${JSON.stringify(line)}`),
			type: objectType(type, line),
		})
	}
	return out
}

/** A deterministic 400-line repo-content fixture; `changedLine` replaces line 200. */
export function bigFile(changedLine: string): string {
	const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`)
	lines[200] = changedLine
	return `${lines.join("\n")}\n`
}

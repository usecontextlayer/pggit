import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { GitObjectType } from "@/object/object"
import { isOid, type Oid } from "@/oid"
import type { PackInputObject } from "@/pack/write-pack"
import type { ObjectStore } from "@/store/object-store"
import type { RefStore } from "@/store/refs-store"
import { spawnGit } from "@/testing/spawn-git"

const gitObjectTypeSchema = z.enum(["blob", "commit", "tag", "tree"])

export function requireGitObjectType(value: string, context: string): GitObjectType {
	const parsed = gitObjectTypeSchema.safeParse(value)
	if (!parsed.success) {
		throw new Error(`unexpected git object type ${JSON.stringify(value)} in ${context}`)
	}
	return parsed.data
}

/** Validate one SHA-1 oid emitted by canonical git before it enters an oracle set. */
export function requireGitOid(value: string, context: string): Oid {
	if (!isOid(value)) {
		throw new Error(`unexpected git oid ${JSON.stringify(value)} in ${context}`)
	}
	return value
}

/** Directional list difference, preserving each input's order and duplicates. */
export function listDifferences<T>(
	left: readonly T[],
	right: readonly T[],
): { onlyLeft: T[]; onlyRight: T[] } {
	const leftValues = new Set(left)
	const rightValues = new Set(right)
	return {
		onlyLeft: left.filter((value) => !rightValues.has(value)),
		onlyRight: right.filter((value) => !leftValues.has(value)),
	}
}

/** Index a fixture list, failing with the caller's semantic context. */
export function requiredAt<T>(values: readonly T[], index: number, context: string): T {
	const value = values[index]
	if (value === undefined) throw new Error(`${context}: missing index ${index}`)
	return value
}

/** Wrap an arbitrary index into a non-empty fixture list. */
export function cyclicAt<T>(values: readonly T[], index: number): T {
	if (values.length === 0) throw new Error("cyclicAt: empty list")
	return requiredAt(values, index % values.length, "cyclicAt")
}

/** Parse every `<oid>[ <path>]` row emitted by `git rev-list --objects`. */
export function parseRevListObjectOids(stdout: string): string[] {
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const space = line.indexOf(" ")
			const oid = space < 0 ? line : line.slice(0, space)
			return requireGitOid(oid, `rev-list line ${JSON.stringify(line)}`)
		})
}

/** Canonical git's reachable object closure, including annotated-tag objects that `rev-list --objects --all` reports only through their peeled targets. */
export async function gitReachableOids(dir: string): Promise<string[]> {
	const revList = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
	const oids = new Set(parseRevListObjectOids(revList.stdout))
	// Annotated-tag OBJECTS: `rev-list --objects --all` lists a tag ref's peeled
	// target, not the tag object, so add every ref oid that is itself a tag object.
	const refLines = await spawnGit(
		["for-each-ref", "--format=%(objecttype) %(objectname)"],
		{ cwd: dir },
	)
	for (const line of refLines.stdout.trim().split("\n").filter(Boolean)) {
		const fields = line.split(" ")
		if (fields.length !== 2) {
			throw new Error(`unexpected for-each-ref line: ${line}`)
		}
		const [type, oid] = fields as [string, string]
		const parsedOid = requireGitOid(oid, `for-each-ref line ${JSON.stringify(line)}`)
		switch (type) {
			case "tag":
				oids.add(parsedOid)
				break
			case "blob":
			case "commit":
			case "tree":
				break
			default:
				throw new Error(`unexpected for-each-ref object type: ${line}`)
		}
	}
	return [...oids].sort()
}

/** Same-path target-to-base pairs from one parent-before-child `git log --raw` stream. */
export async function gitLogRawBasePairs(dir: string): Promise<Map<string, string>> {
	const log = await spawnGit(
		[
			"log",
			"--reverse",
			"--topo-order",
			"--raw",
			"-r",
			"-t",
			"--no-renames",
			"--abbrev=40",
			"--format=@%H %T %P",
			"--all",
		],
		{ cwd: dir },
	)
	const pairs = new Map<string, string>()
	const commitTree = new Map<string, string>()
	let sawCommit = false
	for (const line of log.stdout.split("\n")) {
		if (line.length === 0) continue
		if (line.startsWith("@")) {
			const fields = line.slice(1).trimEnd().split(" ").filter(Boolean)
			if (fields.length < 2) throw new Error(`unexpected git log header: ${line}`)
			const [rawCommit, rawTree, ...rawParents] = fields as [string, string, ...string[]]
			const commit = requireGitOid(rawCommit, `git log header ${JSON.stringify(line)}`)
			const tree = requireGitOid(rawTree, `git log header ${JSON.stringify(line)}`)
			const parents = rawParents.map((parent) =>
				requireGitOid(parent, `git log header ${JSON.stringify(line)}`),
			)
			commitTree.set(commit, tree)
			const firstParent = parents[0]
			if (firstParent !== undefined) {
				const parentTree = commitTree.get(firstParent)
				if (parentTree === undefined) {
					throw new Error(`git log was not parent-before-child at commit ${commit}`)
				}
				if (parentTree !== tree && !pairs.has(tree)) pairs.set(tree, parentTree)
			}
			sawCommit = true
			continue
		}
		if (!line.startsWith(":")) throw new Error(`unexpected git log --raw line: ${line}`)
		if (!sawCommit) throw new Error(`git log emitted a raw row before a commit: ${line}`)
		const tab = line.indexOf("\t")
		if (tab < 0 || tab === line.length - 1) {
			throw new Error(`unexpected git log --raw row: ${line}`)
		}
		const fields = line.slice(1, tab).split(" ")
		if (
			fields.length !== 5 ||
			!fields[0]?.match(/^[0-7]{6}$/) ||
			!fields[1]?.match(/^[0-7]{6}$/) ||
			!fields[4]?.match(/^[A-Z][0-9]*$/)
		) {
			throw new Error(`unexpected git log --raw metadata: ${line}`)
		}
		const oldOid = fields[2] as string
		const newOid = fields[3] as string
		const zero = "0".repeat(40)
		if (oldOid !== zero)
			requireGitOid(oldOid, `git log --raw row ${JSON.stringify(line)}`)
		if (newOid !== zero)
			requireGitOid(newOid, `git log --raw row ${JSON.stringify(line)}`)
		if (oldOid === zero || newOid === zero || oldOid === newOid || pairs.has(newOid)) {
			continue
		}
		pairs.set(newOid, oldOid)
	}
	if (!sawCommit) throw new Error("git log --raw returned no commits")
	return pairs
}

export type GitObjectWithOid = PackInputObject & { oid: Oid }

/** Read the requested objects through one binary-safe `cat-file --batch` process. */
export async function loadGitObjects(
	dir: string,
	oids: readonly string[],
): Promise<GitObjectWithOid[]> {
	if (oids.length === 0) return []
	const requested = oids.map((oid) => requireGitOid(oid, "cat-file --batch request"))
	const batch = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${requested.join("\n")}\n`,
	})
	const objects: GitObjectWithOid[] = []
	let pos = 0
	for (const expectedOid of requested) {
		const newline = batch.stdoutBytes.indexOf(0x0a, pos)
		if (newline < 0) {
			throw new Error(`cat-file --batch: missing header at byte ${pos}`)
		}
		const header = batch.stdoutBytes.toString("ascii", pos, newline)
		const match = header.match(/^([0-9a-f]{40}) (blob|commit|tag|tree) ([0-9]+)$/)
		if (match === null) {
			throw new Error(`cat-file --batch: unexpected header ${JSON.stringify(header)}`)
		}
		const [, returnedOid, rawType, rawSize] = match as [string, string, string, string]
		if (returnedOid !== expectedOid) {
			throw new Error(
				`cat-file --batch: returned ${returnedOid} while reading ${expectedOid}`,
			)
		}
		const size = Number(rawSize)
		if (!Number.isSafeInteger(size)) {
			throw new Error(`cat-file --batch: invalid size in ${JSON.stringify(header)}`)
		}
		const contentStart = newline + 1
		const contentEnd = contentStart + size
		if (
			contentEnd >= batch.stdoutBytes.length ||
			batch.stdoutBytes[contentEnd] !== 0x0a
		) {
			throw new Error(`cat-file --batch: truncated record for ${expectedOid}`)
		}
		objects.push({
			content: batch.stdoutBytes.subarray(contentStart, contentEnd),
			oid: expectedOid,
			type: requireGitObjectType(rawType, `cat-file header ${JSON.stringify(header)}`),
		})
		pos = contentEnd + 1
	}
	if (pos !== batch.stdoutBytes.length) {
		throw new Error(
			`cat-file --batch: ${batch.stdoutBytes.length - pos} unexpected trailing bytes`,
		)
	}
	return objects
}

async function loadObjects(
	dir: string,
	oids: readonly string[],
): Promise<PackInputObject[]> {
	return loadGitObjects(dir, oids)
}

/** Every object in a real repo, as pack inputs (content read binary-safe). */
export async function loadAllObjects(dir: string): Promise<PackInputObject[]> {
	return loadObjects(dir, await allObjectOids(dir))
}

/** Every object reachable from the supplied revisions, as pack inputs. */
export async function loadReachableObjects(
	dir: string,
	revisions: readonly string[],
): Promise<GitObjectWithOid[]> {
	const list = await spawnGit(["rev-list", "--objects", ...revisions], { cwd: dir })
	return loadGitObjects(dir, [...new Set(parseRevListObjectOids(list.stdout))])
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
			requireGitObjectType(type, `ls-tree line ${JSON.stringify(line)}`)
			return {
				mode,
				oid: requireGitOid(oid, `ls-tree line ${JSON.stringify(line)}`),
				path,
			}
		})
}

/** A revision's recursive tree as sorted `path\0mode\0oid` rows. */
export async function lsTreeSnapshot(dir: string, revision: string): Promise<string[]> {
	const out = await spawnGit(["ls-tree", "-r", revision], { cwd: dir })
	return parseLsTree(out.stdout)
		.map((entry) => `${entry.path}\0${entry.mode}\0${entry.oid}`)
		.sort()
}

/** Resolve a rev (ref name, HEAD, oid^) to its full validated oid. */
export async function revParse(dir: string, rev: string): Promise<string> {
	const out = await spawnGit(["rev-parse", rev], { cwd: dir })
	return requireGitOid(out.stdout.trim(), `rev-parse ${rev}`)
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

/** A byte-exact digest of the requested objects, read in stable oid order. */
export async function objectBytesDigest(
	dir: string,
	oids: readonly string[],
): Promise<string> {
	const unique = [
		...new Set(oids.map((oid) => requireGitOid(oid, "object digest request"))),
	].sort()
	const objects = await loadObjects(dir, unique)
	const digest = createHash("sha256")
	for (const [index, oid] of unique.entries()) {
		const object = objects[index]
		if (object === undefined) {
			throw new Error(`cat-file --batch omitted digest object ${oid}`)
		}
		digest.update(`${oid} ${object.type} ${object.content.length}\n`)
		digest.update(object.content)
		digest.update("\n")
	}
	return digest.digest("hex")
}

/** Everything a client can observe through a canonical mirror clone. */
export type MirrorState = {
	refs: string[]
	objects: string[]
	digest: string
	fsck: string
}

/** Served and canonical mirror observations, plus their directional object-set difference. */
export type MirrorComparison = {
	served: MirrorState
	oracle: MirrorState
	objects: {
		onlyServed: string[]
		onlyOracle: string[]
	}
}

export type TypedGitRef = { name: string; oid: Oid; type: GitObjectType }

/** Every direct ref with the object type named by its OID. */
export async function typedRefsOf(dir: string): Promise<TypedGitRef[]> {
	const out = await spawnGit(
		["for-each-ref", "--format=%(objectname) %(refname) %(objecttype)"],
		{ cwd: dir },
	)
	const refs: TypedGitRef[] = []
	for (const line of out.stdout.trim().split("\n").filter(Boolean)) {
		const fields = line.split(" ")
		if (fields.length !== 3) {
			throw new Error(`unexpected for-each-ref line: ${line}`)
		}
		const [rawOid, name, rawType] = fields as [string, string, string]
		if (!name.startsWith("refs/")) throw new Error(`unexpected ref name: ${line}`)
		refs.push({
			name,
			oid: requireGitOid(rawOid, `for-each-ref line ${JSON.stringify(line)}`),
			type: requireGitObjectType(rawType, `for-each-ref line ${JSON.stringify(line)}`),
		})
	}
	return refs.sort((a, b) => a.name.localeCompare(b.name))
}

/** Symbolic HEAD target and the OID it resolves to. */
export async function repositoryHeadOf(
	dir: string,
): Promise<{ oid: Oid; target: string }> {
	const target = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: dir })).stdout.trim()
	if (!target.startsWith("refs/")) {
		throw new Error(`repository has invalid HEAD target ${JSON.stringify(target)}`)
	}
	const oid = requireGitOid(
		(await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim(),
		"repository HEAD",
	)
	return { oid, target }
}

function parseRefRows(
	stdout: string,
	command: "for-each-ref" | "show-ref",
): { name: string; oid: Oid }[] {
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const split = line.indexOf(" ")
			if (split < 0 || split === line.length - 1) {
				throw new Error(`unexpected ${command} line: ${line}`)
			}
			return {
				name: line.slice(split + 1),
				oid: requireGitOid(
					line.slice(0, split),
					`${command} line ${JSON.stringify(line)}`,
				),
			}
		})
}

/** Mirror-clone a remote and return its validated refs, objects, bytes, and fsck. */
export async function mirrorClone(url: string, dest: string): Promise<MirrorState> {
	await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
	const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
	const refs = (await allRefsOf(dest)).map(({ name, oid }) => `${oid} ${name}`)
	const head = await repositoryHeadOf(dest)
	refs.push(`${head.oid} HEAD -> ${head.target}`)
	refs.sort()
	const complaints = `${fsck.stdout}${fsck.stderr}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("notice:"))
	const objects = await allObjectOids(dest)
	return {
		digest: await objectBytesDigest(dest, objects),
		fsck: complaints.join("\n"),
		objects,
		refs,
	}
}

/** Clone both remotes and return comparison data without asserting on it. */
export async function compareMirrorClones(
	served: { url: string; dest: string },
	oracle: { url: string; dest: string },
): Promise<MirrorComparison> {
	const servedState = await mirrorClone(served.url, served.dest)
	const oracleState = await mirrorClone(oracle.url, oracle.dest)
	const difference = listDifferences(servedState.objects, oracleState.objects)
	return {
		objects: {
			onlyOracle: difference.onlyRight,
			onlyServed: difference.onlyLeft,
		},
		oracle: oracleState,
		served: servedState,
	}
}

/** Every direct ref in a repository as sorted name/OID pairs. */
export async function allRefsOf(dir: string): Promise<{ name: string; oid: string }[]> {
	return (await typedRefsOf(dir)).map(({ name, oid }) => ({ name, oid }))
}

/** A repo's local branches + tags as sorted name/OID pairs, matching the refs a normal push transfers. */
export async function branchAndTagRefsOf(
	dir: string,
): Promise<{ name: string; oid: string }[]> {
	const out = await spawnGit(
		["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/", "refs/tags/"],
		{ cwd: dir },
	)
	return parseRefRows(out.stdout, "for-each-ref").sort((a, b) =>
		a.name.localeCompare(b.name),
	)
}

/** Write every direct ref plus symbolic HEAD from a canonical repository into a RefStore. */
export async function seedGitRefs(
	repoId: string,
	srcDir: string,
	refs: RefStore,
): Promise<{ directRefs: number; head: string }> {
	const showRef = await spawnGit(["show-ref"], { cwd: srcDir })
	const direct = parseRefRows(showRef.stdout, "show-ref")
	if (direct.length === 0) throw new Error(`${srcDir}: repository has no direct refs`)
	for (const { name, oid } of direct) await refs.setRef(repoId, name, oid)
	const { target: head } = await repositoryHeadOf(srcDir)
	await refs.setSymref(repoId, "HEAD", head)
	return { directRefs: direct.length, head }
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
	await seedGitRefs(repoId, srcDir, stores.refs)
}

export const PACK_DIR = ".git/objects/pack"

/** The `.pack` filenames in a real repo's pack dir. */
export function packFiles(dir: string): string[] {
	return readdirSync(join(dir, PACK_DIR)).filter((f) => f.endsWith(".pack"))
}

/** Total bytes occupied by a real repo's pack files, bare or non-bare. */
export async function packFileBytes(dir: string): Promise<number> {
	const packDir = (
		await spawnGit(
			["rev-parse", "--path-format=absolute", "--git-path", "objects/pack"],
			{ cwd: dir },
		)
	).stdout.trim()
	return readdirSync(packDir)
		.filter((file) => file.endsWith(".pack"))
		.map((file) => statSync(join(packDir, file)).size)
		.reduce((total, size) => total + size, 0)
}

export type VerifyPackObject =
	| {
			kind: "whole"
			oid: string
			offset: number
			packedSize: number
			size: number
			type: GitObjectType
	  }
	| {
			baseOid: string
			depth: number
			kind: "delta"
			oid: string
			offset: number
			packedSize: number
			size: number
			type: GitObjectType
	  }

function verifyPackInteger(value: string, field: string, line: string): number {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`invalid verify-pack ${field} in line: ${line}`)
	}
	return parsed
}

/** Every object row inside one `git verify-pack -v` report, including whether it
 * is deltified. Summary rows are validated and omitted from the result. */
export function parseVerifyPackObjects(stdout: string): VerifyPackObject[] {
	const objects: VerifyPackObject[] = []
	for (const line of stdout.trim().split("\n").filter(Boolean)) {
		const object = line.match(
			/^([0-9a-f]{40})\s+(commit|tree|blob|tag)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)(?:\s+([0-9]+)\s+([0-9a-f]{40}))?$/,
		)
		if (object?.[1]) {
			const [, rawOid, rawType, rawSize, rawPackedSize, rawOffset, rawDepth, rawBaseOid] =
				object as [string, string, string, string, string, string, string?, string?]
			const oid = requireGitOid(rawOid, `verify-pack line ${JSON.stringify(line)}`)
			const type = requireGitObjectType(
				rawType,
				`verify-pack line ${JSON.stringify(line)}`,
			)
			const size = verifyPackInteger(rawSize, "object size", line)
			const packedSize = verifyPackInteger(rawPackedSize, "packed size", line)
			const offset = verifyPackInteger(rawOffset, "offset", line)
			if (rawDepth === undefined || rawBaseOid === undefined) {
				objects.push({ kind: "whole", offset, oid, packedSize, size, type })
				continue
			}
			const depth = verifyPackInteger(rawDepth, "delta depth", line)
			if (depth === 0) {
				throw new Error(`invalid verify-pack delta depth in line: ${line}`)
			}
			objects.push({
				baseOid: requireGitOid(
					rawBaseOid,
					`verify-pack base in line ${JSON.stringify(line)}`,
				),
				depth,
				kind: "delta",
				offset,
				oid,
				packedSize,
				size,
				type,
			})
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
			type: requireGitObjectType(type, `object-list line ${JSON.stringify(line)}`),
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

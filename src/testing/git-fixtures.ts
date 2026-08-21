import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Sql } from "postgres"
import { z } from "zod"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import type { GitObjectType } from "@/object/object"
import { isOid, type Oid } from "@/object/oid"
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

function oidDifference(actual: readonly Oid[], expected: readonly Oid[]): string {
	const difference = listDifferences(actual, expected)
	return JSON.stringify({
		actual: actual.length,
		expected: expected.length,
		onlyActual: difference.onlyLeft.slice(0, 8),
		onlyExpected: difference.onlyRight.slice(0, 8),
	})
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
export function parseRevListObjectOids(stdout: string): Oid[] {
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
export async function gitReachableOids(dir: string): Promise<Oid[]> {
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
		const [type, oid] = fields
		if (fields.length !== 2 || type === undefined || oid === undefined) {
			throw new Error(`unexpected for-each-ref line: ${line}`)
		}
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

/** Prove that a canonical Git repository is healthy and has exactly the expected reachable objects. */
export async function assertGitReachableObjects(
	dir: string,
	expectedOids: readonly Oid[],
	context: string,
): Promise<void> {
	const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dir })
	const fsckOutput = `${fsck.stdout}${fsck.stderr}`.trim()
	if (fsckOutput !== "") {
		throw new Error(`${context}: fsck emitted output: ${fsckOutput}`)
	}
	const actual = await gitReachableOids(dir)
	const expected = [...expectedOids].sort()
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`${context}: reachable object set differs: ${oidDifference(actual, expected)}`,
		)
	}
}

/** Same-path target-to-base pairs from one parent-before-child `git log --raw` stream. */
export async function gitLogRawBasePairs(dir: string): Promise<Map<Oid, Oid>> {
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
	const pairs = new Map<Oid, Oid>()
	const commitTree = new Map<Oid, Oid>()
	let sawCommit = false
	for (const line of log.stdout.split("\n")) {
		if (line.length === 0) continue
		if (line.startsWith("@")) {
			const fields = line.slice(1).trimEnd().split(" ").filter(Boolean)
			const [rawCommit, rawTree, ...rawParents] = fields
			if (rawCommit === undefined || rawTree === undefined) {
				throw new Error(`unexpected git log header: ${line}`)
			}
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
		const [oldMode, newMode, oldOid, newOid, status] = fields
		if (
			fields.length !== 5 ||
			oldMode === undefined ||
			newMode === undefined ||
			oldOid === undefined ||
			newOid === undefined ||
			status === undefined ||
			!oldMode.match(/^[0-7]{6}$/) ||
			!newMode.match(/^[0-7]{6}$/) ||
			!status.match(/^[A-Z][0-9]*$/)
		) {
			throw new Error(`unexpected git log --raw metadata: ${line}`)
		}
		const parseEntryOid = (
			value: string,
		): { kind: "zero" } | { kind: "oid"; oid: Oid } =>
			value === "0".repeat(40)
				? { kind: "zero" }
				: {
						kind: "oid",
						oid: requireGitOid(value, `git log --raw row ${JSON.stringify(line)}`),
					}
		const oldEntry = parseEntryOid(oldOid)
		const newEntry = parseEntryOid(newOid)
		if (
			oldEntry.kind === "zero" ||
			newEntry.kind === "zero" ||
			oldEntry.oid === newEntry.oid ||
			pairs.has(newEntry.oid)
		) {
			continue
		}
		pairs.set(newEntry.oid, oldEntry.oid)
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
		const [, returnedOid, rawType, rawSize] = match
		if (returnedOid === undefined || rawType === undefined || rawSize === undefined) {
			throw new Error(`cat-file --batch: incomplete header ${JSON.stringify(header)}`)
		}
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
export async function loadAllObjects(dir: string): Promise<GitObjectWithOid[]> {
	return loadGitObjects(dir, await allObjectOids(dir))
}

/** Every object reachable from any ref, including annotated-tag objects. */
export async function loadAllReachableObjects(dir: string): Promise<GitObjectWithOid[]> {
	return loadGitObjects(dir, await gitReachableOids(dir))
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
export function parseLsTree(stdout: string): { mode: string; oid: Oid; path: string }[] {
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const tab = line.indexOf("\t")
			if (tab < 0) throw new Error(`unexpected ls-tree line: ${line}`)
			const path = line.slice(tab + 1)
			const meta = line.slice(0, tab).split(" ")
			const [mode, type, oid] = meta
			if (
				meta.length !== 3 ||
				mode === undefined ||
				type === undefined ||
				oid === undefined ||
				path.length === 0
			) {
				throw new Error(`unexpected ls-tree meta: ${line}`)
			}
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
export async function revParse(dir: string, rev: string): Promise<Oid> {
	const out = await spawnGit(["rev-parse", rev], { cwd: dir })
	return requireGitOid(out.stdout.trim(), `rev-parse ${rev}`)
}

/** Sorted list of every object OID in a real repo. */
export async function allObjectOids(dir: string): Promise<Oid[]> {
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

export type GitObjectInventory = Map<Oid, { size: number; type: GitObjectType }>

/** Every stored object as validated oid/type/size metadata in oid order. */
export async function gitObjectInventory(dir: string): Promise<GitObjectInventory> {
	const out = await spawnGit(
		[
			"cat-file",
			"--batch-all-objects",
			"--batch-check=%(objectname) %(objecttype) %(objectsize)",
		],
		{ cwd: dir },
	)
	const inventory: GitObjectInventory = new Map()
	for (const line of out.stdout.trim().split("\n").filter(Boolean)) {
		const match = line.match(/^([0-9a-f]{40}) (blob|commit|tag|tree) ([0-9]+)$/)
		if (match === null) {
			throw new Error(`${dir}: malformed object inventory row ${JSON.stringify(line)}`)
		}
		const [, rawOid, rawType, rawSize] = match
		if (rawOid === undefined || rawType === undefined || rawSize === undefined) {
			throw new Error(`${dir}: incomplete object inventory row ${JSON.stringify(line)}`)
		}
		const oid = requireGitOid(rawOid, `object inventory row ${JSON.stringify(line)}`)
		const size = Number(rawSize)
		if (!Number.isSafeInteger(size)) {
			throw new Error(
				`${dir}: invalid object size in inventory row ${JSON.stringify(line)}`,
			)
		}
		if (inventory.has(oid)) throw new Error(`${dir}: duplicate inventory oid ${oid}`)
		inventory.set(oid, {
			size,
			type: requireGitObjectType(rawType, `object inventory row ${JSON.stringify(line)}`),
		})
	}
	if (inventory.size === 0) throw new Error(`${dir}: object inventory was empty`)
	return inventory
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
	objects: Oid[]
	digest: string
	fsck: string
}

/** Served and canonical mirror observations, plus their directional object-set difference. */
export type MirrorComparison = {
	served: MirrorState
	oracle: MirrorState
	objects: {
		onlyServed: Oid[]
		onlyOracle: Oid[]
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
		const [rawOid, name, rawType] = fields
		if (
			fields.length !== 3 ||
			rawOid === undefined ||
			name === undefined ||
			rawType === undefined
		) {
			throw new Error(`unexpected for-each-ref line: ${line}`)
		}
		if (!name.startsWith("refs/")) throw new Error(`unexpected ref name: ${line}`)
		refs.push({
			name,
			oid: requireGitOid(rawOid, `for-each-ref line ${JSON.stringify(line)}`),
			type: requireGitObjectType(rawType, `for-each-ref line ${JSON.stringify(line)}`),
		})
	}
	return refs.sort((a, b) => a.name.localeCompare(b.name))
}

/** A repository's symbolic HEAD target, including when the target is unborn. */
export async function repositoryHeadTargetOf(dir: string): Promise<string> {
	const target = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: dir })).stdout.trim()
	if (!target.startsWith("refs/")) {
		throw new Error(`repository has invalid HEAD target ${JSON.stringify(target)}`)
	}
	return target
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

/** Parse and validate the two-column ref advertisement emitted by `git ls-remote`. */
export function parseLsRemoteRefs(
	stdout: string,
	context: string,
): { name: string; oid: Oid }[] {
	const rows = stdout.trim().split("\n").filter(Boolean)
	if (rows.length === 0) throw new Error(`${context}: ls-remote advertised no refs`)
	return rows
		.map((line) => {
			const fields = line.split("\t")
			const [rawOid, name] = fields
			if (
				fields.length !== 2 ||
				rawOid === undefined ||
				name === undefined ||
				name.length === 0
			) {
				throw new Error(`${context}: malformed ls-remote row ${JSON.stringify(line)}`)
			}
			return {
				name,
				oid: requireGitOid(rawOid, `${context} ls-remote row ${JSON.stringify(line)}`),
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.oid.localeCompare(b.oid))
}

/** Observe the validated refs, objects, bytes, and fsck state of a mirror-shaped repository. */
export async function mirrorStateOf(dir: string): Promise<MirrorState> {
	const fsck = await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dir })
	const refs = (await allRefsOf(dir)).map(({ name, oid }) => `${oid} ${name}`)
	// HEAD is listed by target only: a symref's OID is its target ref's line, and
	// an emptied repository's HEAD is unborn — it has a target but no OID.
	refs.push(`HEAD -> ${await repositoryHeadTargetOf(dir)}`)
	refs.sort()
	const complaints = `${fsck.stdout}${fsck.stderr}`
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("notice:"))
	const objects = await allObjectOids(dir)
	return {
		digest: await objectBytesDigest(dir, objects),
		fsck: complaints.join("\n"),
		objects,
		refs,
	}
}

/** Mirror-clone a remote and return its validated refs, objects, bytes, and fsck. */
export async function mirrorClone(url: string, dest: string): Promise<MirrorState> {
	await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
	return mirrorStateOf(dest)
}

/** Make a mirror whose object files are physically independent from the source. */
export async function cloneIndependentMirror(
	source: string,
	dest: string,
): Promise<void> {
	await spawnGit(["clone", "--mirror", "--no-hardlinks", "-q", source, dest])
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
export async function allRefsOf(dir: string): Promise<{ name: string; oid: Oid }[]> {
	return (await typedRefsOf(dir)).map(({ name, oid }) => ({ name, oid }))
}

/** A repo's local branches + tags as sorted name/OID pairs, matching the refs a normal push transfers. */
export async function branchAndTagRefsOf(
	dir: string,
): Promise<{ name: string; oid: Oid }[]> {
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
	const head = await repositoryHeadTargetOf(srcDir)
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

export type CanonicalStoreRef =
	| { kind: "direct"; name: string; oid: Oid }
	| { kind: "symbolic"; name: string; target: string }

export type CanonicalStoreFixture = {
	objects: readonly GitObjectWithOid[]
	refs: readonly CanonicalStoreRef[]
	encodings:
		| { kind: "unchecked" }
		| { kind: "exact"; objects: readonly GitObjectWithOid[] }
}

/** The complete direct-ref plus symbolic-HEAD identity stored for a canonical repo. */
export async function canonicalStoreRefsOf(dir: string): Promise<CanonicalStoreRef[]> {
	const [directRefs, head] = await Promise.all([
		typedRefsOf(dir),
		repositoryHeadTargetOf(dir),
	])
	const expectedDirectRefs: CanonicalStoreRef[] = directRefs.map(({ name, oid }) => ({
		kind: "direct",
		name,
		oid,
	}))
	return [...expectedDirectRefs, { kind: "symbolic", name: "HEAD", target: head }]
}

/** Objects eligible for the stored encoding tier's inline-payload contract. */
export function repackEligibleObjects(
	objects: readonly GitObjectWithOid[],
): GitObjectWithOid[] {
	return objects.filter((object) => object.content.length < MAX_INLINE_BYTEA_BYTES)
}

/** Prove one Postgres fixture against its complete canonical object/ref identity. */
export async function assertCanonicalStoreFixture(
	sql: Sql,
	repoName: string,
	expected: CanonicalStoreFixture,
): Promise<void> {
	const [repo] = await sql<{ id: string }[]>`
		select id::text as id from repos where name = ${repoName}`
	if (repo === undefined)
		throw new Error(`canonical fixture ${repoName} has no repos row`)
	const expectedOids = (type?: GitObjectType): Oid[] =>
		expected.objects
			.filter((object) => type === undefined || object.type === type)
			.map(({ oid }) => oid)
			.sort()
	const storedOids = async (
		table: "git_object" | "git_commit" | "git_tag",
	): Promise<Oid[]> =>
		(
			await sql<{ oid: string }[]>`
				select encode(oid, 'hex') as oid from ${sql(table)}
				where repo_id = ${repo.id}::bigint order by oid`
		).map(({ oid }) => requireGitOid(oid, `${table} fixture row`))
	const identities: readonly (readonly [string, readonly Oid[], readonly Oid[]])[] = [
		["objects", await storedOids("git_object"), expectedOids()],
		["commits", await storedOids("git_commit"), expectedOids("commit")],
		["tags", await storedOids("git_tag"), expectedOids("tag")],
	]
	for (const [label, actual, wanted] of identities) {
		if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
			throw new Error(
				`canonical fixture ${repoName} has the wrong ${label}: ${oidDifference(actual, wanted)}`,
			)
		}
	}
	const rows = await sql<{ name: string; oid: string | null; target: string | null }[]>`
		select name, encode(oid, 'hex') as oid, symref_target as target from git_ref
		where repo_id = ${repo.id}::bigint order by name`
	const actualRefs: CanonicalStoreRef[] = rows.map((row) => {
		if (row.oid !== null && row.target === null) {
			return {
				kind: "direct",
				name: row.name,
				oid: requireGitOid(row.oid, `git_ref fixture row ${row.name}`),
			}
		}
		if (row.oid === null && row.target !== null) {
			return { kind: "symbolic", name: row.name, target: row.target }
		}
		throw new Error(`canonical fixture ${repoName} has malformed ref ${row.name}`)
	})
	const expectedRefs = [...expected.refs].sort((a, b) => a.name.localeCompare(b.name))
	if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
		throw new Error(
			`canonical fixture ${repoName} has the wrong refs: actual=${JSON.stringify(actualRefs)}, expected=${JSON.stringify(expectedRefs)}`,
		)
	}
	if (expected.encodings.kind === "exact") {
		const encodingOids = (
			await sql<{ oid: string }[]>`
				select encode(oid, 'hex') as oid from git_pack_encoding
				where repo_id = ${repo.id}::bigint order by oid`
		).map(({ oid }) => requireGitOid(oid, "git_pack_encoding fixture row"))
		const expectedEncodingOids = expected.encodings.objects.map(({ oid }) => oid).sort()
		if (JSON.stringify(encodingOids) !== JSON.stringify(expectedEncodingOids)) {
			throw new Error(
				`canonical fixture ${repoName} has the wrong encoding OIDs: ${oidDifference(encodingOids, expectedEncodingOids)}`,
			)
		}
	}
}

export const PACK_DIR = ".git/objects/pack"

/** The `.pack` filenames in a real repo's pack dir. */
export function packFiles(dir: string): string[] {
	return readdirSync(join(dir, PACK_DIR)).filter((f) => f.endsWith(".pack"))
}

async function gitPackDir(dir: string): Promise<string> {
	return (
		await spawnGit(
			["rev-parse", "--path-format=absolute", "--git-path", "objects/pack"],
			{ cwd: dir },
		)
	).stdout.trim()
}

/** Total bytes occupied by a real repo's pack files, bare or non-bare. */
export async function packFileBytes(dir: string): Promise<number> {
	const packDir = await gitPackDir(dir)
	return readdirSync(packDir)
		.filter((file) => file.endsWith(".pack"))
		.map((file) => statSync(join(packDir, file)).size)
		.reduce((total, size) => total + size, 0)
}

export type VerifyPackObject =
	| {
			kind: "whole"
			oid: Oid
			offset: number
			packedSize: number
			size: number
			type: GitObjectType
	  }
	| {
			baseOid: Oid
			depth: number
			kind: "delta"
			oid: Oid
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
		if (object !== null) {
			const [, rawOid, rawType, rawSize, rawPackedSize, rawOffset, rawDepth, rawBaseOid] =
				object
			if (
				rawOid === undefined ||
				rawType === undefined ||
				rawSize === undefined ||
				rawPackedSize === undefined ||
				rawOffset === undefined
			) {
				throw new Error(`verify-pack object row omitted a field: ${line}`)
			}
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

/** Validated object rows grouped by pack index in a bare or non-bare repository. */
export async function verifyPackObjectsInRepo(
	dir: string,
): Promise<{ index: string; objects: VerifyPackObject[] }[]> {
	const packDir = await gitPackDir(dir)
	const indexes = readdirSync(packDir).filter((file) => file.endsWith(".idx"))
	if (indexes.length === 0) throw new Error(`${dir}: repository contains no pack index`)
	const packs: { index: string; objects: VerifyPackObject[] }[] = []
	for (const index of indexes) {
		const out = await spawnGit(["verify-pack", "-v", join(packDir, index)], { cwd: dir })
		packs.push({ index, objects: parseVerifyPackObjects(out.stdout) })
	}
	return packs
}

/** The sorted OIDs inside one pack, per `git verify-pack -v`. */
export function parseVerifyPackObjectOids(stdout: string): Oid[] {
	return parseVerifyPackObjects(stdout)
		.map((object) => object.oid)
		.sort()
}

/** The OIDs inside one pack, per `git verify-pack -v` (the bytes git received). */
export async function packObjectOids(dir: string, packFile: string): Promise<Oid[]> {
	const idx = join(dir, PACK_DIR, packFile.replace(/\.pack$/, ".idx"))
	const out = await spawnGit(["verify-pack", "-v", idx], { cwd: dir })
	return parseVerifyPackObjectOids(out.stdout)
}

/** Every object in a real repo as `{oid, type}` (one `cat-file --batch-all-objects`
 * scan). */
export async function objectsByType(
	dir: string,
): Promise<{ oid: Oid; type: GitObjectType }[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const out: { oid: Oid; type: GitObjectType }[] = []
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

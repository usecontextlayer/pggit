/**
 * PG TYPE-BOUNDARY PROBE — two distinct git paths COLLIDE in `repo_file.path text`.
 *
 * `src/e2e/non-utf8-paths.test.ts` locks a known, accepted limitation: ONE
 * non-UTF-8 path is stored U+FFFD-mangled in the queryable `repo_file` projection
 * while the objects stay byte-faithful. It tests a repo with exactly one such file,
 * so it can never see what this goes after: the mangling is not injective.
 *
 * `a\xe9.txt` and `a\xea.txt` are two distinct files to git. Both decode to the same
 * `a�.txt` at `treeEntries`'s `Buffer.toString("utf8")` (object/object.ts), and
 * `repo_file`'s PK is (repo_id, ref_name, path). The projection write goes through
 * `copyInsert`, which ends in `INSERT … ON CONFLICT DO NOTHING` — so the collision
 * is not an error, it is a SILENT DROP: one of the two files simply does not exist
 * in pggit's published read surface (`repo_file ⋈ git_object`, the ONE documented
 * read mechanism), and the path that survives carries the other file's blob only by
 * COPY ordering.
 *
 * No console error, no `ng` on the wire, no failed push. The git side is perfect.
 *
 * The tree is hand-framed through git plumbing: porcelain cannot lay down a
 * non-UTF-8 entry name under LC_ALL=C, and the oracle is `git ls-tree -r -z` over
 * the same source repo — the byte-exact file list the projection must mirror.
 *
 * Converted from `breakage/pg-corrupt--non-utf8-path-collision.ts`, whose verdict
 * was: exit 0 = the projection matches `git ls-tree -r`; non-zero = reproduced.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/badpath"

/** Entry names as RAW BYTES: "a<0xe9>.txt" and "a<0xea>.txt" — two distinct,
 * fsck-clean git paths that both decode to "a�.txt". */
const NAME_E9 = Buffer.concat([
	Buffer.from("a"),
	Buffer.from([0xe9]),
	Buffer.from(".txt"),
])
const NAME_EA = Buffer.concat([
	Buffer.from("a"),
	Buffer.from([0xea]),
	Buffer.from(".txt"),
])
const NAME_OK = Buffer.from("plain.txt")

type FileRow = { h: string; blob: string; content: string }

describe("pg-corrupt — two non-UTF-8 paths collide in the repo_file projection", () => {
	let db: IsolatedDb
	let server: GitServer
	let src = ""
	let commit = ""
	let clonedTip = ""
	let oraclePaths: string[] = []
	let rows: FileRow[] = []
	let blobE9 = ""
	let blobEA = ""
	let blobOK = ""
	const dirs: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-badpath-${tag}-`))
		dirs.push(d)
		return d
	}

	beforeAll(async () => {
		src = mk("src")
		await spawnGit(["init", "-q", "-b", "main", src])

		const blob = async (content: string): Promise<string> =>
			(
				await spawnGit(["hash-object", "-w", "--stdin"], { cwd: src, input: content })
			).stdout.trim()
		blobE9 = await blob("AAA-from-e9\n")
		blobEA = await blob("BBB-from-ea\n")
		blobOK = await blob("plain\n")

		// Hand-frame the tree: `<mode> <name>\0<20-byte oid>`, entries in git's byte order.
		const entry = (name: Buffer, oid: string): Buffer =>
			Buffer.concat([
				Buffer.from("100644 "),
				name,
				Buffer.from([0]),
				Buffer.from(oid, "hex"),
			])
		const treeRaw = Buffer.concat([
			entry(NAME_E9, blobE9),
			entry(NAME_EA, blobEA),
			entry(NAME_OK, blobOK),
		])
		const tree = (
			await spawnGit(["hash-object", "-w", "-t", "tree", "--stdin"], {
				cwd: src,
				input: treeRaw,
			})
		).stdout.trim()
		commit = (
			await spawnGit(["commit-tree", tree, "-m", "c1"], { cwd: src, input: "" })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/main", commit], { cwd: src })

		const fsckSrc = await spawnGit(["fsck", "--full", "--strict"], { cwd: src })
		console.log(`source fsck exit=${fsckSrc.code} (canonical git is happy)`)

		// The oracle: what the tip's file list IS, byte-exact.
		const lsTree = (
			await spawnGit(["ls-tree", "-r", "-z", "refs/heads/main"], { cwd: src })
		).stdoutBytes
		oraclePaths = lsTree
			.toString("latin1")
			.split("\0")
			.filter(Boolean)
			.map((rec) => rec.slice(rec.indexOf("\t") + 1))
			.sort()
		console.log("ORACLE `git ls-tree -r` paths (hex):")
		for (const p of oraclePaths)
			console.log(`  ${Buffer.from(p, "latin1").toString("hex")}`)

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		const push = await spawnGit(["push", url, "refs/heads/main:refs/heads/main"], {
			cwd: src,
		})
		console.log(`pggit push exit=${push.code} — ${push.stderr.trim().split("\n").pop()}`)

		const dest = join(mk("clone"), "c.git")
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", url, dest])
		await spawnGit(["fsck", "--full", "--strict", "--no-dangling"], { cwd: dest })
		clonedTip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dest })
		).stdout.trim()

		// The READ SURFACE: `repo_file ⋈ git_object`, the one documented read mechanism.
		rows = await db.sql<FileRow[]>`
			select encode(convert_to(f.path, 'UTF8'), 'hex') as h,
			       encode(f.blob_oid, 'hex') as blob,
			       encode(o.content, 'escape') as content
			from repo_file f
				join repos r on r.id = f.repo_id
				join git_object o on o.repo_id = f.repo_id and o.oid = f.blob_oid
			where r.name = ${REPO} and f.ref_name = 'refs/heads/main'
			order by f.path collate "C"`
		console.log("pggit repo_file rows (path hex → blob → content):")
		for (const r of rows) {
			console.log(`  ${r.h} → ${r.blob.slice(0, 8)} → ${JSON.stringify(r.content)}`)
		}
	}, 300_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("keeps the object layer byte-faithful — the clone tip is the source tip", () => {
		// This half already works and must keep working: an identical content-addressed
		// commit OID proves the tree, including both non-UTF-8 entry names, survived.
		expect(clonedTip).toBe(commit)
	})

	it("publishes one repo_file row per file in the tip", () => {
		// A shortfall here is a SILENT DROP: no error, no `ng`, push reported success.
		expect(rows.length).toBe(oraclePaths.length)
	})

	it("publishes a repo_file row for every blob reachable at the tip", () => {
		const blobs = new Set(rows.map((r) => r.blob))
		const expected = [
			["a<e9>.txt", blobE9],
			["a<ea>.txt", blobEA],
			["plain.txt", blobOK],
		] as const
		const missing = expected
			.filter(([, oid]) => !blobs.has(oid))
			.map(
				([label, oid]) =>
					`blob ${oid.slice(0, 8)} (${label}) is reachable in git but has NO repo_file row`,
			)
		expect(missing).toEqual([])
	})
})

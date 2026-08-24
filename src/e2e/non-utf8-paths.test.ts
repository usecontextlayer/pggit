/**
 * Non-UTF-8 filenames are REJECTED at push ingest (design D16).
 *
 * A git path is an arbitrary byte string (only NUL and `/` are forbidden). A
 * tree entry named `bad\xff\xfename.txt` is perfectly valid to canonical git and
 * fsck-clean. pggit deliberately diverges: paths are UTF-8, judged on the raw
 * entry-name bytes at the ingest boundary (`validateObject`, GitFormatError
 * `non-utf8-path`), so the queryable `repo_file path text` projection is EXACT.
 *
 * A lossy U+FFFD decode would not be injective: two byte-distinct paths could
 * collapse onto one projection row and one be SILENTLY dropped (see
 * `src/e2e/regressions/pg-corrupt/non-utf8-path-collision.test.ts`). Rejection at
 * the boundary removes that class instead of handling it.
 *
 * Asserted here: canonical git accepts the repo (the divergence is real and
 * deliberate); pggit rejects the push at unpack; NOTHING lands (no objects, no
 * ref); and the repo is not wedged — a clean-path push then succeeds.
 *
 * The tree is hand-framed via plumbing: `git add` cannot create an
 * invalid-UTF-8 filename from a Node argv (always UTF-8) or under LC_ALL=C.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createRepoFileProjection } from "@/repo-file/projection"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

describe("non-UTF-8 filename: rejected at ingest, projection stays exact", () => {
	let isolated: IsolatedDb
	let server: GitServer
	let url: string
	const dirs: string[] = []

	// The TRUE filename bytes: "bad" + 0xff 0xfe + "name.txt" — invalid UTF-8, legal git.
	const NAME = Buffer.concat([
		Buffer.from("bad"),
		Buffer.from([0xff, 0xfe]),
		Buffer.from("name.txt"),
	])

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		isolated = await createIsolatedSchema(baseUrl)
		const objects = createObjectStore(isolated.sql)
		const refs = createRefStore(isolated.sql)
		const projection = createRepoFileProjection(isolated.sql)
		server = await serveOnPort(createGitApp({ objects, projection, refs }), 0)
		url = `http://127.0.0.1:${server.port}/repo`
	}, 120_000)

	afterAll(async () => {
		await server?.close()
		await isolated?.drop()
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("rejects the push at unpack and leaves nothing behind; a clean push then lands", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-non-utf8-path-"))
		dirs.push(src)
		await spawnGit(["init", "--quiet", src])

		// Build the tree via plumbing: hash-object the blob, hand-frame a tree object
		// `<mode> <name>\0<20-byte oid>`, and commit it.
		const blobHex = (
			await spawnGit(["hash-object", "-w", "--stdin"], { cwd: src, input: "content\n" })
		).stdout.trim()
		const treeRaw = Buffer.concat([
			Buffer.from("100644 "),
			NAME,
			Buffer.from([0]),
			Buffer.from(blobHex, "hex"),
		])
		const treeHex = (
			await spawnGit(["hash-object", "-w", "-t", "tree", "--stdin"], {
				cwd: src,
				input: treeRaw,
			})
		).stdout.trim()
		const commitHex = (
			await spawnGit(["commit-tree", treeHex, "-m", "c1"], { cwd: src, input: "" })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/main", commitHex], { cwd: src })

		// The divergence is real: canonical git considers this a clean repo. spawnGit
		// rejects on any non-zero exit, so this call IS the assertion.
		await spawnGit(["fsck", "--full", "--strict"], { cwd: src })

		// pggit rejects it — the ingest-boundary validation fails the unpack, which
		// fails every ref command; the client exits non-zero. Only a git failure is
		// expected here: a spawn fault or transport error must propagate rather than
		// be laundered into the non-zero exit the assertions below read.
		const push = await attemptGit(["push", url, "refs/heads/main:refs/heads/main"], src)
		expect(push.code, push.stderr).not.toBe(0)
		// The REASON, not just the failure: pggit's D16 path rule, reported in-band on
		// the unpack status line the client prints back.
		expect(push.stderr).toMatch(/not valid UTF-8/)
		expect(push.stderr).toMatch(/unpack/)

		// Nothing landed: no ref, no objects, no projection rows.
		const [counts] = await isolated.sql<{ refs: number; objs: number; files: number }[]>`
			select
				(select count(*) from git_ref g join repos r on r.id = g.repo_id
					where r.name = 'repo' and g.oid is not null)::int as refs,
				(select count(*) from git_object o join repos r on r.id = o.repo_id
					where r.name = 'repo')::int as objs,
				(select count(*) from repo_file f join repos r on r.id = f.repo_id
					where r.name = 'repo')::int as files`
		expect(counts).toEqual({ files: 0, objs: 0, refs: 0 })

		// Not wedged: a UTF-8-clean history pushes fine afterwards, and the projection
		// holds its exact path.
		await spawnGit(["update-ref", "-d", "refs/heads/main"], { cwd: src })
		const okBlob = (
			await spawnGit(["hash-object", "-w", "--stdin"], { cwd: src, input: "ok\n" })
		).stdout.trim()
		const okTree = Buffer.concat([
			Buffer.from("100644 good-name.txt"),
			Buffer.from([0]),
			Buffer.from(okBlob, "hex"),
		])
		const okTreeHex = (
			await spawnGit(["hash-object", "-w", "-t", "tree", "--stdin"], {
				cwd: src,
				input: okTree,
			})
		).stdout.trim()
		const okCommit = (
			await spawnGit(["commit-tree", okTreeHex, "-m", "ok"], { cwd: src, input: "" })
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/main", okCommit], { cwd: src })
		await spawnGit(["push", url, "refs/heads/main:refs/heads/main"], { cwd: src })

		const files = await isolated.sql<{ path: string }[]>`
			select f.path from repo_file f
			join repos r on r.id = f.repo_id
			where r.name = 'repo' and f.ref_name = 'refs/heads/main'`
		expect(files).toEqual([{ path: "good-name.txt" }])
	}, 120_000)
})

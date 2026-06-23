/**
 * mod — non-UTF-8 filenames: the git OBJECT layer is byte-faithful; the queryable
 * `repo_file` view's UTF-8 text is a KNOWN, ACCEPTED limitation (decision 2026-06-22).
 *
 * A git path is an arbitrary byte string (only NUL and `/` are forbidden). A tree
 * entry named `bad\xff\xfename.txt` is perfectly valid to canonical git and fsck-clean.
 *
 * What pggit GUARANTEES (asserted GREEN here): the canonical object data round-trips
 * byte-for-byte. The object store keeps tree content as raw `bytea`, so a clone back
 * is fsck-clean and the commit OID is identical — and because OIDs are content hashes,
 * an identical commit OID proves the tree (and the non-UTF-8 name bytes inside it)
 * survived exactly.
 *
 * The KNOWN LIMITATION (documented, not fixed — per the decision): the derived
 * `repo_file` view stores `path` as Postgres `text`, decoded via
 * `Buffer.toString("utf8")` (src/object/object.ts treeEntries), so non-UTF-8 name bytes
 * (0xff 0xfe) become U+FFFD. This affects ONLY the queryable text projection, never
 * the canonical objects/clone. A byte-exact view (path as `bytea`) was considered and
 * deliberately not adopted, to keep the view SQL-queryable as text; non-UTF-8 names
 * are pathological in practice. This test LOCKS both facts, so a future change to a
 * byte-exact view is a deliberate, test-updating decision rather than a silent drift.
 *
 * The live server wires `snapshots: createSnapshotStore(db)` (server.ts), so the view
 * path under test is production's.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { createSnapshotStore } from "@/repo-view/snapshot-store"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("mod — non-UTF-8 filename: faithful objects, lossy text view (known limit)", () => {
	let isolated: IsolatedDb
	let server: GitServer
	let snapshots: ReturnType<typeof createSnapshotStore>
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
		snapshots = createSnapshotStore(isolated.sql)
		server = await serveOnPort(createGitApp({ objects, refs, snapshots }), 0)
		url = `http://127.0.0.1:${server.port}/repo`
	}, 120_000)

	afterAll(async () => {
		await server?.close()
		await isolated?.drop()
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("round-trips the non-UTF-8 name byte-exact in objects; view path is lossy (documented)", async () => {
		const src = mkdtempSync(join(tmpdir(), "mod-badutf-"))
		dirs.push(src)
		await spawnGit(["init", "--quiet", src])

		// Build the tree via plumbing: a normal shell/`git add` cannot create a file with
		// invalid-UTF-8 bytes under LC_ALL=C. hash-object the blob, hand-frame a tree
		// object `<mode> <name>\0<20-byte oid>`, and commit it.
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

		// Sanity: canonical git considers this a clean repo.
		const fsckSrc = await spawnGit(["fsck", "--full", "--strict"], { cwd: src })
		expect(fsckSrc.code).toBe(0)

		// Push to pggit (objects + ref + snapshot rebuild).
		await spawnGit(["push", url, "refs/heads/main:refs/heads/main"], { cwd: src })

		// GUARANTEE — the OBJECT layer is byte-faithful. Clone back (no checkout: the
		// host FS may reject the bytes; we only care about the objects), fsck clean, and
		// the commit OID is identical. An identical content-addressed OID proves the
		// whole tree — including the exact 0xff 0xfe name bytes — round-tripped verbatim.
		const dest = mkdtempSync(join(tmpdir(), "mod-badutf-clone-"))
		dirs.push(dest)
		await spawnGit(["clone", "--quiet", "--no-checkout", url, dest])
		const fsckClone = await spawnGit(["fsck", "--full", "--strict"], { cwd: dest })
		expect(fsckClone.code).toBe(0)
		const clonedTip = (
			await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dest })
		).stdout.trim()
		expect(clonedTip).toBe(commitHex)

		// KNOWN LIMITATION — the repo_file text view decodes the name lossily. The 0xff
		// 0xfe pair becomes two U+FFFD at the Buffer.toString("utf8") boundary, so the
		// stored path is NOT the true bytes. Documented + locked (see file header).
		const files = await snapshots.listFiles("repo", "refs/heads/main")
		expect(files).toHaveLength(1)
		const stored = files[0]
		if (!stored) throw new Error("expected exactly one file in the view")
		expect(Buffer.from(stored.path, "utf8").equals(NAME)).toBe(false)
		// Each invalid byte (0xff, 0xfe) decoded to U+FFFD (code point 0xFFFD). Asserted
		// by code point so neither the replacement char nor its escape appears literally.
		const codes = [...stored.path].map((ch) => ch.codePointAt(0))
		expect(codes).toEqual([
			0x62, 0x61, 0x64, 0xfffd, 0xfffd, 0x6e, 0x61, 0x6d, 0x65, 0x2e, 0x74, 0x78, 0x74,
		])
	}, 120_000)
})

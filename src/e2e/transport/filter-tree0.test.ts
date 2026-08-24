/**
 * pggit advertises the `filter` fetch capability
 * (`fetch=filter`), so a client may send any filter spec it likes, `tree:0`
 * included. The contract is that such a clone COMPLETES.
 *
 * How it completes: pggit honors `blob:none` by omitting blobs and answers every
 * OTHER filter by serving the full closure. That over-serve is deliberate — the
 * protocol lets a server send more than a filter requests, and the client accepts
 * the superset with nothing left to lazily fetch, whereas a hard rejection aborts
 * the clone outright. So the assertion here is a SUPERSET relation against a
 * canonical `file://` control cloned with the identical flags: it holds under the current
 * (over-serve), it holds if `tree:0` is ever honored exactly, and it fails the
 * moment a filtered clone comes back SHORT of what canonical git serves.
 *
 * Advertising `filter` commits the server to completing this request; unsupported
 * filters are therefore over-served rather than rejected.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { allObjectOids, objectsByType } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("an advertised filter completes the clone (tree:0)", () => {
	let db: IsolatedDb
	let server: GitServer
	let src: string
	let bare: string
	let tipOid: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)

		const { writeFileSync } = await import("node:fs")
		src = mkdtempSync(join(tmpdir(), "pggit-tree0-source-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		for (const c of ["c1", "c2"]) {
			// real content so a tree:0 filter has trees + blobs to omit
			writeFileSync(join(src, `${c}.txt`), `${c} contents\n`)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", c], { cwd: src })
		}
		tipOid = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		const url = `http://127.0.0.1:${server.port}/repo`
		await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })

		// The canonical control: the same history behind a `file://` bare remote that
		// allows filters, so `tree:0` there is answered by real upload-pack.
		bare = mkdtempSync(join(tmpdir(), "pggit-tree0-bare-"))
		await spawnGit(["clone", "--bare", "-q", src, bare])
		await spawnGit(["config", "uploadpack.allowFilter", "true"], { cwd: bare })
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
		if (bare) rmSync(bare, { force: true, recursive: true })
	})

	it("a --filter=tree:0 clone completes and carries at least the canonical filtered set", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-tree0-destination-"))
		const control = mkdtempSync(join(tmpdir(), "pggit-tree0-control-"))
		try {
			const url = `http://127.0.0.1:${server.port}/repo`
			// spawnGit rejects on any non-zero exit, so each call IS an assertion: the
			// clone completed, the tip is really there, and the result is a sound repo
			// rather than a short pack that happened to unpack.
			await spawnGit(["clone", "--filter=tree:0", "--no-checkout", url, dest])
			await spawnGit(["cat-file", "-e", `${tipOid}^{commit}`], { cwd: dest })
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })

			await spawnGit([
				"clone",
				"--filter=tree:0",
				"--no-checkout",
				`file://${bare}`,
				control,
			])
			const canonical = await objectsByType(control)
			// The control is only an oracle if it really is filtered: under `tree:0`
			// canonical git ships commits and nothing else.
			expect(canonical.length).toBeGreaterThan(0)
			expect(canonical.every((o) => o.type === "commit")).toBe(true)

			// pggit's set must CONTAIN the canonical one (see the header: over-serving
			// is the deliberate answer to an unimplemented filter). A server that
			// silently served short — the failure this direction guards — fails here.
			const ours = new Set(await allObjectOids(dest))
			expect(canonical.filter((o) => !ours.has(o.oid)).map((o) => o.oid)).toEqual([])
		} finally {
			rmSync(dest, { force: true, recursive: true })
			rmSync(control, { force: true, recursive: true })
		}
	})
})

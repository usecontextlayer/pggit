import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("M2 — ref command modes: delete + non-fast-forward (real git)", () => {
	let db: IsolatedDb
	let server: GitServer
	let objects: ObjectStore
	let refs: RefStore
	let url: string

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
		url = `http://127.0.0.1:${server.port}`
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
	})

	it("deletes a ref via a delete-only push (no pack sent)", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-del-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })

			const repo = `${url}/repo-del`
			await spawnGit(["push", repo, "HEAD:refs/heads/topic"], { cwd: src })
			expect((await refs.listRefs("repo-del")).map((r) => r.name)).toContain(
				"refs/heads/topic",
			)

			// Colon refspec = delete; the client sends old→zero with no packfile.
			await spawnGit(["push", repo, ":refs/heads/topic"], { cwd: src })
			expect(await refs.listRefs("repo-del")).toEqual([])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	it("accepts a non-fast-forward force push (CAS matches; no ancestry check)", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-nonff-"))
		const back = mkdtempSync(join(tmpdir(), "pggit-nonff-back-"))
		const repo = `${url}/repo-nonff`
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "A\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "A"], { cwd: src })
			const a = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			writeFileSync(join(src, "a.txt"), "B\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "B"], { cwd: src })
			await spawnGit(["push", repo, "HEAD:refs/heads/main"], { cwd: src })

			// Rewrite history off A → C diverges from B (a non-fast-forward).
			await spawnGit(["reset", "--hard", a], { cwd: src })
			writeFileSync(join(src, "a.txt"), "C\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "C"], { cwd: src })
			const c = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			await spawnGit(["push", "--force", repo, "HEAD:refs/heads/main"], { cwd: src })
			expect(await refs.listRefs("repo-nonff")).toEqual([
				{ name: "refs/heads/main", oid: c },
			])

			await spawnGit(["init", "-q"], { cwd: back })
			await spawnGit(["-c", "protocol.version=2", "fetch", repo, "refs/heads/main"], {
				cwd: back,
			})
			await spawnGit(["fsck", "--full"], { cwd: back })
			await spawnGit(["checkout", "-q", "FETCH_HEAD"], { cwd: back })
			expect(readFileSync(join(back, "a.txt"), "utf8")).toBe("C\n")
		} finally {
			rmSync(src, { force: true, recursive: true })
			rmSync(back, { force: true, recursive: true })
		}
	})
})

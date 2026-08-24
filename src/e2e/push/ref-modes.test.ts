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
import { withTempDir } from "@/testing/temp-dir"

describe("M2 — ref command modes: deny-non-FF policy (real git)", () => {
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

	it("DENIES a delete-only push because refs only advance", async () => {
		await withTempDir("pggit-del-", async (src) => {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })

			const repo = `${url}/repo-del`
			await spawnGit(["push", repo, "HEAD:refs/heads/topic"], { cwd: src })
			const before = await refs.listRefs("repo-del")
			expect(before.map((r) => r.name)).toContain("refs/heads/topic")

			// Colon refspec = delete; the server ng's it with the policy reason
			// (git exits non-zero and relays the server text).
			await expect(
				spawnGit(["push", repo, ":refs/heads/topic"], { cwd: src }),
			).rejects.toThrow(/deletion denied/i)
			// The ref survives untouched.
			expect(await refs.listRefs("repo-del")).toEqual(before)
		})
	})

	it("DENIES a non-fast-forward force push; a genuine FF still lands", async () => {
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
			const b = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			await spawnGit(["push", repo, "HEAD:refs/heads/main"], { cwd: src })

			// Rewrite history off A → C diverges from B (a non-fast-forward).
			await spawnGit(["reset", "--hard", a], { cwd: src })
			writeFileSync(join(src, "a.txt"), "C\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "C"], { cwd: src })
			const c = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			// The force push is ng'd server-side with the policy reason, and the
			// ref keeps EXACTLY the history it had — B stays the tip, C never lands.
			await expect(
				spawnGit(["push", "--force", repo, "HEAD:refs/heads/main"], { cwd: src }),
			).rejects.toThrow(/non-fast-forward/i)
			expect(c).not.toBe(b)
			expect(await refs.listRefs("repo-nonff")).toEqual([
				{ name: "refs/heads/main", oid: b },
			])

			// A genuine fast-forward on top of the surviving tip still lands: fetch
			// the live tip, build on it, plain push succeeds.
			await spawnGit(["fetch", repo, "refs/heads/main"], { cwd: src })
			await spawnGit(["reset", "--hard", "FETCH_HEAD"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "D\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "D"], { cwd: src })
			const d = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			await spawnGit(["push", repo, "HEAD:refs/heads/main"], { cwd: src })
			expect(await refs.listRefs("repo-nonff")).toEqual([
				{ name: "refs/heads/main", oid: d },
			])

			await spawnGit(["init", "-q"], { cwd: back })
			await spawnGit(["-c", "protocol.version=2", "fetch", repo, "refs/heads/main"], {
				cwd: back,
			})
			await spawnGit(["fsck", "--full"], { cwd: back })
			await spawnGit(["checkout", "-q", "FETCH_HEAD"], { cwd: back })
			expect(readFileSync(join(back, "a.txt"), "utf8")).toBe("D\n")
		} finally {
			rmSync(src, { force: true, recursive: true })
			rmSync(back, { force: true, recursive: true })
		}
	})
})

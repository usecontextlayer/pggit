import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps, type GitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

// Whole-repo deletion over the real wire: push with canonical git, delete through
// the admin surface, and verify the three observable consequences — every row
// class is gone (the 0007 cascades), the name reads as a never-written (empty)
// repo, and a re-push under the same name lands in a FRESH repo through the SAME
// long-lived server (the shared-resolver invalidation; a stale cached id would
// fail the push on the git_object→repos FK).
describe("e2e — repo deletion (real git)", () => {
	let db: IsolatedDb
	let deps: GitDeps
	let server: GitServer

	const CONTENT = "workspace/acme/w1"
	const CHAT_HOME = "claude/acme/w1/user1"

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		deps = createGitDeps(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
	})

	function url(name: string): string {
		return `http://127.0.0.1:${server.port}/${name}`
	}

	/** Init a throwaway repo with one commit and push it to `name`. */
	async function pushFixture(name: string, marker: string): Promise<string> {
		const src = mkdtempSync(join(tmpdir(), "pggit-del-src-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "file.txt"), `${marker}\n`)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", marker], { cwd: src })
			await spawnGit(["push", url(name), "HEAD:refs/heads/main"], { cwd: src })
			return (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	}

	/** Rows remaining per child table for a repo surrogate id. */
	async function childRowCounts(repoId: string): Promise<Record<string, number>> {
		const counts: Record<string, number> = {}
		for (const table of ["git_object", "git_commit", "git_ref", "repo_file"]) {
			const [row] = await db.sql.unsafe<{ n: number }[]>(
				`select count(*)::int as n from ${table} where repo_id = $1`,
				[repoId],
			)
			if (row === undefined) throw new Error(`count query returned no row for ${table}`)
			counts[table] = row.n
		}
		return counts
	}

	it("deletes every row class, serves the name as empty, and accepts a fresh re-push", async () => {
		await pushFixture(CONTENT, "content-v1")
		await pushFixture(CHAT_HOME, "chat-v1")

		const [contentRow] = await db.sql.unsafe<{ id: string }[]>(
			"select id from repos where name = $1",
			[CONTENT],
		)
		if (contentRow === undefined) throw new Error(`repo row missing for ${CONTENT}`)
		const contentId = contentRow.id
		// The push populated all four row classes (snapshots included via createGitDeps).
		const before = await childRowCounts(contentId)
		for (const table of Object.keys(before)) {
			expect(before[table], `${table} should have rows before delete`).toBeGreaterThan(0)
		}

		expect(await deps.admin.deleteRepo(CONTENT)).toBe(true)

		// 1. The cascades took every dependent row with the repos row.
		expect(await childRowCounts(contentId)).toEqual({
			git_commit: 0,
			git_object: 0,
			git_ref: 0,
			repo_file: 0,
		})

		// 2. The name now reads as a never-written repo: ls-remote advertises nothing.
		const lsRemote = await spawnGit(["ls-remote", url(CONTENT)], {
			cwd: tmpdir(),
		})
		expect(lsRemote.stdout.trim()).toBe("")

		// 3. Same server, same name, fresh push: lands in a NEW repos row (the
		// shared resolver forgot the dead id — with a stale cache this push would
		// FK-fail writing objects).
		const newHead = await pushFixture(CONTENT, "content-v2")
		const back = mkdtempSync(join(tmpdir(), "pggit-del-back-"))
		try {
			await spawnGit(["init", "-q"], { cwd: back })
			await spawnGit(
				["-c", "protocol.version=2", "fetch", url(CONTENT), "refs/heads/main"],
				{ cwd: back },
			)
			expect(
				(await spawnGit(["rev-parse", "FETCH_HEAD"], { cwd: back })).stdout.trim(),
			).toBe(newHead)
		} finally {
			rmSync(back, { force: true, recursive: true })
		}
		const [reborn] = await db.sql.unsafe<{ id: string }[]>(
			"select id from repos where name = $1",
			[CONTENT],
		)
		if (reborn === undefined) throw new Error(`reborn repo row missing for ${CONTENT}`)
		expect(reborn.id).not.toBe(contentId)

		// The sibling repo was never touched: still cloneable with its content.
		const sibling = mkdtempSync(join(tmpdir(), "pggit-del-sib-"))
		try {
			await spawnGit(["init", "-q"], { cwd: sibling })
			await spawnGit(
				["-c", "protocol.version=2", "fetch", url(CHAT_HOME), "refs/heads/main"],
				{ cwd: sibling },
			)
			await spawnGit(["fsck", "--full"], { cwd: sibling })
		} finally {
			rmSync(sibling, { force: true, recursive: true })
		}
	}, 120_000)

	it("enumerates by prefix for the caller-owned grammar", async () => {
		// State from the previous test: CONTENT (reborn) + CHAT_HOME exist.
		expect(await deps.admin.listRepos("claude/acme/w1/")).toEqual([CHAT_HOME])
		expect(await deps.admin.listRepos("workspace/")).toEqual([CONTENT])
	})
})

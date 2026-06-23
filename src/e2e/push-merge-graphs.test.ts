/**
 * §8.4 — multi-merge-base graph shapes (testing #13). The command generator's
 * merges are binary and shallow, so the deepest correctness net mostly walks
 * near-linear graphs. Octopus (3-parent) and criss-cross (two merge bases) DAGs
 * are exactly where ancestry walks (graphWalk closure, readyToGiveUp's cut) and
 * incremental delta computation are most error-prone — git has dedicated t-files
 * for them. These push such shapes through the full serve path and clone back
 * differentially.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { refsOf } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

async function commitFile(
	dir: string,
	path: string,
	body: string,
	msg: string,
): Promise<void> {
	writeFileSync(join(dir, path), body)
	await spawnGit(["add", "."], { cwd: dir })
	await spawnGit(["commit", "-q", "-m", msg], { cwd: dir })
}

/**
 * Objects REACHABLE from all refs (not `--batch-all-objects`): git's octopus
 * merge strategy writes an unreachable intermediate tree into the local object
 * DB, which a clone correctly omits — so the serve invariant is reachable-set
 * equality, not raw object-DB equality.
 */
async function reachableOids(dir: string): Promise<string[]> {
	const out = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
	const oids = out.stdout
		.trim()
		.split("\n")
		.map((l) => l.split(" ")[0])
		.filter((o): o is string => Boolean(o))
	return [...new Set(oids)].sort()
}

describe("merge graph shapes — octopus + criss-cross differential", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let url = ""

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		server = await serveOnPort(
			createGitApp({ objects: createObjectStore(db.sql), refs: createRefStore(db.sql) }),
			0,
		)
		url = `http://127.0.0.1:${server.port}`
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
	})

	/** Push every branch, clone back --no-checkout, fsck, and assert exact parity. */
	async function pushAndVerify(src: string, repoId: string): Promise<void> {
		const repo = `${url}/${repoId}`
		await spawnGit(["push", repo, "refs/heads/*:refs/heads/*"], { cwd: src })
		const back = mkdtempSync(join(tmpdir(), `pggit-merge-back-${repoId}-`))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--no-checkout",
				"--quiet",
				repo,
				back,
			])
			await spawnGit(["fsck", "--full"], { cwd: back })
			expect(await reachableOids(back)).toEqual(await reachableOids(src))
			const stored = (await createRefStore(db.sql).listRefs(repoId)).sort((a, b) =>
				a.name.localeCompare(b.name),
			)
			expect(stored).toEqual(await refsOf(src))
		} finally {
			rmSync(back, { force: true, recursive: true })
		}
	}

	it("serves an octopus (3-parent) merge", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-octopus-"))
		try {
			await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
			await commitFile(src, "base.txt", "base\n", "base")
			await spawnGit(["branch", "b1"], { cwd: src })
			await spawnGit(["branch", "b2"], { cwd: src })
			await commitFile(src, "main.txt", "main\n", "on main") // main diverges from base
			await spawnGit(["checkout", "-q", "b1"], { cwd: src })
			await commitFile(src, "b1.txt", "b1\n", "on b1")
			await spawnGit(["checkout", "-q", "b2"], { cwd: src })
			await commitFile(src, "b2.txt", "b2\n", "on b2")
			await spawnGit(["checkout", "-q", "main"], { cwd: src })
			await spawnGit(["merge", "--no-edit", "b1", "b2"], { cwd: src }) // octopus

			const parents = (
				await spawnGit(["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: src })
			).stdout
				.trim()
				.split(" ")
			expect(parents.length).toBe(4) // the commit itself + 3 parents

			await pushAndVerify(src, "octopus")
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	it("serves a criss-cross (two-merge-base) history", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-crisscross-"))
		try {
			await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
			await commitFile(src, "base.txt", "base\n", "base")
			await spawnGit(["checkout", "-q", "-b", "x"], { cwd: src })
			await commitFile(src, "x.txt", "x\n", "cx")
			await spawnGit(["checkout", "-q", "-b", "y", "main"], { cwd: src })
			await commitFile(src, "y.txt", "y\n", "cy")
			// Mutual merges: x⇐y and y⇐x ⇒ two distinct merge bases (cx, cy).
			await spawnGit(["checkout", "-q", "x"], { cwd: src })
			await spawnGit(["merge", "--no-edit", "y"], { cwd: src })
			await spawnGit(["checkout", "-q", "y"], { cwd: src })
			await spawnGit(["merge", "--no-edit", "x"], { cwd: src })

			await pushAndVerify(src, "crisscross")
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})
})

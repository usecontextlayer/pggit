/**
 * §8.4 — multi-merge-base graph shapes (testing #13). The command generator's
 * merges are binary and shallow, so the deepest correctness net mostly walks
 * near-linear graphs. Octopus (3-parent) and criss-cross (two merge bases) DAGs
 * are exactly where reachability walks (closure, readyToGiveUp's cut) and
 * incremental delta computation are most error-prone — git has dedicated t-files
 * for them. These push such shapes through the full serve path and clone back
 * differentially.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { gitReachableOids, refsOf } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

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

describe("merge graph shapes — octopus + criss-cross differential", () => {
	let db: IsolatedDb
	let server: GitServer
	let url = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(
			createGitApp({ objects: createObjectStore(db.sql), refs: createRefStore(db.sql) }),
			0,
		)
		url = `http://127.0.0.1:${server.port}`
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
	})

	/** Push every branch, clone back --no-checkout, fsck, and assert exact parity. */
	async function pushAndVerify(src: string, repoId: string): Promise<void> {
		const repo = `${url}/${repoId}`
		await spawnGit(["push", repo, "refs/heads/*:refs/heads/*"], { cwd: src })
		await withTempDir(`pggit-merge-back-${repoId}-`, async (back) => {
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
			// Git's merge strategy leaves an unreachable intermediate tree in the source,
			// so parity is over the ref-reachable closure, not the raw object database.
			expect(await gitReachableOids(back)).toEqual(await gitReachableOids(src))
			const stored = (await createRefStore(db.sql).listRefs(repoId)).sort((a, b) =>
				a.name.localeCompare(b.name),
			)
			expect(stored).toEqual(await refsOf(src))
		})
	}

	it("serves an octopus (3-parent) merge", async () => {
		await withTempDir("pggit-octopus-", async (src) => {
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
		})
	})

	it("serves a criss-cross (two-merge-base) history", async () => {
		await withTempDir("pggit-crisscross-", async (src) => {
			await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
			await commitFile(src, "base.txt", "base\n", "base")
			await spawnGit(["checkout", "-q", "-b", "x"], { cwd: src })
			await commitFile(src, "x.txt", "x\n", "cx")
			const cx = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			await spawnGit(["checkout", "-q", "-b", "y", "main"], { cwd: src })
			await commitFile(src, "y.txt", "y\n", "cy")
			// MUTUAL merges of the two ORIGINAL tips: x merges cy, y merges the OLD
			// cx (by oid — merging the branch after x's merge would fast-forward
			// and collapse the shape to one base). --no-ff pins the second merge.
			await spawnGit(["checkout", "-q", "x"], { cwd: src })
			await spawnGit(["merge", "--no-edit", "y"], { cwd: src })
			await spawnGit(["checkout", "-q", "y"], { cwd: src })
			await spawnGit(["merge", "--no-ff", "--no-edit", cx], { cwd: src })
			// The fixture self-verifies: a criss-cross has TWO merge bases.
			const bases = (
				await spawnGit(["merge-base", "--all", "x", "y"], { cwd: src })
			).stdout
				.trim()
				.split("\n")
			expect(bases.length).toBe(2)

			await pushAndVerify(src, "crisscross")
		})
	})
})

/**
 * §8.4 generative kernel differential — FULL CLONE (M0).
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`).
 * For each generated repo (§6 generator), seed it into Postgres, serve it, drive a
 * real `git clone -c protocol.version=2`, and assert the clone is INDISTINGUISHABLE
 * from the source: same object set, `fsck` clean, same HEAD.
 *
 * The fast-check seed is pinned for a deterministic gate (broad seed exploration
 * happens during development); a failure here is a real kernel regression to fix.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, inject, it } from "vitest"
import { buildRepoFromCommands, repoCommands } from "@/generative/commands"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { allObjectOids, seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("§8.4 generative — full clone (M0) differential", () => {
	it("a real clone of any generated repo recovers git's exact object set, fsck-clean, same HEAD", async () => {
		const baseUrl = inject("pgBaseUrl")

		await fc.assert(
			fc.asyncProperty(repoCommands({ maxCommands: 25 }), async (commands) => {
				const { dir: src, model } = await buildRepoFromCommands(commands)
				try {
					// Empty-repo clone (unborn HEAD) has its own dedicated M0 test; the
					// generative differential targets repos with real history.
					fc.pre(model.commitCount > 0)

					const isolated = await createIsolatedSchema(baseUrl)
					let server: GitServer | undefined
					let dest: string | undefined
					try {
						const objects = createObjectStore(isolated.db)
						const refs = createRefStore(isolated.db)
						await seedRepoIntoStore("repo", src, { objects, refs })
						server = await serveOnPort(createGitApp({ objects, refs }), 0)

						dest = mkdtempSync(join(tmpdir(), "pggit-clone-"))
						await spawnGit([
							"clone",
							"-c",
							"protocol.version=2",
							"--quiet",
							`http://127.0.0.1:${server.port}/repo`,
							dest,
						])

						await spawnGit(["fsck", "--full"], { cwd: dest }) // throws if corrupt
						expect(await allObjectOids(dest)).toEqual(await allObjectOids(src))

						const srcHead = (
							await spawnGit(["rev-parse", "HEAD"], { cwd: src })
						).stdout.trim()
						const destHead = (
							await spawnGit(["rev-parse", "HEAD"], { cwd: dest })
						).stdout.trim()
						expect(destHead).toBe(srcHead)
					} finally {
						await server?.close()
						await isolated.drop()
						if (dest) rmSync(dest, { force: true, recursive: true })
					}
				} finally {
					rmSync(src, { force: true, recursive: true })
				}
			}),
			{ numRuns: 15, seed: 424_242 },
		)
	})
})

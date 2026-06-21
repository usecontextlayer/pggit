/**
 * §8.4 generative kernel differential — BLOBLESS PARTIAL CLONE (M1).
 *
 * SPEC-SUITE (`*.spec.test.ts`, off the default gate — `pnpm run test.spec`).
 * For each generated repo: `clone --filter=blob:none --no-checkout` must transfer
 * EXACTLY the non-blob closure (commits + trees + tags, no blobs); then a real
 * `checkout` must lazily fault HEAD's blobs back from us (promisor) — proving
 * `allowAnySHA1InWant` serves bare blob wants. A failure is a Phase-3 item.
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

/** Non-blob object OIDs (commits + trees + tags) of a repo, sorted. */
async function nonBlobOids(dir: string): Promise<string[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	return list.stdout
		.trim()
		.split("\n")
		.map((line) => line.split(" "))
		.filter(([oid, type]) => oid && type && type !== "blob")
		.map(([oid]) => oid as string)
		.sort()
}

describe("§8.4 generative — blobless partial clone (M1) differential", () => {
	it("transfers exactly the non-blob closure, then lazily faults HEAD's blobs", async () => {
		const baseUrl = inject("pgBaseUrl")

		await fc.assert(
			fc.asyncProperty(repoCommands({ maxCommands: 25 }), async (commands) => {
				const { dir: src, model } = await buildRepoFromCommands(commands)
				try {
					fc.pre(model.commitCount > 0)

					const isolated = await createIsolatedSchema(baseUrl)
					let server: GitServer | undefined
					let dest: string | undefined
					try {
						const objects = createObjectStore(isolated.db)
						const refs = createRefStore(isolated.db)
						await seedRepoIntoStore("repo", src, { objects, refs })
						server = await serveOnPort(createGitApp({ objects, refs }), 0)

						dest = mkdtempSync(join(tmpdir(), "pggit-blobless-"))
						await spawnGit([
							"clone",
							"-c",
							"protocol.version=2",
							"--filter=blob:none",
							"--no-checkout",
							"--quiet",
							`http://127.0.0.1:${server.port}/repo`,
							dest,
						])
						await spawnGit(["fsck"], { cwd: dest }) // promisor-aware

						// The blobless pack carried exactly the commits + trees + tags.
						expect(await allObjectOids(dest)).toEqual(await nonBlobOids(src))

						// Checking out HEAD's branch must lazily fault its blobs back from
						// us — `checkout` throws if any needed blob can't be served.
						await spawnGit(["checkout", model.currentBranch], { cwd: dest })
						await spawnGit(["fsck"], { cwd: dest })
					} finally {
						await server?.close()
						await isolated.drop()
						if (dest) rmSync(dest, { force: true, recursive: true })
					}
				} finally {
					rmSync(src, { force: true, recursive: true })
				}
			}),
			{ numRuns: 12 },
		)
	})
})

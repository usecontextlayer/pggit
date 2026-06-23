/**
 * §8.4 generative kernel differential — PUSH to an empty repo (M2). The REVERSE of
 * the clone/fetch properties: the SERVER starts empty (no seed) and the generated
 * repo is the CLIENT. A single wildcard-refspec push of all branches + all tags
 * must create every ref and ingest every reachable object — exercising multi-ref
 * receive-pack + pack ingest over random history (merges, lightweight + annotated
 * tags, binary blobs). (`--all --tags` is rejected by git's CLI, so the wildcard
 * refspecs push both in one request.)
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * A failure is a real ingest bug, not a test to weaken.
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
import { allObjectOids, refsOf } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("§8.4 generative — push to an empty repo (M2) differential", () => {
	it("ingests every pushed branch, tag, and object from a random client repo", async () => {
		const baseUrl = inject("pgBaseUrl")

		await fc.assert(
			fc.asyncProperty(repoCommands({ maxCommands: 25 }), async (commands) => {
				const { dir: client, model } = await buildRepoFromCommands(commands)
				try {
					fc.pre(model.commitCount > 0) // need at least one ref to push

					const isolated = await createIsolatedSchema(baseUrl)
					let server: GitServer | undefined
					let back: string | undefined
					try {
						const objects = createObjectStore(isolated.sql)
						const refs = createRefStore(isolated.sql)
						// Empty server: the push CREATES the refs — do NOT seed.
						server = await serveOnPort(createGitApp({ objects, refs }), 0)
						const url = `http://127.0.0.1:${server.port}/repo`

						await spawnGit(
							["push", url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
							{ cwd: client },
						)

						// 1. Every object reachable on the client is now in the store.
						for (const oid of await allObjectOids(client)) {
							expect(await objects.hasObject("repo", oid)).toBe(true)
						}

						// 2. The stored refs are EXACTLY the client's branches + tags. listRefs
						//    order is unspecified, so sort both sides (refsOf already sorts).
						//    Compare name+oid only — `peeled` is derived metadata, not ref state.
						const stored = (await refs.listRefs("repo"))
							.map((r) => ({ name: r.name, oid: r.oid }))
							.sort((a, b) => a.name.localeCompare(b.name))
						expect(stored).toEqual(await refsOf(client))

						// 3. Differential: a fresh git clones the server back to a byte-identical
						//    object set, fsck-clean. --no-checkout: the server has no HEAD symref
						//    after a bare push, and we only care about the object closure.
						back = mkdtempSync(join(tmpdir(), "pggit-push-back-"))
						await spawnGit([
							"clone",
							"-c",
							"protocol.version=2",
							"--no-checkout",
							"--quiet",
							url,
							back,
						])
						await spawnGit(["fsck", "--full"], { cwd: back })
						expect(await allObjectOids(back)).toEqual(await allObjectOids(client))
					} finally {
						await server?.close()
						await isolated.drop()
						if (back) rmSync(back, { force: true, recursive: true })
					}
				} finally {
					rmSync(client, { force: true, recursive: true })
				}
			}),
			{ numRuns: 10, seed: 424_242 },
		)
	})
})

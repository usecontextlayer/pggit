/**
 * §8.4 generative kernel differential — INCREMENTAL PUSH (M2). Push a generated
 * client repo to an empty server, then DIVERGE the client (replay more commands)
 * and push again. The second push advances existing branches by compare-and-swap
 * and sends a THIN pack — deltas against base objects that live only in the store,
 * which the ingest path must resolve. After both pushes the server must hold
 * exactly the client's refs and full object closure, fsck-clean on clone-back.
 *
 * SPEC-SUITE (`*.spec.test.ts`, off the default gate — `pnpm run test.spec`). A
 * failure is a Phase-3 CAS / thin-pack-ingest bug.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, inject, it } from "vitest"
import {
	buildRepoFromCommands,
	extendRepoFromCommands,
	repoCommands,
} from "@/generative/commands"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import { allObjectOids, refsOf } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REFSPEC = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]

describe("§8.4 generative — incremental push (M2) differential", () => {
	it("CAS-updates refs and ingests a thin pack on a second push", async () => {
		const baseUrl = inject("pgBaseUrl")

		await fc.assert(
			fc.asyncProperty(
				fc.tuple(repoCommands({ maxCommands: 20 }), repoCommands({ maxCommands: 15 })),
				async ([baseCommands, divergeCommands]) => {
					const { dir: client, model } = await buildRepoFromCommands(baseCommands)
					try {
						fc.pre(model.commitCount > 0)
						const baseCommitCount = model.commitCount

						const isolated = await createIsolatedSchema(baseUrl)
						let server: GitServer | undefined
						let back: string | undefined
						try {
							const objects = createObjectStore(isolated.db)
							const refs = createRefStore(isolated.db)
							// Empty server: the first push creates the refs — do NOT seed.
							server = await serveOnPort(createGitApp({ objects, refs }), 0)
							const url = `http://127.0.0.1:${server.port}/repo`

							await spawnGit(["push", url, ...REFSPEC], { cwd: client })

							// Diverge the client, then push again: existing branches advance
							// (compare-and-swap fast-forward) and the pack is THIN — its delta
							// bases live only in the store from the first push.
							await extendRepoFromCommands(model, divergeCommands)
							fc.pre(model.commitCount > baseCommitCount) // a real second push
							await spawnGit(["push", url, ...REFSPEC], { cwd: client })

							// 1. Stored refs are EXACTLY the client's branches + tags.
							const stored = (await refs.listRefs("repo")).sort((a, b) =>
								a.name.localeCompare(b.name),
							)
							expect(stored).toEqual(await refsOf(client))

							// 2. Every object reachable on the client is in the store.
							for (const oid of await allObjectOids(client)) {
								expect(await objects.hasObject("repo", oid)).toBe(true)
							}

							// 3. Differential: a fresh git clones the server back to a byte-identical,
							//    fsck-clean object set — proving the thin pack ingested correctly.
							back = mkdtempSync(join(tmpdir(), "pggit-incpush-back-"))
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
				},
			),
			{ numRuns: 8 },
		)
	})
})

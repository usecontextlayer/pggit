/**
 * §8.4 generative kernel differential — INCREMENTAL FETCH (M1). Clone a generated
 * repo, then DIVERGE the server (replay more commands onto the source + re-seed),
 * then `git fetch`. The server must transfer EXACTLY the objects the client lacks —
 * the have-closure subtracted, nothing more, nothing less. A merged `fsck`+object
 * comparison would hide both over-sends (wasteful) and under-sends (corruption), so
 * we read the precise set that crossed the wire from the received pack itself
 * (`verify-pack -v`, with `fetch.unpackLimit=1` to keep it as a pack).
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * A failure is a real negotiation bug.
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
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	allObjectOids,
	packFiles,
	packObjectOids,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("§8.4 generative — incremental fetch (M1) differential", () => {
	it("transfers exactly the post-clone delta (have-closure subtracted)", async () => {
		const baseUrl = inject("pgBaseUrl")

		await fc.assert(
			fc.asyncProperty(
				fc.tuple(repoCommands({ maxCommands: 20 }), repoCommands({ maxCommands: 15 })),
				async ([baseCommands, divergeCommands]) => {
					const { dir: src, model } = await buildRepoFromCommands(baseCommands)
					try {
						fc.pre(model.commitCount > 0)

						const isolated = await createIsolatedSchema(baseUrl)
						let server: GitServer | undefined
						let dest: string | undefined
						try {
							const objects = createObjectStore(isolated.sql)
							const refs = createRefStore(isolated.sql)
							await seedRepoIntoStore("repo", src, { objects, refs })
							server = await serveOnPort(createGitApp({ objects, refs }), 0)
							const url = `http://127.0.0.1:${server.port}/repo`

							dest = mkdtempSync(join(tmpdir(), "pggit-incfetch-"))
							await spawnGit(["clone", "-c", "protocol.version=2", "--quiet", url, dest])
							const haveAfterClone = await allObjectOids(dest)
							const packsAfterClone = new Set(packFiles(dest))

							// Server advances: replay more commands onto src. EXCLUDE new tags —
							// pggit does not advertise include-tag, so git would auto-follow a new
							// annotated tag in a SEPARATE request/pack, splitting the transfer. Tags
							// are covered by the clone + push specs.
							await extendRepoFromCommands(
								model,
								divergeCommands.filter((c) => c.kind !== "tag"),
							)

							// The delta = everything reachable now that the clone did not already have.
							const delta = (await allObjectOids(src)).filter(
								(o) => !haveAfterClone.includes(o),
							)
							fc.pre(delta.length > 0)
							await seedRepoIntoStore("repo", src, { objects, refs })

							// Keep the received objects as a pack (unpackLimit=1) so we can read
							// exactly what crossed the wire.
							await spawnGit(
								[
									"-c",
									"protocol.version=2",
									"-c",
									"fetch.unpackLimit=1",
									"fetch",
									"origin",
								],
								{ cwd: dest },
							)

							const newPacks = packFiles(dest).filter((p) => !packsAfterClone.has(p))
							expect(newPacks.length).toBe(1)
							expect(await packObjectOids(dest, newPacks[0] as string)).toEqual(
								[...delta].sort(),
							)
							await spawnGit(["fsck", "--full"], { cwd: dest })
						} finally {
							await server?.close()
							await isolated.drop()
							if (dest) rmSync(dest, { force: true, recursive: true })
						}
					} finally {
						rmSync(src, { force: true, recursive: true })
					}
				},
			),
			{ numRuns: 8, seed: 424_242 },
		)
	})
})

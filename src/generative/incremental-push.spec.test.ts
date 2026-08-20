/**
 * §8.4 generative kernel differential — INCREMENTAL PUSH (M2). Push a generated
 * client repo to an empty server, then DIVERGE the client (replay more commands)
 * and push again. After both pushes the server must hold exactly the client's refs
 * and full object closure, fsck-clean on clone-back, and at least one ref that
 * ALREADY EXISTED must have moved — the compare-and-swap fast-forward path, which a
 * server that ignored `oldOid` and blind-set every ref would also have to satisfy on
 * the final state alone.
 *
 * WHAT THIS DOES NOT PIN: pack THINNESS. git decides on its own whether to delta the
 * second push against bases it knows the server has, and the client-side observables
 * here (refs, clone-back object set) are identical either way. Thin-pack INGEST is
 * pinned where it is observable — `src/store/thin-pack.test.ts` (a hand-built pack
 * whose REF_DELTA base lives only in the store) and `src/e2e/thin-pack-serve.test.ts`.
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * A failure is a real CAS / ingest bug.
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
import { allObjectOids, refsOf } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REFSPEC = ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]

describe("§8.4 generative — incremental push (M2) differential", () => {
	it("CAS-advances an existing ref and ingests the second push's full closure", async () => {
		const baseUrl = inject("pgBaseUrl")

		await fc.assert(
			fc.asyncProperty(
				fc.tuple(repoCommands(20), repoCommands(15)),
				async ([baseCommands, divergeCommands]) => {
					const { dir: client, model } = await buildRepoFromCommands(baseCommands)
					try {
						fc.pre(model.commitCount > 0)
						const baseCommitCount = model.commitCount

						const isolated = await createIsolatedSchema(baseUrl)
						let server: GitServer | undefined
						let back: string | undefined
						try {
							const objects = createObjectStore(isolated.sql)
							const refs = createRefStore(isolated.sql)
							// Empty server: the first push creates the refs — do NOT seed.
							server = await serveOnPort(createGitApp({ objects, refs }), 0)
							const url = `http://127.0.0.1:${server.port}/repo`

							await spawnGit(["push", url, ...REFSPEC], { cwd: client })
							// The server's ref state BEFORE the divergence — the baseline that makes
							// "a ref advanced" distinguishable from "a ref was created".
							const afterFirst = await refs.listRefs("repo")

							// Diverge the client, then push again: existing branches advance under
							// compare-and-swap, and the second pack's delta bases live only in the
							// store from the first push.
							await extendRepoFromCommands(model, divergeCommands)
							fc.pre(model.commitCount > baseCommitCount) // a real second push
							await spawnGit(["push", url, ...REFSPEC], { cwd: client })

							// 1. Stored refs are EXACTLY the client's branches + tags (name+oid;
							//    `peeled` is derived metadata, not ref state).
							const stored = (await refs.listRefs("repo"))
								.map((r) => ({ name: r.name, oid: r.oid }))
								.sort((a, b) => a.name.localeCompare(b.name))
							expect(stored).toEqual(await refsOf(client))

							// 2. The CAS half: a ref that existed after the FIRST push now names a
							//    different oid. Without this the whole property is satisfied by a
							//    server that only ever creates refs — the final-state comparison
							//    above cannot tell an update from a create.
							expect(
								stored.filter((r) =>
									afterFirst.some((p) => p.name === r.name && p.oid !== r.oid),
								),
								"no existing ref advanced — the fast-forward CAS path is unexercised",
							).not.toEqual([])

							// 3. Differential: a fresh git clones the server back to a byte-identical,
							//    fsck-clean object set. This subsumes a per-object `hasObject` sweep
							//    of the store — an object the ingest dropped cannot come back out of
							//    the pack — and additionally catches over-serving.
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
			{ numRuns: 8, seed: 424_242 },
		)
	})
})

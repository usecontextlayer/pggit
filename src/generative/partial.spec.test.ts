/**
 * §8.4 generative kernel differential — BLOBLESS PARTIAL CLONE (M1).
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * For each generated repo: `clone --filter=blob:none --no-checkout` must transfer
 * EXACTLY the non-blob closure (commits + trees + tags, no blobs); then a real
 * `checkout` must lazily fault HEAD's blobs back from us (promisor) — proving
 * `allowAnySHA1InWant` serves bare blob wants. A failure is a kernel regression.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	allObjectOids,
	objectsByType,
	parseLsTree,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { buildRepoFromCommands, repoCommands } from "@/testing/repo-commands"
import { spawnGit } from "@/testing/spawn-git"

/** The distinct blob OIDs a branch's tree needs on disk — the git-derived oracle for
 * what a promisor checkout of that branch must fault back. `ls-tree -r` lists leaf
 * entries only, and two paths with identical content share one blob, hence the Set. */
async function blobsOf(dir: string, branch: string): Promise<string[]> {
	const out = await spawnGit(["ls-tree", "-r", branch], { cwd: dir })
	return [...new Set(parseLsTree(out.stdout).map((e) => e.oid))]
}

describe("§8.4 generative — blobless partial clone (M1) differential", () => {
	it("transfers exactly the non-blob closure, then lazily faults HEAD's blobs", async () => {
		const baseUrl = inject("pgBaseUrl")
		// How many candidates actually had blobs to fault. The generator can produce a
		// branch whose tree is empty (delete every file, then commit), and for those the
		// assertion below correctly demands that NOTHING arrived — so without this floor
		// a corpus of only-empty trees would prove nothing about serving blob wants.
		let candidatesWithBlobs = 0

		await fc.assert(
			fc.asyncProperty(repoCommands(25), async (commands) => {
				const { dir: src, model } = await buildRepoFromCommands(commands)
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
						expect(await allObjectOids(dest)).toEqual(
							(await objectsByType(src))
								.filter((o) => o.type !== "blob")
								.map((o) => o.oid)
								.sort(),
						)

						// Checking out HEAD's branch must lazily fault its blobs back from us —
						// and it must fault EXACTLY that branch's blob set. `checkout` exiting 0
						// proves nothing on its own: it succeeds having faulted zero blobs when
						// the branch's tree carries none. So snapshot the object set, check out,
						// and require the growth to be precisely the git-derived blob set.
						const beforeFault = await allObjectOids(dest)
						await spawnGit(["checkout", model.currentBranch], { cwd: dest })
						await spawnGit(["fsck"], { cwd: dest })

						const wanted = await blobsOf(src, model.currentBranch)
						if (wanted.length > 0) candidatesWithBlobs++
						expect(await allObjectOids(dest)).toEqual([...beforeFault, ...wanted].sort())
					} finally {
						await server?.close()
						await isolated.drop()
						if (dest) rmSync(dest, { force: true, recursive: true })
					}
				} finally {
					rmSync(src, { force: true, recursive: true })
				}
			}),
			{ numRuns: 12, seed: 424_242 },
		)
		console.log(`[partial corpus] candidates-with-blobs=${candidatesWithBlobs}`)
		expect(
			candidatesWithBlobs,
			"no candidate needed a blob faulted — the promisor round-trip is unexercised",
		).toBeGreaterThan(0)
	})
})

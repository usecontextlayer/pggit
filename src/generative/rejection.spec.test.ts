/**
 * §8.4 generative — REJECTION + edge-shape coverage. The other generative
 * properties only fuzz the happy path; these fuzz the error paths the kernel is
 * most likely to get wrong:
 *   1. Connectivity rejection across random graphs — a pack that carries the tip
 *      commit but NOT its tree/parents must be rejected `ng missing necessary
 *      objects` with the ref unset (generalizes the hand-built m2-connectivity).
 *   2. Empty-tree round-trip — deleting every file yields the canonical empty
 *      tree (4b825d…); it must serialize + clone back like any other object.
 * (Stale-CAS rejection under real divergence is covered by m2-concurrent-push.)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, inject, it } from "vitest"
import { buildRepoFromCommands, repoCommands } from "@/generative/commands"
import { createGitApp } from "@/index"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { handleReceivePack, type ReceiveBackend } from "@/protocol/receive-pack"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { allObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { EMPTY_TREE, pktLineUnpack } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)

/** A receive-pack body: command lines, a flush, then the raw pack. */
function receiveBody(commandLine: string, pack: Buffer): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from(commandLine)),
		encodePkt({ type: "flush" }),
		pack,
	])
}

describe("§8.4 generative — connectivity rejection over random graphs", () => {
	it("rejects a pack missing the tip's reachable objects, leaving the ref unset", async () => {
		const baseUrl = inject("pgBaseUrl")
		await fc.assert(
			fc.asyncProperty(repoCommands({ maxCommands: 20 }), async (commands) => {
				const { dir, model } = await buildRepoFromCommands(commands)
				try {
					fc.pre(model.commitCount > 0)
					const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
					// The tip commit alone — its tree (and any parents) are NOT in this pack.
					const commit = (await spawnGit(["cat-file", "commit", tip], { cwd: dir }))
						.stdoutBytes

					const isolated = await createIsolatedSchema(baseUrl)
					try {
						const objects = createObjectStore(isolated.sql)
						const refs = createRefStore(isolated.sql)
						const backend: ReceiveBackend = {
							applyRefUpdates: (cmds, atomic) => refs.applyRefUpdates("r", cmds, atomic),
							ingest: async (pack) => {
								await objects.ingestPack("r", pack)
							},
							isConnected: (oid) => objects.isConnected("r", oid),
						}
						const pack = writePack([{ content: commit, type: "commit" }])
						const body = receiveBody(
							`${ZERO} ${tip} refs/heads/probe\0report-status`,
							pack,
						)
						const report = pktLineUnpack(await handleReceivePack(body, backend))

						expect(report).toContain("ng refs/heads/probe missing necessary objects")
						expect(await refs.listRefs("r")).toEqual([]) // ref never applied
					} finally {
						await isolated.drop()
					}
				} finally {
					rmSync(dir, { force: true, recursive: true })
				}
			}),
			{ numRuns: 25, seed: 424_242 },
		)
	})
})

describe("§8.4 generative — empty-tree round-trip", () => {
	it("serves the canonical empty tree after every file is deleted", async () => {
		const baseUrl = inject("pgBaseUrl")
		const src = mkdtempSync(join(tmpdir(), "pggit-emptytree-src-"))
		const isolated = await createIsolatedSchema(baseUrl)
		let server: GitServer | undefined
		let back: string | undefined
		try {
			await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "content\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "add"], { cwd: src })
			await spawnGit(["rm", "-q", "a.txt"], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "delete all"], { cwd: src })
			// The HEAD commit's tree is now the canonical empty tree.
			const tree = (
				await spawnGit(["rev-parse", "HEAD^{tree}"], { cwd: src })
			).stdout.trim()
			expect(tree).toBe(EMPTY_TREE)

			const objects = createObjectStore(isolated.sql)
			const refs = createRefStore(isolated.sql)
			server = await serveOnPort(createGitApp({ objects, refs }), 0)
			const url = `http://127.0.0.1:${server.port}/repo`
			await spawnGit(["push", url, "refs/heads/*:refs/heads/*"], { cwd: src })

			back = mkdtempSync(join(tmpdir(), "pggit-emptytree-back-"))
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
			expect(await allObjectOids(back)).toContain(EMPTY_TREE)
		} finally {
			await server?.close()
			await isolated.drop()
			rmSync(src, { force: true, recursive: true })
			if (back) rmSync(back, { force: true, recursive: true })
		}
	})
})

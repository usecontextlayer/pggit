/**
 * WIRE — two shapes no other test reaches.
 * (Converted from `breakage/wire--large-trees-and-negotiation.ts`.)
 *
 *  A. TREES LARGER THAN 64 KiB. The delta encoder splits a COPY run at 0xFFFF and
 *     must advance the copy OFFSET per split (the classic wrong-content bug is
 *     advancing the length only). A tree only crosses that threshold at ~700+
 *     entries, which is exactly the production shape this work exists for. Judged
 *     by canonical git: fsck --strict on the clone and a byte-for-byte comparison
 *     of every object against the source.
 *
 *  B. A GENUINELY MULTI-ROUND NEGOTIATION. A client with a lot of history the
 *     server has never seen sends have-batch after have-batch that the server can
 *     ACK nothing for, so upload-pack answers `acknowledgments`-only rounds before
 *     finally reaching `ready` and shipping the pack in the SAME response
 *     (`encodeReadyWithPack`) — the path where the served set is smallest and the
 *     delta-eligibility rule bites hardest. Run under all three negotiation
 *     algorithms, differentially against a plain bare git remote.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo, RUNS_DIR } from "@/testing/append-only-repo"
import { parseRevListObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/bigtrees"
/** ~1200 uuid-named subdirs ⇒ the runs tree passes 100 KiB, so COPY runs split. */
const RUNS = 1200
const DIVERGENT = 250
const ALGORITHMS = ["default", "skipping", "noop"] as const

type NegotiationRound = {
	algo: string
	pggitError: string | null
	gitError: string | null
	pggitClosure: string
	gitClosure: string
}

/** `<object count>:<sha256 over every local object's raw bytes, in oid order>`. */
async function digest(dir: string): Promise<string> {
	const list = await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], {
		cwd: dir,
	})
	const oids = list.stdout
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split(" ")[0] as string)
		.sort()
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
	})
	return `${oids.length}:${createHash("sha256").update(res.stdoutBytes).digest("hex")}`
}

/** The fetched branch's closure only — what actually came from the remote. */
async function closureDigest(dir: string, rev: string): Promise<string> {
	const objects = [
		...new Set(
			parseRevListObjectOids(
				(await spawnGit(["rev-list", "--objects", rev], { cwd: dir })).stdout,
			),
		),
	].sort()
	const bytes = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${objects.join("\n")}\n`,
	})
	return `${objects.length}:${createHash("sha256").update(bytes.stdoutBytes).digest("hex")}`
}

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run()
		return null
	} catch (err) {
		return String(err)
	}
}

describe("wire — >64 KiB trees and multi-round negotiation", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	let tipRunsTreeBytes = 0
	let largeCloneError: string | null = null
	let srcDigest = ""
	let cloneDigest = ""
	const spotTrees: { rev: string; oid: string; matches: boolean }[] = []
	const rounds: NegotiationRound[] = []

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS })
		scratch.push(src)
		tipRunsTreeBytes = Number(
			(
				await spawnGit(["cat-file", "-s", `HEAD:${RUNS_DIR}`], { cwd: src })
			).stdout.trim(),
		)

		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		const bareUrl = `file://${bare}`

		await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: src })
		await createRepack(db.sql).repack(REPO)

		// ---- A. large-tree clone, byte-compared to the source --------------------
		const cP = join(mk("cP"), "c")
		largeCloneError = await errorOf(async () => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"-c",
				"transfer.fsckobjects=true",
				"-c",
				"fetch.fsckobjects=true",
				"clone",
				"-q",
				"--no-local",
				"--no-checkout",
				url,
				cP,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: cP })
		})
		srcDigest = await digest(src)
		cloneDigest = largeCloneError === null ? await digest(cP) : ""

		// Spot-check the biggest tree objects explicitly.
		for (const rev of [
			"HEAD",
			"HEAD~1",
			`HEAD~${Math.floor(RUNS / 2)}`,
			`HEAD~${RUNS - 2}`,
		]) {
			const oid = (
				await spawnGit(["rev-parse", `${rev}:${RUNS_DIR}`], { cwd: src })
			).stdout.trim()
			const a = (await spawnGit(["cat-file", "tree", oid], { cwd: src })).stdoutBytes
			const b = await spawnGit(["cat-file", "tree", oid], { cwd: cP })
				.then((x) => x.stdoutBytes)
				.catch(() => Buffer.alloc(0))
			spotTrees.push({ matches: a.equals(b), oid, rev })
		}

		// ---- B. multi-round negotiation from a divergent client ------------------
		// Every divergent client is cloned FROM `cP`, so a broken large-tree clone
		// leaves nothing to negotiate against; its own assertion reports that break.
		if (largeCloneError !== null) return
		const grown = await createAppendOnlyRepo({ docs: 6, runs: RUNS + 40 })
		scratch.push(grown)
		await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: grown })
		await spawnGit(["push", "-q", bareUrl, "refs/heads/*:refs/heads/*"], { cwd: grown })
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })
		await createRepack(db.sql).repack(REPO)

		for (const algo of ALGORITHMS) {
			const errors = new Map<string, string | null>()
			const closures = new Map<string, string>()
			for (const [label, remote] of [
				["pggit", url],
				["git", bareUrl],
			] as const) {
				const dest = join(mk(`neg-${algo}-${label}`), "c")
				await spawnGit(["clone", "-q", "--no-local", "--no-checkout", cP, dest])
				await spawnGit(["remote", "set-url", "origin", remote], { cwd: dest })
				// Give the client a long stretch of history the server has never seen, so
				// the first have-batches can be ACKed for nothing.
				await spawnGit(["checkout", "-q", "-b", "local", "origin/main"], { cwd: dest })
				for (let i = 0; i < DIVERGENT; i++) {
					writeFileSync(join(dest, `local-${i}.txt`), `local ${i}\n`)
					await spawnGit(["add", "-A"], { cwd: dest })
					await spawnGit(["commit", "-q", "-m", `local ${i}`], { cwd: dest })
				}
				const cfg =
					algo === "default"
						? ["-c", "protocol.version=2"]
						: ["-c", "protocol.version=2", "-c", `fetch.negotiationAlgorithm=${algo}`]
				const err = await errorOf(async () => {
					await spawnGit(
						[...cfg, "-c", "transfer.fsckobjects=true", "fetch", "-q", "origin"],
						{ cwd: dest },
					)
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				})
				errors.set(label, err)
				if (err === null) closures.set(label, await closureDigest(dest, "origin/main"))
			}
			rounds.push({
				algo,
				gitClosure: closures.get("git") ?? "",
				gitError: errors.get("git") ?? null,
				pggitClosure: closures.get("pggit") ?? "",
				pggitError: errors.get("pggit") ?? null,
			})
		}
	}, 1_200_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("has the fixture it needs: the tip runs-tree is past the 0xFFFF COPY split", () => {
		expect(tipRunsTreeBytes).toBeGreaterThan(0xffff)
	})

	it("clones the >64 KiB-tree repo fsck-clean and byte-identical to the source", () => {
		expect(largeCloneError).toBeNull()
		expect(cloneDigest).toBe(srcDigest)
	})

	it("serves every spot-checked large runs-tree byte-for-byte", () => {
		for (const t of spotTrees) {
			expect(t.matches, `runs tree at ${t.rev} (${t.oid})`).toBe(true)
		}
	})

	it("survives a multi-round negotiation under every algorithm, matching git", () => {
		expect(rounds.length).toBe(ALGORITHMS.length)
		for (const r of rounds) {
			expect(r.pggitError, `${r.algo}/pggit`).toBeNull()
			expect(r.gitError, `${r.algo}/git`).toBeNull()
			expect(r.pggitClosure, r.algo).toBe(r.gitClosure)
		}
	})
})

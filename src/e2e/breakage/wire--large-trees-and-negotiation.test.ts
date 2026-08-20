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
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo, RUNS_DIR } from "@/testing/append-only-repo"
import {
	allObjectOids,
	objectBytesDigest,
	parseRevListObjectOids,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const REPO = "workspace/probe/bigtrees"
/** ~1200 uuid-named subdirs ⇒ the runs tree passes 100 KiB, so COPY runs split. */
const RUNS = 1200
const DIVERGENT = 250
const ALGORITHMS = ["default", "skipping", "noop"] as const

type NegotiationRound = {
	algo: string
	pggit: TestResult<string>
	git: TestResult<string>
}

/** `<object count>:<sha256 over every local object's raw bytes, in oid order>`. */
async function digest(dir: string): Promise<string> {
	const oids = await allObjectOids(dir)
	return `${oids.length}:${await objectBytesDigest(dir, oids)}`
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
	return `${objects.length}:${await objectBytesDigest(dir, objects)}`
}

describe("wire — >64 KiB trees and multi-round negotiation", () => {
	let db: IsolatedDb
	let server: GitServer
	const { cleanup: cleanupScratch, make: mk, own: ownScratch } = createScratchArena()

	let tipRunsTreeBytes = 0
	let largeClone: TestResult<string>
	let srcDigest = ""
	const spotTrees: { rev: string; oid: string; result: TestResult<boolean> }[] = []
	const rounds: NegotiationRound[] = []

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS })
		ownScratch(src)
		tipRunsTreeBytes = Number(
			(
				await spawnGit(["cat-file", "-s", `HEAD:${RUNS_DIR}`], { cwd: src })
			).stdout.trim(),
		)

		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const url = repoUrl(server, REPO)
		const bareUrl = `file://${bare}`

		await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: src })
		await createRepack(db.sql).repack(REPO)

		// ---- A. large-tree clone, byte-compared to the source --------------------
		const cP = join(mk("cP"), "c")
		largeClone = await captureTestResult(async () => {
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
			return digest(cP)
		})
		srcDigest = await digest(src)

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
			const result = await captureTestResult(async () => {
				const b = await spawnGit(["cat-file", "tree", oid], { cwd: cP })
				return a.equals(b.stdoutBytes)
			})
			spotTrees.push({ oid, result, rev })
		}

		// ---- B. multi-round negotiation from a divergent client ------------------
		// Every divergent client is cloned FROM `cP`, so a broken large-tree clone
		// leaves nothing to negotiate against; its own assertion reports that break.
		if (largeClone.kind === "failed") return
		const grown = await createAppendOnlyRepo({ docs: 6, runs: RUNS + 40 })
		ownScratch(grown)
		await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: grown })
		await spawnGit(["push", "-q", bareUrl, "refs/heads/*:refs/heads/*"], { cwd: grown })
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })
		await createRepack(db.sql).repack(REPO)

		for (const algo of ALGORITHMS) {
			const outcomes = new Map<string, TestResult<string>>()
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
				const fetched = await captureTestResult(async () => {
					await spawnGit(
						[...cfg, "-c", "transfer.fsckobjects=true", "fetch", "-q", "origin"],
						{ cwd: dest },
					)
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
				})
				outcomes.set(
					label,
					fetched.kind === "failed"
						? fetched
						: { kind: "succeeded", value: await closureDigest(dest, "origin/main") },
				)
			}
			const git = outcomes.get("git")
			const pggit = outcomes.get("pggit")
			if (git === undefined || pggit === undefined) {
				throw new Error(`negotiation ${algo} omitted a remote outcome`)
			}
			rounds.push({ algo, git, pggit })
		}
	}, 1_200_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		cleanupScratch()
	})

	it("has the fixture it needs: the tip runs-tree is past the 0xFFFF COPY split", () => {
		expect(tipRunsTreeBytes).toBeGreaterThan(0xffff)
	})

	it("clones the >64 KiB-tree repo fsck-clean and byte-identical to the source", () => {
		expect(largeClone.kind, testResultContext(largeClone, "large-tree clone")).toBe(
			"succeeded",
		)
		if (largeClone.kind === "succeeded") expect(largeClone.value).toBe(srcDigest)
	})

	it("serves every spot-checked large runs-tree byte-for-byte", () => {
		for (const t of spotTrees) {
			const at = `runs tree at ${t.rev} (${t.oid})`
			expect(t.result.kind, testResultContext(t.result, at)).toBe("succeeded")
			if (t.result.kind === "succeeded") expect(t.result.value, at).toBe(true)
		}
	})

	it("survives a multi-round negotiation under every algorithm, matching git", () => {
		expect(rounds.length).toBe(ALGORITHMS.length)
		for (const r of rounds) {
			expect(r.pggit.kind, testResultContext(r.pggit, `${r.algo}/pggit`)).toBe(
				"succeeded",
			)
			expect(r.git.kind, testResultContext(r.git, `${r.algo}/git`)).toBe("succeeded")
			if (r.pggit.kind === "succeeded" && r.git.kind === "succeeded") {
				expect(r.pggit.value, r.algo).toBe(r.git.value)
			}
		}
	})
})

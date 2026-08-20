/**
 * WIRE — incremental fetch against a repacked (deltified) pggit remote,
 * differentially against a plain bare git remote.
 * (Converted from `breakage/wire--incremental-fetch-deltified.ts`.)
 *
 * The serve rule (design D8) emits a stored delta as REF_DELTA only when its base
 * is ALSO in the served set. On an incremental fetch the client's `have`s subtract
 * the base out of the served set, so every such delta MUST fall back to its whole
 * form. If that rule leaks — a delta emitted whose base the client was never sent —
 * git's index-pack cannot resolve it and the fetch dies.
 *
 * Judged only at client-observable outcomes: fetch exit status, `fsck --strict`,
 * the exact object set, HEAD, and the object bytes — all diffed against the same
 * sequence run on a plain bare git remote.
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { parseRevListObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/incremental"
const RUNS_1 = 140
const RUNS_2 = 60
const ALGORITHMS = ["default", "skipping", "noop"] as const

type FetchRound = {
	algo: string
	fetchError: string | null
	fsckError: string | null
	pggitInventory: string
	gitInventory: string
	pggitDigest: string
	gitDigest: string
	pggitTip: string
	gitTip: string
}

/** Every reachable object's oid+type+size, as one comparable sorted blob. */
async function objectInventory(dir: string): Promise<string> {
	const list = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
	const oids = [...new Set(parseRevListObjectOids(list.stdout))]
	const info = await spawnGit(["cat-file", "--batch-check"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
	})
	return info.stdout.split("\n").filter(Boolean).sort().join("\n")
}

/** A content fingerprint over every reachable object's raw bytes. */
async function contentDigest(dir: string): Promise<string> {
	const list = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
	const oids = [...new Set(parseRevListObjectOids(list.stdout))].sort()
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
	})
	return createHash("sha256").update(res.stdoutBytes).digest("hex")
}

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run()
		return null
	} catch (err) {
		return String(err)
	}
}

describe("wire — incremental fetch against the deltified serve path", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	let clonePggitInventory = ""
	let cloneGitInventory = ""
	const rounds: FetchRound[] = []

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS_1 })
		scratch.push(src)

		// The oracle remote: a plain bare git repository served over file://.
		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const pggitUrl = `http://127.0.0.1:${server.port}/${REPO}`
		const bareUrl = `file://${bare}`

		// ---- seed pggit over the real wire (v0 push) --------------------------
		await spawnGit(["push", "-q", pggitUrl, "--all"], { cwd: src })
		await spawnGit(["push", "-q", pggitUrl, "--tags"], { cwd: src })
		await createRepack(db.sql).repack(REPO)

		// ---- round 1: full clone from both --------------------------------------
		const cP = join(mk("cP"), "c")
		const cG = join(mk("cG"), "c")
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", pggitUrl, cP])
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", bareUrl, cG])
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: cP })
		clonePggitInventory = await objectInventory(cP)
		cloneGitInventory = await objectInventory(cG)

		// ---- grow the source, push to both -------------------------------------
		// `grown` is the same deterministic fixture extended, so its first RUNS_1
		// commits are byte-identical to `src`'s — a real fast-forward for both remotes.
		const grown = await createAppendOnlyRepo({ docs: 6, runs: RUNS_1 + RUNS_2 })
		scratch.push(grown)
		await spawnGit(["push", "-q", pggitUrl, "--all"], { cwd: grown })
		await spawnGit(["push", "-q", bareUrl, "--all"], { cwd: grown })
		await createRepack(db.sql).repack(REPO)

		// ---- round 2: incremental fetch on each clone ---------------------------
		for (const algo of ALGORITHMS) {
			const dP = join(mk(`fP-${algo}`), "c")
			const dG = join(mk(`fG-${algo}`), "c")
			await spawnGit(["clone", "-q", "--no-local", cP, dP])
			await spawnGit(["clone", "-q", "--no-local", cG, dG])
			await spawnGit(["remote", "set-url", "origin", pggitUrl], { cwd: dP })
			await spawnGit(["remote", "set-url", "origin", bareUrl], { cwd: dG })

			const cfg =
				algo === "default"
					? ["-c", "protocol.version=2"]
					: ["-c", "protocol.version=2", "-c", `fetch.negotiationAlgorithm=${algo}`]

			const fetchError = await errorOf(() =>
				spawnGit([...cfg, "fetch", "-q", "origin"], { cwd: dP }),
			)
			if (fetchError !== null) {
				rounds.push({
					algo,
					fetchError,
					fsckError: null,
					gitDigest: "",
					gitInventory: "",
					gitTip: "",
					pggitDigest: "",
					pggitInventory: "",
					pggitTip: "",
				})
				continue
			}
			await spawnGit([...cfg, "fetch", "-q", "origin"], { cwd: dG })
			const fsckError = await errorOf(() =>
				spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dP }),
			)
			rounds.push({
				algo,
				fetchError,
				fsckError,
				gitDigest: await contentDigest(dG),
				gitInventory: await objectInventory(dG),
				gitTip: (await spawnGit(["rev-parse", "origin/main"], { cwd: dG })).stdout.trim(),
				pggitDigest: await contentDigest(dP),
				pggitInventory: await objectInventory(dP),
				pggitTip: (
					await spawnGit(["rev-parse", "origin/main"], { cwd: dP })
				).stdout.trim(),
			})
		}
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
	})

	it("clones the same object inventory a plain git remote serves", () => {
		expect(clonePggitInventory).toBe(cloneGitInventory)
	})

	it("takes an incremental fetch under every negotiation algorithm, fsck-clean", () => {
		expect(rounds.length).toBe(ALGORITHMS.length)
		for (const r of rounds) {
			expect(r.fetchError, r.algo).toBeNull()
			expect(r.fsckError, r.algo).toBeNull()
		}
	})

	it("ends each incremental fetch at git's object set, bytes and tip", () => {
		for (const r of rounds) {
			expect(r.pggitInventory, r.algo).toBe(r.gitInventory)
			expect(r.pggitDigest, r.algo).toBe(r.gitDigest)
			expect(r.pggitTip, r.algo).toBe(r.gitTip)
		}
	})
})

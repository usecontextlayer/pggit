/**
 * §8.1 M1 — multi-round have/ACK/ready negotiation driven end-to-end against the
 * real store. The incremental-fetch differentials assert the resulting object SET;
 * this asserts the negotiation SEQUENCE, exercising `readyToGiveUp`'s ancestry cut
 * (over-eager ⇒ a wrong delta sent too early; under-eager ⇒ a loop). A non-cutting
 * `have` from an unrelated root must yield acknowledgments+flush and NO pack;
 * adding a cutting `have` must flip to `ready`+delim+pack in one response (git's
 * t5702 ready-delim lock). Each transcript is compared against real
 * `git upload-pack --stateless-rpc` fed the IDENTICAL request bytes, so ACK order,
 * `ready` timing and the ready-delim lock are a differential against canonical git
 * rather than a transcription of one. The negotiation logic lives in the store now,
 * so this drives a store-backed backend rather than an in-memory map.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { decodePktStream } from "@/protocol/pkt-line"
import { bindRepoBackend } from "@/protocol/repo-backend"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { packObjectCount, sidebandDemux } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"
import { ackSection, spawnUploadPack } from "@/testing/upload-pack-oracle"
import { fetchRequest } from "@/testing/wire-fetch"

describe("M1 multi-round negotiation", () => {
	let db: IsolatedDb
	let dir: string
	let app: ReturnType<typeof createGitApp>
	let backend: RepoBackend
	let c3 = ""
	let c2 = ""
	let f1 = ""
	let u1 = "" // an UNRELATED root — no merge base with main at all

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		app = createGitApp({ objects, refs })

		// main: c1 ← c2 ← c3.  feature (off c1): f1 — a sibling, NOT an ancestor of c3.
		dir = mkdtempSync(join(tmpdir(), "pggit-mr-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		for (const v of ["1", "2", "3"]) {
			writeFileSync(join(dir, "a.txt"), `${v}\n`)
			await spawnGit(["add", "."], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", `c${v}`], { cwd: dir })
		}
		c3 = (await spawnGit(["rev-parse", "main"], { cwd: dir })).stdout.trim()
		c2 = (await spawnGit(["rev-parse", "main~1"], { cwd: dir })).stdout.trim()
		const c1 = (await spawnGit(["rev-parse", "main~2"], { cwd: dir })).stdout.trim()
		await spawnGit(["checkout", "-q", "-b", "feature", c1], { cwd: dir })
		writeFileSync(join(dir, "f.txt"), "feature\n")
		await spawnGit(["add", "."], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "f1"], { cwd: dir })
		f1 = (await spawnGit(["rev-parse", "feature"], { cwd: dir })).stdout.trim()
		// An orphan branch: shares NOTHING with main — the only have shape that
		// does not ready (a sibling have DOES, canonically: fetch-ready-sibling).
		await spawnGit(["checkout", "-q", "--orphan", "unrelated"], { cwd: dir })
		await spawnGit(["rm", "-rf", "--cached", "."], { cwd: dir })
		writeFileSync(join(dir, "u.txt"), "unrelated\n")
		await spawnGit(["add", "u.txt"], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "u1"], { cwd: dir })
		u1 = (await spawnGit(["rev-parse", "unrelated"], { cwd: dir })).stdout.trim()

		await seedRepoIntoStore("repo", dir, { objects, refs })
		backend = bindRepoBackend({ objects, refs }, "repo")
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		if (dir) rmSync(dir, { force: true, recursive: true })
	})

	it("an UNRELATED have → acknowledgments + ACK + flush, and NO packfile", async () => {
		// A have with NO merge base cannot satisfy the want — the only shape that
		// keeps negotiating. (A SIBLING have that shares a base READIES, matching
		// git's ok_to_give_up — pinned by fetch-ready-sibling.test.ts.)
		const request = fetchRequest({ done: false, haves: [u1], wants: [c3] })
		const out = await handleUploadPack(request, backend)
		// The oracle: real `git upload-pack --stateless-rpc` over the same history,
		// same request bytes. The `not ready` check pins that this shape still IS the
		// keeps-negotiating one — otherwise a readying oracle and a readying pggit
		// would agree while the test's subject vanished.
		const oracle = await spawnUploadPack(dir, request)
		expect(ackSection(oracle)).not.toContain("ready")
		expect(ackSection(out)).toBe(ackSection(oracle))
		expect(packObjectCount(oracle)).toEqual({ kind: "no-pack" })
		expect(out.toString("utf8")).not.toContain("packfile")
		expect(sidebandDemux(out).band1.length).toBe(0)
	})

	it("adding a cutting have → acknowledgments + ready, then DELIM + pack in one response", async () => {
		const request = fetchRequest({ done: false, haves: [f1, c2], wants: [c3] })
		const out = await handleUploadPack(request, backend)
		// The oracle again — including ACK ORDER, which is git's request order and is
		// exactly what a hand-transcribed literal cannot keep honest.
		const oracle = await spawnUploadPack(dir, request)
		expect(ackSection(oracle)).toContain("ready\n")
		expect(ackSection(out)).toBe(ackSection(oracle))
		const { packets } = decodePktStream(out)
		expect(packets.some((p) => p.type === "delim")).toBe(true)
		expect(sidebandDemux(out).band1.subarray(0, 4).toString("latin1")).toBe("PACK")
	})

	it("the clone shape (done, no haves) returns the packfile directly", async () => {
		const out = await handleUploadPack(
			fetchRequest({ done: true, haves: [], wants: [c3] }),
			backend,
		)
		expect(sidebandDemux(out).band1.subarray(0, 4).toString("latin1")).toBe("PACK")
	})

	it("a want for an object the repo lacks is answered in-band with ERR, never a short pack (like real git)", async () => {
		// Oracle: real git upload-pack answers a `want` it does not have IN-BAND with
		// `ERR upload-pack: not our ref <oid>` (an HTTP-200 protocol error the client
		// reads), not a transport-level rejection/500 — and never ships a short/partial
		// pack. (Earlier this rejected; that diverged from the oracle — see smoke/mal01.)
		const request = fetchRequest({
			done: true,
			haves: [],
			wants: ["a".repeat(40)],
		})
		const response = await app.request("/repo/git-upload-pack", {
			body: request,
			headers: {
				"Content-Type": "application/x-git-upload-pack-request",
				"Git-Protocol": "version=2",
			},
			method: "POST",
		})
		expect(response.status).toBe(200)
		const out = Buffer.from(await response.arrayBuffer())
		const oracle = await spawnUploadPack(dir, request, { expectInBandError: true })
		expect(oracle.code).toBe(128)
		expect(out).toEqual(oracle.out)
		const expectedError = `ERR upload-pack: not our ref ${"a".repeat(40)}`
		expect(out.toString("utf8")).toContain(expectedError)
		expect(oracle.out.toString("utf8")).toContain(expectedError)
		expect(out.toString("utf8")).not.toContain("packfile")
	})
})

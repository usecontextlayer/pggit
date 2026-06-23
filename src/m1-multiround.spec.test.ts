/**
 * §8.1 M1 — multi-round have/ACK/ready negotiation driven end-to-end against the
 * real store. The incremental-fetch differentials assert the resulting object SET;
 * this asserts the negotiation SEQUENCE, exercising `readyToGiveUp`'s ancestry cut
 * (over-eager ⇒ a wrong delta sent too early; under-eager ⇒ a loop). A non-cutting
 * `have` (off a sibling branch) must yield acknowledgments+flush and NO pack;
 * adding a cutting `have` must flip to `ready`+delim+pack in one response (git's
 * t5702 ready-delim lock). The negotiation logic lives in the store now (ancestry
 * CTE over the edge table), so this drives a store-backed backend rather than an
 * in-memory map.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createObjectStore } from "@/object-store"
import { decodePktStream, encodePkt, encodePktLine, type Pkt } from "@/pkt-line"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { createRefStore } from "@/refs-store"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { sidebandDemux } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"

/** Drive a fetch round directly against the upload-pack handler. */
function fetchBody(wants: string[], haves: string[], done: boolean): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from("command=fetch\n")),
		encodePkt({ type: "delim" }),
		...wants.map((w) => encodePktLine(Buffer.from(`want ${w}\n`))),
		...haves.map((h) => encodePktLine(Buffer.from(`have ${h}\n`))),
		...(done ? [encodePktLine(Buffer.from("done\n"))] : []),
		encodePkt({ type: "flush" }),
	])
}

/** The data packets before the delim — the acknowledgments section text. */
function ackSection(out: Buffer): string {
	const { packets } = decodePktStream(out)
	const delim = packets.findIndex((p) => p.type === "delim")
	const end = delim < 0 ? packets.length : delim
	return packets
		.slice(0, end)
		.map((p) =>
			p.type === "data"
				? (p as Extract<Pkt, { type: "data" }>).payload.toString("utf8")
				: "",
		)
		.join("")
}

describe("M1 multi-round negotiation", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let dir: string
	let backend: RepoBackend
	let c3 = ""
	let c2 = ""
	let f1 = ""

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)

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

		await seedRepoIntoStore("repo", dir, { objects, refs })
		backend = {
			buildPack: (wants, haves, omitBlobs) =>
				objects.buildPack("repo", wants, haves, omitBlobs),
			commonHaves: (haves) => objects.commonHaves("repo", haves),
			getSymref: (name) => refs.getSymref("repo", name),
			listRefs: () => refs.listRefs("repo"),
			readyToGiveUp: (wants, common) => objects.readyToGiveUp("repo", wants, common),
		}
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		await container?.stop()
		if (dir) rmSync(dir, { force: true, recursive: true })
	})

	it("a non-cutting have → acknowledgments + ACK + flush, and NO packfile", async () => {
		const out = await handleUploadPack(fetchBody([c3], [f1], false), backend)
		expect(ackSection(out)).toBe(`acknowledgments\nACK ${f1}\n`)
		expect(out.toString("utf8")).not.toContain("packfile")
		expect(sidebandDemux(out).band1.length).toBe(0)
	})

	it("adding a cutting have → acknowledgments + ready, then DELIM + pack in one response", async () => {
		const out = await handleUploadPack(fetchBody([c3], [f1, c2], false), backend)
		expect(ackSection(out)).toBe(`acknowledgments\nACK ${f1}\nACK ${c2}\nready\n`)
		const { packets } = decodePktStream(out)
		expect(packets.some((p) => p.type === "delim")).toBe(true)
		expect(sidebandDemux(out).band1.subarray(0, 4).toString("latin1")).toBe("PACK")
	})

	it("the clone shape (done, no haves) returns the packfile directly", async () => {
		const out = await handleUploadPack(fetchBody([c3], [], true), backend)
		expect(sidebandDemux(out).band1.subarray(0, 4).toString("latin1")).toBe("PACK")
	})

	it("a want for an object the repo lacks is answered in-band with ERR, never a short pack (like real git)", async () => {
		// Oracle: real git upload-pack answers a `want` it does not have IN-BAND with
		// `ERR upload-pack: not our ref <oid>` (an HTTP-200 protocol error the client
		// reads), not a transport-level rejection/500 — and never ships a short/partial
		// pack. (Earlier this rejected; that diverged from the oracle — see smoke/mal01.)
		const out = await handleUploadPack(fetchBody(["a".repeat(40)], [], true), backend)
		const text = out.toString("utf8")
		expect(text).toMatch(/ERR .*not our ref/)
		expect(text).toContain("a".repeat(40))
		expect(text).not.toContain("packfile")
	})
})

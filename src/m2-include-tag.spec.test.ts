/**
 * §6.5 include-tag: when the client sends the `include-tag` capability, the server
 * augments the served pack with annotated tags whose peeled target is in the served
 * set — and ONLY those. A tag pointing at a commit outside the fetched set is not
 * sent, and without `include-tag` no tag is auto-included. Driven with a hand-built
 * fetch so the wants are controlled (real git auto-adds tag wants, which would mask
 * the capability).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { computeOid } from "@/object"
import { createObjectStore } from "@/object-store"
import { readPack } from "@/pack/read-pack"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { createRefStore } from "@/refs-store"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { sidebandDemux } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"

function fetchBody(wants: string[], includeTag: boolean): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from("command=fetch\n")),
		encodePkt({ type: "delim" }),
		...wants.map((w) => encodePktLine(Buffer.from(`want ${w}\n`))),
		...(includeTag ? [encodePktLine(Buffer.from("include-tag\n"))] : []),
		encodePktLine(Buffer.from("done\n")),
		encodePkt({ type: "flush" }),
	])
}

describe("include-tag augmentation", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let dir = ""
	let backend: RepoBackend
	let c1 = ""
	let av = "" // annotated tag → c1 (in the served set)
	let av2 = "" // annotated tag → c2 (NOT in the served set)

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.db)
		const refs = createRefStore(db.db)

		dir = mkdtempSync(join(tmpdir(), "pggit-inctag-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		writeFileSync(join(dir, "a.txt"), "one\n")
		await spawnGit(["add", "."], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })
		c1 = (await spawnGit(["rev-parse", "main"], { cwd: dir })).stdout.trim()
		writeFileSync(join(dir, "a.txt"), "two\n")
		await spawnGit(["add", "."], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "c2"], { cwd: dir })
		const c2 = (await spawnGit(["rev-parse", "main"], { cwd: dir })).stdout.trim()
		await spawnGit(["tag", "-a", "av", "-m", "on-c1", c1], { cwd: dir })
		await spawnGit(["tag", "-a", "av2", "-m", "on-c2", c2], { cwd: dir })
		av = (await spawnGit(["rev-parse", "refs/tags/av"], { cwd: dir })).stdout.trim()
		av2 = (await spawnGit(["rev-parse", "refs/tags/av2"], { cwd: dir })).stdout.trim()

		await seedRepoIntoStore("repo", dir, { objects, refs })
		backend = {
			buildPack: (w, h, o, t) => objects.buildPack("repo", w, h, o, t),
			commonHaves: (h) => objects.commonHaves("repo", h),
			getSymref: (n) => refs.getSymref("repo", n),
			listRefs: () => refs.listRefs("repo"),
			readyToGiveUp: (w, c) => objects.readyToGiveUp("repo", w, c),
		}
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		await container?.stop()
		if (dir) rmSync(dir, { force: true, recursive: true })
	})

	async function servedOids(out: Buffer): Promise<Set<string>> {
		const objs = await readPack(sidebandDemux(out).band1)
		return new Set(objs.map((o) => computeOid(o.type, o.content)))
	}

	it("includes an annotated tag whose peeled target is served, but not one pointing outside it", async () => {
		const oids = await servedOids(await handleUploadPack(fetchBody([c1], true), backend))
		expect(oids.has(c1)).toBe(true)
		expect(oids.has(av)).toBe(true) // av → c1 (served) ⇒ included
		expect(oids.has(av2)).toBe(false) // av2 → c2 (not served) ⇒ excluded
	})

	it("includes no tag when the client did not request include-tag", async () => {
		const oids = await servedOids(await handleUploadPack(fetchBody([c1], false), backend))
		expect(oids.has(c1)).toBe(true)
		expect(oids.has(av)).toBe(false)
		expect(oids.has(av2)).toBe(false)
	})
})

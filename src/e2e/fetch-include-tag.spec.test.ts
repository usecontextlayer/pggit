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
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { computeOid } from "@/object/object"
import { readPack } from "@/pack/read-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { sidebandDemux } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

describe("include-tag augmentation", () => {
	let db: IsolatedDb
	let dir = ""
	let backend: RepoBackend
	let c1 = ""
	let av = "" // annotated tag → c1 (in the served set)
	let av2 = "" // annotated tag → c2 (NOT in the served set)

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)

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
		if (dir) rmSync(dir, { force: true, recursive: true })
	})

	async function servedOids(out: Buffer): Promise<Set<string>> {
		const objs = await readPack(sidebandDemux(out).band1)
		return new Set(objs.map((o) => computeOid(o.type, o.content)))
	}

	it("includes an annotated tag whose peeled target is served, but not one pointing outside it", async () => {
		const oids = await servedOids(
			await handleUploadPack(
				fetchRequest({ done: true, includeTag: true, wants: [c1] }),
				backend,
			),
		)
		expect(oids.has(c1)).toBe(true)
		expect(oids.has(av)).toBe(true) // av → c1 (served) ⇒ included
		expect(oids.has(av2)).toBe(false) // av2 → c2 (not served) ⇒ excluded
	})

	it("includes no tag when the client did not request include-tag", async () => {
		const oids = await servedOids(
			await handleUploadPack(
				fetchRequest({ done: true, includeTag: false, wants: [c1] }),
				backend,
			),
		)
		expect(oids.has(c1)).toBe(true)
		expect(oids.has(av)).toBe(false)
		expect(oids.has(av2)).toBe(false)
	})
})

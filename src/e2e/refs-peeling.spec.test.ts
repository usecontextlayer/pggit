/**
 * §5.3 peeled_oid computed at ref-write, replacing the per-ls-refs tag walk. The
 * peel follows the kind=5 (tag→target) chain to the terminal non-tag: an annotated
 * tag peels to its commit, a tag-of-tag peels through the chain, a lightweight tag
 * and a branch do not peel (no `peeled` line). Asserted both at the store
 * (`listRefs`) and on the ls-refs wire.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createObjectStore } from "@/object-store"
import { decodePktStream, encodePkt, encodePktLine } from "@/pkt-line"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { createRefStore, type RefRow } from "@/refs-store"
import { seedRepoIntoStore } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

describe("peeled_oid at ref-write", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let dir = ""
	let refs: ReturnType<typeof createRefStore>
	let backend: RepoBackend
	let c1 = ""

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)

		dir = mkdtempSync(join(tmpdir(), "pggit-peel-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		writeFileSync(join(dir, "a.txt"), "alpha\n")
		await spawnGit(["add", "."], { cwd: dir })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })
		c1 = (await spawnGit(["rev-parse", "main"], { cwd: dir })).stdout.trim()
		// annotated tag (→ c1), lightweight tag (→ c1 directly), and a tag-of-tag
		// built against the annotated tag's OBJECT so it chains av2 → av → c1.
		await spawnGit(["tag", "-a", "av", "-m", "annotated"], { cwd: dir })
		await spawnGit(["tag", "lv"], { cwd: dir })
		const avObj = (
			await spawnGit(["rev-parse", "refs/tags/av"], { cwd: dir })
		).stdout.trim()
		await spawnGit(["tag", "-a", "av2", "-m", "tag-of-tag", avObj], { cwd: dir })
		// A tag chain far deeper than any fixed cap: deep0 → av → c1, then
		// deep1 → deep0 → …, so deep17 is ~19 hops from c1. git peels it fully.
		let chainTip = avObj
		for (let i = 0; i < 18; i++) {
			await spawnGit(["tag", "-a", `deep${i}`, "-m", "x", chainTip], { cwd: dir })
			chainTip = (
				await spawnGit(["rev-parse", `refs/tags/deep${i}`], { cwd: dir })
			).stdout.trim()
		}

		await seedRepoIntoStore("repo", dir, { objects, refs })
		backend = {
			buildPack: (w, h, o) => objects.buildPack("repo", w, h, o),
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

	it("listRefs peels annotated tags (incl. tag-of-tag) to their commit, leaving branches/lightweight tags unpeeled", async () => {
		const byName = new Map((await refs.listRefs("repo")).map((r: RefRow) => [r.name, r]))
		expect(byName.get("refs/heads/main")?.peeled).toBeUndefined()
		expect(byName.get("refs/tags/lv")?.peeled).toBeUndefined()
		expect(byName.get("refs/tags/av")?.peeled).toBe(c1)
		expect(byName.get("refs/tags/av2")?.peeled).toBe(c1)
	})

	it("peels a tag chain deeper than any fixed cap (git imposes no peel-depth limit)", async () => {
		const byName = new Map((await refs.listRefs("repo")).map((r: RefRow) => [r.name, r]))
		expect(byName.get("refs/tags/deep17")?.peeled).toBe(c1)
	})

	it("ls-refs emits `peeled:` only for annotated tags", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=ls-refs\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from("peel\n")),
			encodePkt({ type: "flush" }),
		])
		const out = await handleUploadPack(body, backend)
		// Each ls-refs line is `<oid> <refname>[ peeled:<oid>]`; key by the exact ref
		// token so refs/tags/av is not confused with refs/tags/av2.
		const byName = new Map<string, string>()
		for (const p of decodePktStream(out).packets) {
			if (p.type !== "data") continue
			const line = (p as { payload: Buffer }).payload.toString("utf8").replace(/\n$/, "")
			const name = line.split(" ")[1]
			if (name) byName.set(name, line)
		}

		expect(byName.get("refs/tags/av")).toContain(`peeled:${c1}`)
		expect(byName.get("refs/tags/av2")).toContain(`peeled:${c1}`)
		expect(byName.get("refs/tags/lv") ?? "").not.toContain("peeled:")
		expect(byName.get("refs/heads/main") ?? "").not.toContain("peeled:")
	})
})

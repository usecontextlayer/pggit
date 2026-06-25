import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)

describe("M2 — connectivity check rejects an incomplete push (spec §10)", () => {
	let db: IsolatedDb
	let app: Hono
	let objects: ObjectStore
	let refs: RefStore

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		app = createGitApp({ objects, refs })
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
	})

	it("ng's a push whose pack omits a referenced blob, leaving the ref unset", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-conn-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			const commit = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			const tree = (
				await spawnGit(["rev-parse", "HEAD^{tree}"], { cwd: src })
			).stdout.trim()

			// Pack ONLY the commit + tree (omit the blob the tree references).
			const incompletePack = (
				await spawnGit(["pack-objects", "--stdout"], {
					cwd: src,
					input: `${commit}\n${tree}\n`,
				})
			).stdoutBytes

			// Hand-build a (non-sideband) receive-pack request: one create command,
			// flush, then the incomplete pack.
			const body = Buffer.concat([
				encodePktLine(
					Buffer.from(`${ZERO} ${commit} refs/heads/broken\0report-status\n`),
				),
				encodePkt({ type: "flush" }),
				incompletePack,
			])
			const res = await app.request("/repo-broken/git-receive-pack", {
				body,
				method: "POST",
			})
			const report = Buffer.from(await res.arrayBuffer()).toString("utf8")

			// The pack unpacked, but connectivity fails → the ref is rejected, unset.
			expect(report).toContain("unpack ok")
			expect(report).toContain("ng refs/heads/broken missing necessary objects")
			expect(await refs.listRefs("repo-broken")).toEqual([])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	it("ok's a push whose pack carries every reachable object, landing the ref", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-conn-ok-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			const commit = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			// A complete pack (default pack-objects over the revs) carries everything,
			// so connectivity passes and the push succeeds — asserted via the wire `ok`
			// report + the landed ref, not a direct isConnected() peek.
			const fullPack = (
				await spawnGit(["pack-objects", "--stdout", "--revs"], {
					cwd: src,
					input: `${commit}\n`,
				})
			).stdoutBytes
			const body = Buffer.concat([
				encodePktLine(Buffer.from(`${ZERO} ${commit} refs/heads/main\0report-status\n`)),
				encodePkt({ type: "flush" }),
				fullPack,
			])
			const res = await app.request("/repo-ok/git-receive-pack", {
				body,
				method: "POST",
			})
			const report = Buffer.from(await res.arrayBuffer()).toString("utf8")

			expect(report).toContain("unpack ok")
			expect(report).toContain("ok refs/heads/main")
			expect(await refs.listRefs("repo-ok")).toEqual([
				{ name: "refs/heads/main", oid: commit },
			])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	it("ok's a push with a gitlink (submodule) entry — the submodule commit is not required", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-conn-gitlink-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: src })
			// Record a gitlink to a submodule commit that lives in another repo (so it
			// is absent here) — a `160000` tree entry.
			await spawnGit(
				["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`],
				{ cwd: src },
			)
			await spawnGit(["commit", "-q", "-m", "with-submodule"], { cwd: src })
			const commit = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			// --revs packs the commit, its tree, and a.txt; the gitlink target is not in
			// this repo, so it is naturally excluded from the pack.
			const pack = (
				await spawnGit(["pack-objects", "--stdout", "--revs"], {
					cwd: src,
					input: `${commit}\n`,
				})
			).stdoutBytes
			const body = Buffer.concat([
				encodePktLine(
					Buffer.from(`${ZERO} ${commit} refs/heads/withsub\0report-status\n`),
				),
				encodePkt({ type: "flush" }),
				pack,
			])
			const res = await app.request("/repo-gitlink/git-receive-pack", {
				body,
				method: "POST",
			})
			const report = Buffer.from(await res.arrayBuffer()).toString("utf8")

			// A gitlink is not a connectivity requirement (it lives in another repo), so
			// the push lands despite the submodule commit being absent.
			expect(report).toContain("unpack ok")
			expect(report).toContain("ok refs/heads/withsub")
			expect(await refs.listRefs("repo-gitlink")).toEqual([
				{ name: "refs/heads/withsub", oid: commit },
			])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	it("ng's a push of an annotated tag whose target object is omitted", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-conn-tag-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			await spawnGit(["tag", "-a", "v1", "-m", "rel"], { cwd: src })
			const tagObj = (
				await spawnGit(["rev-parse", "refs/tags/v1"], { cwd: src })
			).stdout.trim()

			// Pack ONLY the tag object (no --revs ⇒ no traversal), omitting its target
			// commit and everything below it.
			const pack = (
				await spawnGit(["pack-objects", "--stdout"], {
					cwd: src,
					input: `${tagObj}\n`,
				})
			).stdoutBytes
			const body = Buffer.concat([
				encodePktLine(Buffer.from(`${ZERO} ${tagObj} refs/tags/v1\0report-status\n`)),
				encodePkt({ type: "flush" }),
				pack,
			])
			const res = await app.request("/repo-tag-missing/git-receive-pack", {
				body,
				method: "POST",
			})
			const report = Buffer.from(await res.arrayBuffer()).toString("utf8")

			// Connectivity descends the tag→target edge and finds the target absent.
			expect(report).toContain("unpack ok")
			expect(report).toContain("ng refs/tags/v1 missing necessary objects")
			expect(await refs.listRefs("repo-tag-missing")).toEqual([])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})
})

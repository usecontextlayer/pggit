import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)
const WRONG = "f".repeat(40) // a deliberately stale advertised old-oid

describe("M2 — atomic vs non-atomic ref updates", () => {
	let db: IsolatedDb
	let app: Hono
	let server: GitServer
	let objects: ObjectStore
	let refs: RefStore

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		app = createGitApp({ objects, refs })
		server = await serveOnPort(app, 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
	})

	it("creates multiple branches in one --atomic push (real git)", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-atomic-src-"))
		try {
			await spawnGit(["init", "-q"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "alpha\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			await spawnGit(
				[
					"push",
					"--atomic",
					`http://127.0.0.1:${server.port}/repo-atomic`,
					"HEAD:refs/heads/one",
					"HEAD:refs/heads/two",
				],
				{ cwd: src },
			)

			expect(await refs.listRefs("repo-atomic")).toEqual([
				{ name: "refs/heads/one", oid: head },
				{ name: "refs/heads/two", oid: head },
			])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	// The atomic-rollback CAS semantics are pinned at the wire: a hand-built
	// receive-pack with one valid create + one stale update must report `ng` on
	// BOTH refs and apply NEITHER. (The store-level CAS post-state — non-atomic
	// partial application, create/delete sentinels — is unit-covered in
	// refs-store.test.ts; here we assert the observable push outcome end to end.)
	it("atomic: a stale CAS in the batch ng's every ref and applies none", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-atomic-wire-"))
		try {
			await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "one\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
			const c1 = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

			// Seed main=c1 with a real push.
			await spawnGit(
				[
					"push",
					`http://127.0.0.1:${server.port}/repo-atomic-wire`,
					"HEAD:refs/heads/main",
				],
				{ cwd: src },
			)

			// A second commit, packed with its full closure (re-ingesting c1 is
			// idempotent) so both new tips pass the connectivity check.
			writeFileSync(join(src, "a.txt"), "two\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "c2"], { cwd: src })
			const c2 = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			const pack = (
				await spawnGit(["pack-objects", "--stdout", "--revs"], {
					cwd: src,
					input: `${c2}\n`,
				})
			).stdoutBytes

			// Atomic batch: a valid create (feature) + an update whose advertised old-oid
			// is stale (main is c1, not WRONG). Caps (incl. `atomic`) ride the first line.
			const body = Buffer.concat([
				encodePktLine(
					Buffer.from(`${ZERO} ${c2} refs/heads/feature\0report-status atomic\n`),
				),
				encodePktLine(Buffer.from(`${WRONG} ${c2} refs/heads/main\n`)),
				encodePkt({ type: "flush" }),
				pack,
			])
			const res = await app.request("/repo-atomic-wire/git-receive-pack", {
				body,
				method: "POST",
			})
			const report = Buffer.from(await res.arrayBuffer()).toString("utf8")

			// The pack unpacked, but the atomic batch rolls back wholesale: both ng.
			expect(report).toContain("unpack ok")
			expect(report).toContain("ng refs/heads/feature")
			expect(report).toContain("ng refs/heads/main")
			// Nothing applied: feature never created, main still c1.
			expect(await refs.listRefs("repo-atomic-wire")).toEqual([
				{ name: "refs/heads/main", oid: c1 },
			])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})

	// The deny-non-FF policy composes with atomic (real git): ONE policy-denied
	// command — a non-fast-forward, `+`-marked so the CLIENT sends it instead of
	// refusing locally — poisons the whole batch. The perfectly valid create in
	// the same push is ng'd too and NEITHER ref changes. Pins receive-pack's
	// atomic disqualification branch: a regression that applied the valid half
	// would break the all-or-nothing contract `--atomic` promises.
	it("atomic: a policy-denied non-FF in the batch ng's every ref and applies none", async () => {
		const src = mkdtempSync(join(tmpdir(), "pggit-atomic-policy-"))
		try {
			const repo = `http://127.0.0.1:${server.port}/repo-atomic-policy`
			await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
			writeFileSync(join(src, "a.txt"), "A\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "A"], { cwd: src })
			const a = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			writeFileSync(join(src, "a.txt"), "B\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "B"], { cwd: src })
			const b = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			await spawnGit(["push", repo, "HEAD:refs/heads/main"], { cwd: src })

			// Rewrite history off A → C diverges from B (a non-fast-forward).
			await spawnGit(["reset", "--hard", a], { cwd: src })
			writeFileSync(join(src, "a.txt"), "C\n")
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "C"], { cwd: src })

			await expect(
				spawnGit(
					["push", "--atomic", repo, "+HEAD:refs/heads/main", "HEAD:refs/heads/side"],
					{ cwd: src },
				),
			).rejects.toThrow(/non-fast-forward|atomic/i)

			// Nothing applied: `side` never created, `main` still exactly B.
			expect(await refs.listRefs("repo-atomic-policy")).toEqual([
				{ name: "refs/heads/main", oid: b },
			])
		} finally {
			rmSync(src, { force: true, recursive: true })
		}
	})
})

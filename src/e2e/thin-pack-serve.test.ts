/**
 * Thin-pack serving (spine S5, D8′/R9): under a NEGOTIATED `thin-pack`, a served
 * delta's base may live on the client — provably, via the frontier's
 * `clientHas` — and a freshly-pushed tree deltas at SERVE TIME against its
 * same-path boundary predecessor (the warm delta, R9). Without the negotiation,
 * no external base is ever emitted (the negative gate).
 *
 * The external-base detector is git-native: `git index-pack --fix-thin` APPENDS
 * each externally-based object to the pack, so the fixed index holding MORE
 * objects than the pack header promised is exactly "external bases were used" —
 * no pack-parsing of our own, and fsck --strict follows on the same repo. The
 * correctness bar (R8): every served thin pack ingests clean, and the fetched
 * object set matches a from-scratch enumeration of the same want.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps, type GitDeps } from "@/index"
import { readPack } from "@/pack/read-pack"
import { handleUploadPack, type RepoBackend } from "@/protocol/upload-pack"
import { type GitServer, serveOnPort } from "@/server"
import { allObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { sidebandDemux } from "@/testing/pkt-oracle"
import { spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

const REPO = "thin"
const WIDE_FILES = 400

describe("thin-pack serve — external bases only when negotiated", () => {
	let db: IsolatedDb
	let deps: GitDeps
	let server: GitServer
	let src = ""
	let root = ""
	let oldTip = ""
	let newTip = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		deps = createGitDeps(db.sql)
		server = await serveOnPort(createGitApp(deps), 0)
		root = mkdtempSync(join(tmpdir(), "pggit-thin-"))
		src = join(root, "src")

		// A WIDE tree, so the warm delta has something real to win on: the one-file
		// push rewrites a 400-entry root tree whose predecessor the client holds.
		await spawnGit(["init", "-q", "-b", "main", src])
		mkdirSync(join(src, "wide"))
		for (let i = 0; i < WIDE_FILES; i++) {
			writeFileSync(join(src, "wide", `f${String(i).padStart(4, "0")}.txt`), `${i}\n`)
		}
		await spawnGit(["add", "-A"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "wide"], { cwd: src })
		oldTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		writeFileSync(join(src, "wide", "f0000.txt"), "changed\n")
		await spawnGit(["commit", "-q", "-am", "one-file"], { cwd: src })
		newTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		const url = `http://127.0.0.1:${server.port}/${REPO}`
		await spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: src })
		await spawnGit(["push", "-q", url, `${oldTip}:refs/heads/old`], { cwd: src })
		// Deliberately NO repack: with no stored encoding tier, an external-base
		// delta in a served pack can ONLY be the serve-time warm delta (R9) — a
		// stored delta whose base happens to be client-held would otherwise
		// satisfy the same detector and let the warm path die unnoticed. The
		// stored-delta serve path has its own suites (pack-encoding-serve).
		const [encRow] = await db.sql<{ n: string }[]>`
			select count(*)::text as n from git_pack_encoding`
		if (encRow?.n !== "0") throw new Error("fixture expects an empty encoding tier")
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	/** Feed `pack` to `git index-pack` in a scratch repo already holding the
	 * client's objects; returns { headerCount, indexedCount, fsck }. */
	async function ingestAsClient(
		pack: Buffer,
		fixThin: boolean,
	): Promise<{ headerCount: number; indexedCount: number; fsck: string }> {
		const client = join(root, `client-${fixThin}-${Math.abs(pack.length)}`)
		rmSync(client, { force: true, recursive: true })
		await spawnGit(["init", "-q", client])
		// The client "has" oldTip's closure — fetched from the OLD branch ref.
		await spawnGit(
			[
				"-c",
				"protocol.version=2",
				"fetch",
				"-q",
				`http://127.0.0.1:${server.port}/${REPO}`,
				"refs/heads/old:refs/heads/have",
			],
			{ cwd: client },
		)
		const packPath = join(client, "served.pack")
		const headerCount = pack.readUInt32BE(8)
		if (fixThin) {
			// --fix-thin requires --stdin; the (fixed) pack is written to packPath.
			await spawnGit(["index-pack", "--stdin", "--fix-thin", packPath], {
				cwd: client,
				input: pack,
			})
		} else {
			writeFileSync(packPath, pack)
			await spawnGit(["index-pack", packPath], { cwd: client })
		}
		const verify = await spawnGit(
			["verify-pack", "-v", packPath.replace(/\.pack$/, ".idx")],
			{ cwd: client },
		)
		const indexedCount = verify.stdout
			.split("\n")
			.filter((l) => /^[0-9a-f]{40} /.test(l)).length
		const fsckOut = await spawnGit(["fsck", "--strict", "--no-dangling"], {
			cwd: client,
		})
		return {
			fsck: `${fsckOut.stdout}${fsckOut.stderr}`.trim() || "clean",
			headerCount,
			indexedCount,
		}
	}

	it("a negotiated thin-pack ships external-base deltas — and they resolve clean", async () => {
		const pack = await deps.objects.buildPack(
			REPO,
			[newTip],
			[oldTip],
			false,
			false,
			true,
		)
		const { headerCount, indexedCount, fsck } = await ingestAsClient(pack, true)
		// --fix-thin APPENDS every external base: more indexed objects than the
		// header promised ⇔ external bases were actually used — and with the
		// encoding tier empty by construction (see beforeAll), an external base
		// proves the WARM path specifically: the new wide root tree rode a
		// serve-time delta instead of shipping whole.
		expect(indexedCount).toBeGreaterThan(headerCount)
		expect(fsck).toBe("clean")
	})

	it("without the negotiation, no external base is ever emitted", async () => {
		const pack = await deps.objects.buildPack(
			REPO,
			[newTip],
			[oldTip],
			false,
			false,
			false,
		)
		// Plain index-pack (no --fix-thin) REFUSES a thin pack — succeeding proves
		// the pack is self-contained; equal counts prove nothing was appended.
		const { headerCount, indexedCount, fsck } = await ingestAsClient(pack, false)
		expect(indexedCount).toBe(headerCount)
		expect(fsck).toBe("clean")
	})

	it("the WIRE negotiates thin-pack end-to-end: external bases appear iff the arg was sent", async () => {
		// This drives the FULL protocol layer (advert → parseFetch → handleFetch →
		// buildPack) with a raw v2 request, so deleting the advertisement, the
		// parser's thin-pack line, or the threading to buildPack fails HERE —
		// the store-level cases above force the boolean and cannot see that.
		// readPack's base resolver doubles as the external-base detector: it is
		// consulted exactly once per REF_DELTA whose base is not in the pack.
		const backend: RepoBackend = {
			buildPack: (w, h, o, i, t) => deps.objects.buildPack(REPO, w, h, o, i, t),
			commonHaves: (h) => deps.objects.commonHaves(REPO, h),
			getSymref: (n) => deps.refs.getSymref(REPO, n),
			listRefs: () => deps.refs.listRefs(REPO),
			readyToGiveUp: (w, c) => deps.objects.readyToGiveUp(REPO, w, c),
		}
		for (const thin of [true, false]) {
			const out = await handleUploadPack(
				fetchRequest({ done: true, haves: [oldTip], thinPack: thin, wants: [newTip] }),
				backend,
			)
			const externals: string[] = []
			const objs = await readPack(sidebandDemux(out).band1, async (oid) => {
				externals.push(oid)
				return deps.objects.getObject(REPO, oid)
			})
			expect(objs.length).toBeGreaterThan(0)
			if (thin) expect(externals.length).toBeGreaterThan(0)
			else expect(externals).toEqual([])
		}
	})

	it("a real `git fetch` (which negotiates thin-pack) transfers exactly the expected set", async () => {
		const client = join(root, "e2e-client")
		rmSync(client, { force: true, recursive: true })
		await spawnGit(["init", "-q", client])
		const url = `http://127.0.0.1:${server.port}/${REPO}`
		await spawnGit(
			["-c", "protocol.version=2", "fetch", "-q", url, "refs/heads/old:refs/heads/have"],
			{ cwd: client },
		)
		const before = new Set(await allObjectOids(client))
		await spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, "refs/heads/main"], {
			cwd: client,
		})
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: client })
		const fetched = (await allObjectOids(client)).filter((o) => !before.has(o))

		// The expected transfer, from git itself on the source repo.
		const expected = (
			await spawnGit(["rev-list", "--objects", newTip, `^${oldTip}`], { cwd: src })
		).stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.slice(0, 40))
		expect(fetched.sort()).toEqual(expected.sort())
	})
})

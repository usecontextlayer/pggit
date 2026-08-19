/**
 * THE SERVED-SET ORACLE (spine S4 — built BEFORE the frontier, deliberately):
 * for every (want, have) pair over a topology-rich fixture, a client holding
 * exactly `have`'s closure fetches `want` from pggit and from canonical git, and
 * the OBJECT SETS the two fetches transfer must be identical. This is R16's
 * arbiter: name-paired boundary diffing ships only if this oracle cannot tell it
 * from git (the priced upgrade — full boundary-tree expansion — fires only on a
 * disagreement), and it is the only trustworthy net under the riskiest slice.
 *
 * The comparison is END-TO-END: real `git fetch` against both servers, so
 * negotiation, ack lines, and pack encoding are all inside the measured surface
 * — not a unit probe of an internal set. Fixture pairs cover the shapes the
 * design names: linear advance, merge, octopus, criss-cross, rename, revert
 * (a tree equal to an ancestor's — the name-pairing over-send candidate),
 * tag want, rewound have (have not an ancestor of want), and unrelated-root
 * have. Store-level cases cover exact-oid blob wants (the promisor rule) and a
 * present-but-orphaned parent (a NULL-generation region on the want's history).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { computeOid } from "@/object/object"
import { readPack } from "@/pack/read-pack"
import { type GitServer, serveOnPort } from "@/server"
import type { ObjectStore } from "@/store/object-store"
import { allObjectOids, loadAllObjects } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "oracle"

type Rev = string

describe("served set ≡ canonical git, for every (want, have) pair", () => {
	let db: IsolatedDb
	let server: GitServer
	let objects: ObjectStore
	let src = ""
	let root = ""
	let pggitUrl = ""
	const rev = new Map<string, Rev>()

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const deps = createGitDeps(db.sql)
		objects = deps.objects
		server = await serveOnPort(createGitApp(deps), 0)
		root = mkdtempSync(join(tmpdir(), "pggit-oracle-"))
		src = join(root, "src")
		pggitUrl = `http://127.0.0.1:${server.port}/${REPO}`

		// ── The fixture: one repo carrying every shape the design names. ──
		await spawnGit(["init", "-q", "-b", "main", src])
		const write = (path: string, content: string): void => {
			mkdirSync(dirname(join(src, path)), { recursive: true })
			writeFileSync(join(src, path), content)
		}
		const commit = async (name: string, msg: string): Promise<void> => {
			await spawnGit(["add", "-A"], { cwd: src })
			await spawnGit(["commit", "-q", "--allow-empty", "-m", msg], { cwd: src })
			rev.set(name, (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim())
		}
		const git = async (...args: string[]): Promise<void> => {
			await spawnGit(args, { cwd: src })
		}

		// linear base
		write("a.txt", "one\n")
		write("dir/inner.txt", "inner\n")
		await commit("base", "base")
		write("a.txt", "two\n")
		await commit("linear1", "linear1")
		write("dir/inner.txt", "inner-2\n")
		write("wide/w1.txt", "w1\n")
		await commit("linear2", "linear2")

		// merge: a side branch off base merged into main
		await git("checkout", "-q", "-b", "side", rev.get("linear1") as string)
		write("side.txt", "side\n")
		await commit("side1", "side1")
		await git("checkout", "-q", "main")
		await git("merge", "-q", "--no-ff", "-m", "merge-side", "side")
		rev.set("merge", (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim())

		// octopus: three tiny branches merged at once
		for (const n of ["o1", "o2", "o3"]) {
			await git("checkout", "-q", "-b", n, rev.get("merge") as string)
			write(`${n}.txt`, `${n}\n`)
			await commit(n, n)
			await git("checkout", "-q", "main")
		}
		await git("merge", "-q", "-m", "octopus", "o1", "o2", "o3")
		rev.set(
			"octopus",
			(await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim(),
		)

		// criss-cross: A and B each merge the other, then main merges A
		await git("checkout", "-q", "-b", "ccA", rev.get("octopus") as string)
		write("cc-a.txt", "a\n")
		await commit("ccA1", "ccA1")
		await git("checkout", "-q", "-b", "ccB", rev.get("octopus") as string)
		write("cc-b.txt", "b\n")
		await commit("ccB1", "ccB1")
		await git("checkout", "-q", "ccA")
		await git("merge", "-q", "-m", "a-takes-b", "ccB")
		rev.set("ccA2", (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim())
		await git("checkout", "-q", "ccB")
		await git("merge", "-q", "-m", "b-takes-a", rev.get("ccA1") as string)
		rev.set("ccB2", (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim())
		await git("checkout", "-q", "main")
		await git("merge", "-q", "-m", "take-cc", rev.get("ccA2") as string)
		rev.set("cc", (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim())

		// rename: move a whole directory
		await git("mv", "dir", "moved")
		await commit("rename", "rename dir → moved")

		// revert: the tree returns to an ancestor's exact tree
		await git("revert", "--no-edit", rev.get("rename") as string)
		rev.set("revert", (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim())

		// tag on the tip
		await git("tag", "-a", "-m", "release", "v1")
		rev.set(
			"tag",
			(await spawnGit(["rev-parse", "refs/tags/v1"], { cwd: src })).stdout.trim(),
		)

		// an abandoned branch for the rewound-have case (not an ancestor of main)
		await git("checkout", "-q", "-b", "abandoned", rev.get("linear2") as string)
		write("abandoned.txt", "gone\n")
		await commit("abandoned", "abandoned")
		await git("checkout", "-q", "main")

		// an unrelated root for the unrelated-have case
		await git("checkout", "-q", "--orphan", "unrelated")
		await git("rm", "-rfq", "--ignore-unmatch", ".")
		write("unrelated.txt", "island\n")
		await commit("unrelated", "unrelated root")
		await git("checkout", "-q", "main")

		// A keep/<name> branch per named rev: every want/have below is an ADVERTISED
		// ref on both servers (raw-sha wants would need allow-sha1-in-want caps).
		for (const [name, sha] of rev) {
			await git("branch", `keep/${name}`, sha)
		}

		// Everything into pggit over the real wire.
		await spawnGit(
			["push", "-q", pggitUrl, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
			{ cwd: src },
		)
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
	})

	/**
	 * The differential: a client with exactly `have`'s closure (none, when have is
	 * null) fetches `want` from `url`; returns the SET of objects the fetch added.
	 */
	async function fetchedSet(
		url: string,
		want: string,
		have: string | null,
	): Promise<Set<string>> {
		const client = mkdtempSync(join(tmpdir(), "pggit-oracle-client-"))
		try {
			await spawnGit(["init", "-q", client])
			if (have !== null) {
				await spawnGit(
					["-c", "protocol.version=2", "fetch", "-q", url, `${have}:refs/heads/have`],
					{ cwd: client },
				)
			}
			const before = new Set(await allObjectOids(client))
			await spawnGit(["-c", "protocol.version=2", "fetch", "-q", url, want], {
				cwd: client,
			})
			const after = await allObjectOids(client)
			return new Set(after.filter((o) => !before.has(o)))
		} finally {
			rmSync(client, { force: true, recursive: true })
		}
	}

	/** Assert pggit's fetch transfers exactly the set canonical git's does. */
	async function assertPair(wantName: string, haveName: string | null): Promise<void> {
		if (!rev.has(wantName) || (haveName !== null && !rev.has(haveName))) {
			throw new Error(`fixture missing rev ${wantName}/${haveName}`)
		}
		const want = wantName === "tag" ? "refs/tags/v1" : `refs/heads/keep/${wantName}`
		const have = haveName === null ? null : `refs/heads/keep/${haveName}`
		const fromGit = await fetchedSet(src, want, have)
		const fromPggit = await fetchedSet(pggitUrl, want, have)
		const extra = [...fromPggit].filter((o) => !fromGit.has(o)).sort()
		const missing = [...fromGit].filter((o) => !fromPggit.has(o)).sort()
		expect(
			{ extraVsGit: extra, missingVsGit: missing },
			`(want=${wantName}, have=${haveName ?? "∅"})`,
		).toEqual({ extraVsGit: [], missingVsGit: [] })
	}

	it("cold clone (no haves) of the tip", async () => {
		await assertPair("revert", null)
	})

	it("linear advance", async () => {
		await assertPair("linear2", "base")
		await assertPair("linear2", "linear1")
	})

	it("merge tip against one side", async () => {
		await assertPair("merge", "linear2")
		await assertPair("merge", "side1")
	})

	it("octopus tip against each root", async () => {
		await assertPair("octopus", "merge")
		await assertPair("octopus", "o2")
	})

	it("criss-cross tips against each other", async () => {
		await assertPair("ccA2", "ccB1")
		await assertPair("cc", "ccB2")
	})

	it("rename: post-move tip against pre-move have", async () => {
		await assertPair("rename", "cc")
	})

	it("revert: the tip's tree equals an ancestor tree the client holds", async () => {
		await assertPair("revert", "rename")
		await assertPair("revert", "cc")
	})

	it("tag want against a commit have", async () => {
		await assertPair("tag", "octopus")
	})

	it("rewound have: the have is not an ancestor of the want", async () => {
		await assertPair("revert", "abandoned")
	})

	it("unrelated-root have: no common history at all", async () => {
		await assertPair("revert", "unrelated")
	})

	// ── Store-level cases the wire cannot express as cleanly. ──

	it("an exact blob want is served alone (the promisor rule)", async () => {
		const blobOid = (
			await spawnGit(["rev-parse", `${rev.get("revert")}:a.txt`], { cwd: src })
		).stdout.trim()
		const pack = await objects.buildPack(REPO, [blobOid], [rev.get("cc") as string], true)
		const parsed = await readPack(pack, async () => null)
		expect(parsed.map((o) => computeOid(o.type, o.content))).toEqual([blobOid])
	})

	it("a present-but-orphaned parent region (NULL generations) serves exactly git's set", async () => {
		// An orphan commit lands via the store (denied-push residue: object present,
		// no ref, NULL generation), then a wire push builds real history on top of
		// it. The want's history now crosses a NULL-generation region.
		const orphanDir = join(root, "orphan-src")
		await spawnGit(["init", "-q", "-b", "main", orphanDir])
		writeFileSync(join(orphanDir, "o.txt"), "orphan\n")
		await spawnGit(["add", "-A"], { cwd: orphanDir })
		await spawnGit(["commit", "-q", "-m", "orphan-base"], { cwd: orphanDir })
		writeFileSync(join(orphanDir, "o.txt"), "tip\n")
		await spawnGit(["commit", "-q", "-am", "tip"], { cwd: orphanDir })
		const orphanBase = (
			await spawnGit(["rev-parse", "HEAD~1"], { cwd: orphanDir })
		).stdout.trim()
		const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: orphanDir })).stdout.trim()

		const orphanRepo = "oracle-orphan"
		// 1. The TIP commit arrives ALONE — its parent is absent at ingest, so its
		//    generation derives NULL, absorbing (denied-push residue shape).
		const all = await loadAllObjects(orphanDir)
		const tipOnly = all.filter(
			(o) => o.type === "commit" && computeOid(o.type, o.content) === tip,
		)
		expect(tipOnly).toHaveLength(1)
		await objects.putPack(orphanRepo, tipOnly)
		// 2. The full history lands over the wire; the tip's row STAYS NULL.
		const url = `http://127.0.0.1:${server.port}/${orphanRepo}`
		await spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: orphanDir })
		await spawnGit(["push", "-q", url, `${orphanBase}:refs/heads/keep-base`], {
			cwd: orphanDir,
		})
		await spawnGit(["branch", "keep-base", orphanBase], { cwd: orphanDir })

		const fromGit = await fetchedSet(orphanDir, "refs/heads/main", "refs/heads/keep-base")
		const fromPggit = await fetchedSet(url, "refs/heads/main", "refs/heads/keep-base")
		expect([...fromPggit].sort()).toEqual([...fromGit].sort())
	})
})

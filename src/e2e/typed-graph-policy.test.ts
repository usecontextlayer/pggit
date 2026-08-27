/** Except for TPC-2's deliberate boundary variant, fixtures that exercise in-walk tag classification keep the annotated tag off every ref tip because a tip takes the boundary path instead. TPC-1..6 are specified in `docs/2026-08-27-df-composite-and-tag-parent-design.md`. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps, type GitDeps } from "@/index"
import { computeOid } from "@/object/object"
import type { PackInputObject } from "@/pack/write-pack"
import { WantNotFoundError } from "@/protocol/errors"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { allRefsOf, writeLiteralGitObject } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack, ZERO_OID } from "@/testing/pkt-oracle"
import { attemptGit, type GitAttempt, spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"
import { fetchRequest } from "@/testing/wire-fetch"
import { postReceivePack, receivePackRequest } from "@/testing/wire-receive"

const REPO = "policy/typed"

/** A unique label keeps fixture oids disjoint because the corruption cases delete derived rows without a repo-id predicate. */
function createTagParentFixture(label: string) {
	const blob = Buffer.from(`${label}\n`)
	const blobOid = computeOid("blob", blob)
	const tree = Buffer.concat([Buffer.from("100644 f\0"), Buffer.from(blobOid, "hex")])
	const treeOid = computeOid("tree", tree)
	const target = Buffer.from(
		`tree ${treeOid}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n\n${label}-target\n`,
	)
	const targetOid = computeOid("commit", target)
	const tag = Buffer.from(
		`object ${targetOid}\ntype commit\ntag ${label}\ntagger t <t@t> 1700000001 +0000\n\n${label}\n`,
	)
	const tagOid = computeOid("tag", tag)
	const malformedCommit = Buffer.from(
		`tree ${treeOid}\nparent ${tagOid}\nauthor t <t@t> 1700000002 +0000\ncommitter t <t@t> 1700000002 +0000\n\n${label}-bad\n`,
	)
	const malformedCommitOid = computeOid("commit", malformedCommit)
	const objects: PackInputObject[] = [
		{ content: blob, type: "blob" },
		{ content: tree, type: "tree" },
		{ content: target, type: "commit" },
		{ content: tag, type: "tag" },
		{ content: malformedCommit, type: "commit" },
	]
	return { malformedCommit, malformedCommitOid, objects, tag, tagOid, target, targetOid }
}

/** Receive failures are oracle outcomes, so preserve their report instead of throwing. */
async function oracleReceive(
	bare: string,
	body: Buffer,
): Promise<GitAttempt & { report: string }> {
	const outcome = await attemptGit(["receive-pack", "--stateless-rpc", bare], bare, body)
	return {
		...outcome,
		report: outcome.ok
			? pktLineUnpack(Buffer.from(outcome.stdout, "utf8"))
			: `${outcome.stdout}\n${outcome.stderr}`,
	}
}

async function writeOracleObjects(
	bare: string,
	objects: readonly PackInputObject[],
): Promise<string[]> {
	const oids: string[] = []
	for (const object of objects) {
		const oid = await writeLiteralGitObject(bare, object)
		const expected = computeOid(object.type, object.content)
		if (oid !== expected) {
			throw new Error(`canonical git assigned ${oid} to fixture object ${expected}`)
		}
		oids.push(oid)
	}
	return oids
}

/** Build the fixture pack with canonical git so the oracle does not share pggit's serializer. */
async function literalGitPack(objects: readonly PackInputObject[]): Promise<Buffer> {
	return withTempDir("pggit-typed-pack-source-", async (source) => {
		await spawnGit(["init", "-q", "--bare", source])
		const oids = await writeOracleObjects(source, objects)
		return (
			await spawnGit(["pack-objects", "--stdout"], {
				cwd: source,
				input: `${oids.join("\n")}\n`,
			})
		).stdoutBytes
	})
}

describe("typed-graph policy", () => {
	let db: IsolatedDb
	let deps: GitDeps
	let app: ReturnType<typeof createGitApp>
	let server: GitServer
	let src = ""
	let url = ""
	let blobOid = ""
	let treeOid = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		deps = createGitDeps(db.sql)
		app = createGitApp(deps)
		server = await serveOnPort(app, 0)
		url = `http://127.0.0.1:${server.port}/${REPO}`
		src = mkdtempSync(join(tmpdir(), "pggit-typed-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "f.txt"), "hello\n")
		await spawnGit(["add", "f.txt"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		blobOid = (await spawnGit(["rev-parse", "HEAD:f.txt"], { cwd: src })).stdout.trim()
		treeOid = (await spawnGit(["rev-parse", "HEAD^{tree}"], { cwd: src })).stdout.trim()
		await spawnGit(["push", "-q", url, "HEAD:refs/heads/main"], { cwd: src })
	}, 120_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("rejects a blob or tree pushed to refs/heads/* — and accepts them under refs/tags/*", async () => {
		for (const bad of [blobOid, treeOid]) {
			const denied = await attemptGit(["push", url, `${bad}:refs/heads/nontip`], src)
			expect(denied.ok).toBe(false)
			expect(denied.stderr).toContain("invalid new value provided")
		}
		// The same objects are legal tag targets (git's rule, matched exactly).
		await spawnGit(["push", "-q", url, `${blobOid}:refs/tags/blobtag`], { cwd: src })
		await spawnGit(["push", "-q", url, `${treeOid}:refs/tags/treetag`], { cwd: src })
	})

	it("a commit whose tree header names a BLOB fails connectivity and cannot be served", async () => {
		const content = Buffer.from(
			`tree ${blobOid}\ncommitter t <t@t> 1700000000 +0000\n\nmistyped\n`,
		)
		const oid = computeOid("commit", content)
		await deps.objects.putPack(REPO, [{ content, type: "commit" }])
		expect(await deps.objects.isConnected(REPO, oid)).toBe(false)
		await expect(deps.objects.buildPack(REPO, [oid], [], false)).rejects.toThrow(
			WantNotFoundError,
		)
	})

	it("a 40000 tree entry naming a BLOB fails connectivity for its commit", async () => {
		const entry = Buffer.concat([Buffer.from("40000 sub\0"), Buffer.from(blobOid, "hex")])
		const badTreeOid = computeOid("tree", entry)
		const commit = Buffer.from(
			`tree ${badTreeOid}\ncommitter t <t@t> 1700000000 +0000\n\nmistyped-sub\n`,
		)
		const commitOid = computeOid("commit", commit)
		await deps.objects.putPack(REPO, [
			{ content: entry, type: "tree" },
			{ content: commit, type: "commit" },
		])
		expect(await deps.objects.isConnected(REPO, commitOid)).toBe(false)
	})

	it("a parent whose derived row is MISSING crashes loud — corruption, never a sweepable miss", async () => {
		// Judged as a typed-edge "missing", a reachable parent with a missing derived row would be EXCLUDED from
		// GC's live set and swept — corruption converted into data loss. It must
		// crash the walk instead, in connectivity AND in the GC pass.
		const repo = "policy/corrupt"
		const parent = Buffer.from(
			`tree ${treeOid}\ncommitter t <t@t> 1700000000 +0000\n\np\n`,
		)
		const parentOid = computeOid("commit", parent)
		const child = Buffer.from(
			`tree ${treeOid}\nparent ${parentOid}\ncommitter t <t@t> 1700000001 +0000\n\nc\n`,
		)
		const childOid = computeOid("commit", child)
		// Seed the shared tree+blob closure first, then the two commits.
		const blob = Buffer.from("hello\n")
		const tree = Buffer.concat([
			Buffer.from("100644 f.txt\0"),
			Buffer.from(blobOid, "hex"),
		])
		await deps.objects.putPack(repo, [
			{ content: blob, type: "blob" },
			{ content: tree, type: "tree" },
			{ content: parent, type: "commit" },
			{ content: child, type: "commit" },
		])
		await deps.refs.setRef(repo, "refs/heads/main", childOid)
		// Surgical corruption: the parent's derived row vanishes.
		await db.sql`delete from git_commit where oid = ${Buffer.from(parentOid, "hex")}`

		await expect(deps.objects.isConnected(repo, childOid)).rejects.toThrow(
			/no derived row/,
		)
		await expect(deps.objects.isAncestor(repo, parentOid, childOid)).rejects.toThrow(
			/no derived row/,
		)
		await expect(createGc(db.sql).gc(repo, { graceSeconds: 0 })).rejects.toThrow(
			/no derived row/,
		)
		// And nothing was swept by the failed pass.
		const [row] = await db.sql<{ n: string }[]>`
			select count(*)::text as n from git_object
			where oid = ${Buffer.from(parentOid, "hex")}`
		if (row === undefined) throw new Error("object count query returned no row")
		expect(row.n).toBe("1")
	})

	it("a tag whose derived row is missing crashes peeling and include-tag augmentation", async () => {
		const repo = "policy/corrupt-tag"
		const blob = Buffer.from("hello\n")
		const tree = Buffer.concat([
			Buffer.from("100644 f.txt\0"),
			Buffer.from(computeOid("blob", blob), "hex"),
		])
		const commit = Buffer.from(
			`tree ${computeOid("tree", tree)}\ncommitter t <t@t> 1700000000 +0000\n\nc\n`,
		)
		const commitOid = computeOid("commit", commit)
		const tag = Buffer.from(
			`object ${commitOid}\ntype commit\ntag broken\ntagger t <t@t> 1700000001 +0000\n\nbroken\n`,
		)
		const tagOid = computeOid("tag", tag)
		await deps.objects.putPack(repo, [
			{ content: blob, type: "blob" },
			{ content: tree, type: "tree" },
			{ content: commit, type: "commit" },
			{ content: tag, type: "tag" },
		])
		await deps.refs.setRef(repo, "refs/tags/original", tagOid)
		await db.sql`delete from git_tag where oid = ${Buffer.from(tagOid, "hex")}`

		await expect(deps.refs.setRef(repo, "refs/tags/copy", tagOid)).rejects.toThrow(
			/no derived row/,
		)
		await expect(
			deps.objects.buildPack(repo, [commitOid], [], false, true),
		).rejects.toThrow(/no derived row/)
	})

	it("a blob-mode tree entry naming a TREE fails connectivity for its commit", async () => {
		const entry = Buffer.concat([Buffer.from("100644 f\0"), Buffer.from(treeOid, "hex")])
		const badTreeOid = computeOid("tree", entry)
		const commit = Buffer.from(
			`tree ${badTreeOid}\ncommitter t <t@t> 1700000000 +0000\n\nmistyped-blob\n`,
		)
		const commitOid = computeOid("commit", commit)
		await deps.objects.putPack(REPO, [
			{ content: entry, type: "tree" },
			{ content: commit, type: "commit" },
		])
		expect(await deps.objects.isConnected(REPO, commitOid)).toBe(false)
	})

	it("TPC-1: pushing a commit whose parent is a TAG is a per-ref rejection on both remotes, never a 500", async () => {
		const fixture = createTagParentFixture("tp1")
		const body = receivePackRequest(
			[`${ZERO_OID} ${fixture.malformedCommitOid} refs/heads/tp1\0report-status`],
			await literalGitPack(fixture.objects),
		)
		const res = await postReceivePack(app, "policy/tp1", body)
		expect(res.status).toBe(200)
		const report = pktLineUnpack(res.body)
		expect(report).toContain("ng refs/heads/tp1 missing necessary objects")
		expect(await deps.refs.listRefs("policy/tp1")).toEqual([])
		for (const oid of [fixture.malformedCommitOid, fixture.tagOid]) {
			expect(await deps.objects.hasObject("policy/tp1", oid), oid).toBe(true)
		}
		await withTempDir("pggit-typed-tp1-", async (bare) => {
			await spawnGit(["init", "-q", "--bare", bare])
			const oracle = await oracleReceive(bare, body)
			console.log(
				`[TPC-1 oracle] exit=${oracle.code} report=${oracle.report.replace(/\n/g, " | ")}`,
			)
			expect(oracle.report).toContain("ng refs/heads/tp1 missing necessary objects")
			expect(await allRefsOf(bare)).toEqual([])
		})
	}, 120_000)

	it("TPC-1 variant: the tag pre-stored and UNREFERENCED, only the malformed commit in the pack", async () => {
		const fixture = createTagParentFixture("tp1v")
		const prerequisites = fixture.objects.filter(
			(object) => object.content !== fixture.malformedCommit,
		)
		await deps.objects.putPack("policy/tp1v", prerequisites)
		const body = receivePackRequest(
			[`${ZERO_OID} ${fixture.malformedCommitOid} refs/heads/tp1v\0report-status`],
			await literalGitPack([{ content: fixture.malformedCommit, type: "commit" }]),
		)
		const res = await postReceivePack(app, "policy/tp1v", body)
		expect(res.status).toBe(200)
		expect(pktLineUnpack(res.body)).toContain(
			"ng refs/heads/tp1v missing necessary objects",
		)
		expect(await deps.refs.listRefs("policy/tp1v")).toEqual([])
		for (const oid of [fixture.malformedCommitOid, fixture.tagOid]) {
			expect(await deps.objects.hasObject("policy/tp1v", oid), oid).toBe(true)
		}
		await withTempDir("pggit-typed-tp1v-", async (bare) => {
			await spawnGit(["init", "-q", "--bare", bare])
			await writeOracleObjects(bare, prerequisites)
			const oracle = await oracleReceive(bare, body)
			console.log(
				`[TPC-1v oracle] exit=${oracle.code} report=${oracle.report.replace(/\n/g, " | ")}`,
			)
			expect(oracle.report).toContain("ng refs/heads/tp1v missing necessary objects")
			expect(await allRefsOf(bare)).toEqual([])
		})
	}, 120_000)

	it("TPC-2: the boundary variant — the tag is an existing ref TIP — keeps its clean rejection", async () => {
		const fixture = createTagParentFixture("tp2")
		const prerequisites = fixture.objects.filter(
			(object) => object.content !== fixture.malformedCommit,
		)
		await deps.objects.putPack("policy/tp2", prerequisites)
		await deps.refs.setRef("policy/tp2", "refs/tags/anchor", fixture.tagOid)
		const body = receivePackRequest(
			[`${ZERO_OID} ${fixture.malformedCommitOid} refs/heads/tp2\0report-status`],
			await literalGitPack([{ content: fixture.malformedCommit, type: "commit" }]),
		)
		const res = await postReceivePack(app, "policy/tp2", body)
		expect(res.status).toBe(200)
		const report = pktLineUnpack(res.body)
		expect(report).toContain("ng refs/heads/tp2")
		expect((await deps.refs.listRefs("policy/tp2")).map((ref) => ref.name)).toEqual([
			"refs/tags/anchor",
		])
		expect(await deps.objects.hasObject("policy/tp2", fixture.malformedCommitOid)).toBe(
			true,
		)
		await withTempDir("pggit-typed-tp2-", async (bare) => {
			await spawnGit(["init", "-q", "--bare", bare])
			await writeOracleObjects(bare, prerequisites)
			await spawnGit(["update-ref", "refs/tags/anchor", fixture.tagOid], { cwd: bare })
			const oracle = await oracleReceive(bare, body)
			console.log(
				`[TPC-2 oracle] exit=${oracle.code} report=${oracle.report.replace(/\n/g, " | ")}`,
			)
			expect(oracle.report).toBe(report)
			expect((await allRefsOf(bare)).map((ref) => ref.name)).toEqual(["refs/tags/anchor"])
		})
	}, 120_000)

	it("TPC-3: denied-push residue whose parent names a TAG cannot be served", async () => {
		const fixture = createTagParentFixture("tp3")
		const pushBody = receivePackRequest(
			[`${ZERO_OID} ${fixture.malformedCommitOid} refs/heads/tp3\0report-status`],
			await literalGitPack(fixture.objects),
		)
		const pushResponse = await postReceivePack(app, "policy/tp3", pushBody)
		expect(pushResponse.status).toBe(200)
		expect(pktLineUnpack(pushResponse.body)).toContain(
			"ng refs/heads/tp3 missing necessary objects",
		)
		expect(await deps.refs.listRefs("policy/tp3")).toEqual([])
		for (const oid of [fixture.malformedCommitOid, fixture.tagOid]) {
			expect(await deps.objects.hasObject("policy/tp3", oid), oid).toBe(true)
		}
		expect(await deps.objects.isConnected("policy/tp3", fixture.malformedCommitOid)).toBe(
			false,
		)
		const request = fetchRequest({
			done: true,
			objectFormat: "sha1",
			wants: [fixture.malformedCommitOid],
		})
		const response = await app.request("/policy/tp3/git-upload-pack", {
			body: request,
			headers: { "Git-Protocol": "version=2" },
			method: "POST",
		})
		expect(response.status).toBe(200)
		const report = pktLineUnpack(Buffer.from(await response.arrayBuffer()))
		await withTempDir("pggit-typed-tp3-", async (bare) => {
			await spawnGit(["init", "-q", "--bare", bare])
			const receive = await oracleReceive(bare, pushBody)
			expect(receive.report).toContain("ng refs/heads/tp3 missing necessary objects")
			expect(await allRefsOf(bare)).toEqual([])
			await writeOracleObjects(bare, fixture.objects)
			expect(
				(await spawnGit(["cat-file", "-t", fixture.malformedCommitOid], { cwd: bare }))
					.stdout,
			).toBe("commit\n")
			// The transcripts deliberately differ: pggit returns an in-band ERR, while canonical git reaches a nonzero exit without one.
			const oracle = await attemptGit(
				["upload-pack", "--stateless-rpc", bare],
				bare,
				request,
			)
			expect(oracle.ok).toBe(false)
			expect(oracle.stdout).not.toContain("ERR")
			expect(report).toContain("ERR upload-pack: not our ref")
		})
	})

	it("TPC-4: GC over a reachable tag-parent shape completes, keeps the pair, withholds the epoch", async () => {
		const fixture = createTagParentFixture("tp4")
		await deps.objects.putPack("policy/tp4", fixture.objects)
		await deps.refs.setRef("policy/tp4", "refs/heads/main", fixture.malformedCommitOid)
		const result = await createGc(db.sql).gc("policy/tp4", { graceSeconds: 0 })
		expect(result.epoch).toBe("cleared")
		for (const oid of [fixture.tagOid, fixture.targetOid]) {
			expect(await deps.objects.hasObject("policy/tp4", oid), oid).toBe(true)
		}
		expect(await createGc(db.sql).gc("policy/tp4", { graceSeconds: 0 })).toEqual({
			deletedObjects: 0,
			epoch: "cleared",
		})
		for (const oid of [fixture.tagOid, fixture.targetOid]) {
			expect(await deps.objects.hasObject("policy/tp4", oid), oid).toBe(true)
		}
	})

	it("TPC-4 overlap: GC still withholds the epoch when the tag is also reached through a valid tag chain", async () => {
		const repo = "policy/tp4-overlap"
		const fixture = createTagParentFixture("tp4-overlap")
		const outerTag = Buffer.from(
			`object ${fixture.tagOid}\ntype tag\ntag outer\ntagger t <t@t> 1700000004 +0000\n\nouter\n`,
		)
		const outerTagOid = computeOid("tag", outerTag)
		await deps.objects.putPack(repo, [
			...fixture.objects,
			{ content: outerTag, type: "tag" },
		])
		await deps.refs.setRef(repo, "refs/heads/main", fixture.malformedCommitOid)
		await deps.refs.setRef(repo, "refs/tags/outer", outerTagOid)
		const result = await createGc(db.sql).gc(repo, { graceSeconds: 0 })
		expect(result.epoch).toBe("cleared")
		for (const oid of [outerTagOid, fixture.tagOid, fixture.targetOid]) {
			expect(await deps.objects.hasObject(repo, oid), oid).toBe(true)
		}
	})

	it("TPC-4 object overlap: GC retains one tag reached as both a parent and a tree entry", async () => {
		const repo = "policy/tp4-object-overlap"
		const fixture = createTagParentFixture("tp4-object-overlap")
		const tagEntryTree = Buffer.concat([
			Buffer.from("100644 t\0"),
			Buffer.from(fixture.tagOid, "hex"),
		])
		const tagEntryTreeOid = computeOid("tree", tagEntryTree)
		await deps.objects.putPack(repo, [
			...fixture.objects,
			{ content: tagEntryTree, type: "tree" },
		])
		await deps.refs.setRef(repo, "refs/heads/main", fixture.malformedCommitOid)
		await deps.refs.setRef(repo, "refs/tags/tree-root", tagEntryTreeOid)
		const result = await createGc(db.sql).gc(repo, { graceSeconds: 0 })
		expect(result.epoch).toBe("cleared")
		for (const oid of [fixture.tagOid, fixture.targetOid]) {
			expect(await deps.objects.hasObject(repo, oid), oid).toBe(true)
		}
	})

	it("TPC-6: a tree entry naming a TAG — GC keeps the tag AND its target (the sibling shape)", async () => {
		const fixture = createTagParentFixture("tp6")
		const tagEntryTree = Buffer.concat([
			Buffer.from("100644 t\0"),
			Buffer.from(fixture.tagOid, "hex"),
		])
		const tagEntryTreeOid = computeOid("tree", tagEntryTree)
		const tip = Buffer.from(
			`tree ${tagEntryTreeOid}\nauthor t <t@t> 1700000003 +0000\ncommitter t <t@t> 1700000003 +0000\n\ntp6-tip\n`,
		)
		const tipOid = computeOid("commit", tip)
		await deps.objects.putPack("policy/tp6", [
			...fixture.objects.filter((object) => object.content !== fixture.malformedCommit),
			{ content: tagEntryTree, type: "tree" },
			{ content: tip, type: "commit" },
		])
		await deps.refs.setRef("policy/tp6", "refs/heads/main", tipOid)
		const result = await createGc(db.sql).gc("policy/tp6", { graceSeconds: 0 })
		expect(result.epoch).toBe("cleared")
		for (const oid of [fixture.tagOid, fixture.targetOid]) {
			expect(await deps.objects.hasObject("policy/tp6", oid), oid).toBe(true)
		}
	})

	it("TPC-5: a tag-parent whose git_tag row is GONE still crashes loud — genuine corruption", async () => {
		const fixture = createTagParentFixture("tp5")
		await deps.objects.putPack("policy/tp5", fixture.objects)
		await db.sql`delete from git_tag where oid = ${Buffer.from(fixture.tagOid, "hex")}`
		await expect(
			deps.objects.isConnected("policy/tp5", fixture.malformedCommitOid),
		).rejects.toThrow(/no derived row/)
		await expect(
			deps.objects.buildPack("policy/tp5", [fixture.malformedCommitOid], [], false),
		).rejects.toThrow(/no derived row/)
	})
})

/**
 * §5.1 / invariant §10.2 — ingest rejects what `git fsck` rejects. Three structural
 * violations the OID-wellformedness and tree-structure checks miss: a commit
 * carrying more than one `tree` header, an annotated tag with no `object` header,
 * and a tag carrying two. The observable contract is the push outcome: the
 * malformed object is refused at unpack and the ref is never created — exactly what
 * a client experiences pushing to a server that fscks. Every prerequisite object is
 * present, so the malformedness is the SOLE reason for rejection.
 *
 * PARITY IS MEASURED, NOT REMEMBERED: each case also puts the identical bytes into
 * a real repo (`git hash-object --literally` is what lets git store a malformed
 * object at all) and reads canonical `git fsck --strict`'s verdict. Without that,
 * the file's headline claim rests on recall, and an OVER-rejection — pggit refusing
 * something git accepts — would be invisible here.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { computeOid } from "@/object/object"
import { writePack } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"
import { attemptGit, spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** A receive-pack POST body that pushes `objects` and points `refs/heads/<branch>`
 * at `newOid` (a create, oldOid = zero). */
function pushBody(
	newOid: string,
	branch: string,
	objects: { type: "blob" | "commit" | "tag" | "tree"; content: Buffer }[],
): Buffer {
	return Buffer.concat([
		encodePktLine(Buffer.from(`${ZERO} ${newOid} refs/heads/${branch}\0report-status`)),
		encodePkt({ type: "flush" }),
		writePack(objects),
	])
}

/**
 * Canonical git's verdict on the same bytes: store them in a throwaway repo (with
 * their prerequisites, so nothing else in the repo is faulty) and run `git fsck
 * --strict`. Returns the object's oid alongside git's exit code and diagnosis.
 */
async function gitFsckVerdict(
	malformed: { type: "commit" | "tag"; content: Buffer },
	prerequisites: { type: "blob" | "tree"; content: Buffer }[] = [],
): Promise<{ code: number; oid: string; out: string }> {
	const dir = mkdtempSync(join(tmpdir(), "pggit-fsck-oracle-"))
	try {
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		const write = async (type: string, content: Buffer): Promise<string> =>
			(
				await spawnGit(["hash-object", "-w", "-t", type, "--literally", "--stdin"], {
					cwd: dir,
					input: content,
				})
			).stdout.trim()
		for (const p of prerequisites) await write(p.type, p.content)
		const oid = await write(malformed.type, malformed.content)
		const fsck = await attemptGit(["fsck", "--strict"], dir)
		return { code: fsck.code, oid, out: `${fsck.stdout}${fsck.stderr}` }
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

/** git rejected these exact bytes too — the parity claim, per case. */
function expectGitRejects(verdict: { code: number; oid: string; out: string }): void {
	expect(
		verdict.code,
		`git fsck ACCEPTED these bytes — pggit is rejecting what canonical git allows:\n${verdict.out}`,
	).not.toBe(0)
	expect(verdict.out).toMatch(new RegExp(`error[^\\n]*${verdict.oid}`))
}

describe("M2 — ingest rejects fsck-malformed objects", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
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

	it("refuses a commit with two tree headers and leaves the ref unset", async () => {
		// First tree = the (real, present) empty tree, so connectivity passes; the
		// second tree header is the fsck violation.
		const content = Buffer.from(
			`tree ${EMPTY_TREE}\ntree ${"b".repeat(40)}\n` +
				"author a <a> 0 +0000\ncommitter a <a> 0 +0000\n\ntwo trees\n",
			"latin1",
		)
		expectGitRejects(
			await gitFsckVerdict({ content, type: "commit" }, [
				{ content: Buffer.alloc(0), type: "tree" },
			]),
		)

		const newOid = computeOid("commit", content)
		const body = pushBody(newOid, "twotrees", [
			{ content: Buffer.alloc(0), type: "tree" }, // the empty tree (present)
			{ content, type: "commit" },
		])
		const res = await app.request("/r/git-receive-pack", {
			body: new Uint8Array(body),
			method: "POST",
		})
		expect(res.status).toBe(200)
		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(report).not.toContain("unpack ok")
		expect(report).toContain("ng refs/heads/twotrees")
		expect(
			(await refs.listRefs("r")).find((r) => r.name === "refs/heads/twotrees"),
		).toBeUndefined()
	})

	it("refuses an annotated tag with no object header and leaves the ref unset", async () => {
		const content = Buffer.from(
			"type commit\ntag v1\ntagger a <a> 0 +0000\n\nno object header\n",
			"latin1",
		)
		expectGitRejects(await gitFsckVerdict({ content, type: "tag" }))

		const newOid = computeOid("tag", content)
		const body = pushBody(newOid, "badtag", [{ content, type: "tag" }])
		const res = await app.request("/r2/git-receive-pack", {
			body: new Uint8Array(body),
			method: "POST",
		})
		expect(res.status).toBe(200)
		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(report).not.toContain("unpack ok")
		expect(report).toContain("ng refs/heads/badtag")
		expect(
			(await refs.listRefs("r2")).find((r) => r.name === "refs/heads/badtag"),
		).toBeUndefined()
	})

	it("refuses an annotated tag with two object headers and leaves the ref unset", async () => {
		// Both targets are present, so connectivity passes; the two divergent object
		// headers are the sole fsck violation (git fsck: a tag has exactly one object).
		const b1 = Buffer.from("target one\n")
		const b2 = Buffer.from("target two\n")
		const content = Buffer.from(
			`object ${computeOid("blob", b1)}\nobject ${computeOid("blob", b2)}\n` +
				"type blob\ntag dbl\ntagger a <a> 0 +0000\n\ntwo objects\n",
			"latin1",
		)
		expectGitRejects(
			await gitFsckVerdict({ content, type: "tag" }, [
				{ content: b1, type: "blob" },
				{ content: b2, type: "blob" },
			]),
		)

		const newOid = computeOid("tag", content)
		const body = pushBody(newOid, "dbltag", [
			{ content: b1, type: "blob" },
			{ content: b2, type: "blob" },
			{ content, type: "tag" },
		])
		const res = await app.request("/r3/git-receive-pack", {
			body: new Uint8Array(body),
			method: "POST",
		})
		expect(res.status).toBe(200)
		const report = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(report).not.toContain("unpack ok")
		expect(report).toContain("ng refs/heads/dbltag")
		expect(
			(await refs.listRefs("r3")).find((r) => r.name === "refs/heads/dbltag"),
		).toBeUndefined()
	})
})

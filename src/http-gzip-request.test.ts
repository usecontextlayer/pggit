import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import type { GitObjectType } from "@/object"
import { createObjectStore } from "@/object-store"
import type { PackInputObject } from "@/pack/write-pack"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore } from "@/refs-store"
import { type GitServer, serveOnPort } from "@/server"
import type { IsolatedDb } from "@/testing/pg"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

async function loadAllObjects(dir: string): Promise<PackInputObject[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"],
		{ cwd: dir },
	)
	const objs: PackInputObject[] = []
	for (const line of list.stdout.trim().split("\n")) {
		const [oid, type] = line.split(" ")
		if (!oid || !type) continue
		const raw = await spawnGit(["cat-file", type, oid], { cwd: dir })
		objs.push({ content: raw.stdoutBytes, type: type as GitObjectType })
	}
	return objs
}

async function allObjectOids(dir: string): Promise<string[]> {
	const list = await spawnGit(
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
		{ cwd: dir },
	)
	return list.stdout.trim().split("\n").sort()
}

// A minimal, valid v2 `ls-refs` request (command + delim + flush, no args → list
// every ref). Built from our own pkt-line encoders so the gzip cases test the
// transport, not a hand-authored byte string.
const LS_REFS_REQUEST = Buffer.concat([
	encodePktLine(Buffer.from("command=ls-refs\n")),
	encodePkt({ type: "delim" }),
	encodePkt({ type: "flush" }),
])

function postUploadPack(
	port: number,
	body: Buffer,
	contentEncoding?: string,
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/x-git-upload-pack-request",
		"git-protocol": "version=2",
	}
	if (contentEncoding) headers["content-encoding"] = contentEncoding
	return fetch(`http://127.0.0.1:${port}/repo1/git-upload-pack`, {
		body,
		headers,
		method: "POST",
	})
}

// git gzip-compresses the upload-pack *fetch* request (Content-Encoding: gzip)
// once it carries enough `want` lines. A clone wants one per advertised ref, so
// fanning out many refs at the tip pushes the request past git's compression
// threshold — the smart-HTTP transport detail single-ref m0/m1 clones never hit.
const REF_COUNT = 64

describe("smart-HTTP — request body Content-Encoding (gzip)", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let server: GitServer
	let src: string

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)

		src = mkdtempSync(join(tmpdir(), "pggit-gzip-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "alpha\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "c1"], { cwd: src })
		for (let i = 0; i < REF_COUNT; i++) {
			await spawnGit(["branch", `b${i}`], { cwd: src })
		}

		await objects.putPack("repo1", await loadAllObjects(src))
		const showRef = await spawnGit(["show-ref"], { cwd: src })
		for (const line of showRef.stdout.trim().split("\n")) {
			const [oid, name] = line.split(" ")
			if (oid && name) await refs.setRef("repo1", name, oid)
		}
		const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()
		await refs.setSymref("repo1", "HEAD", head)

		server = await serveOnPort(createGitApp({ objects, refs }), 0)
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		await container?.stop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	// End-to-end: real git clones a many-ref repo, which makes git gzip the fetch
	// request. The original bug (server fed the gzip body to the pkt-line parser)
	// surfaced here as HTTP 500 "expected 'packfile'".
	it("real git clones a many-ref repo (gzipped fetch request) cleanly", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-gzip-dest-"))
		try {
			await spawnGit([
				"clone",
				"-c",
				"protocol.version=2",
				"--quiet",
				`http://127.0.0.1:${server.port}/repo1`,
				dest,
			])
			await spawnGit(["fsck", "--full"], { cwd: dest })
			expect(await allObjectOids(dest)).toEqual(await allObjectOids(src))
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})

	// Deterministic: a manually gzip-compressed request body must be decoded and
	// served (does not depend on git's opaque compression threshold).
	it("decodes a gzip-compressed request body", async () => {
		const res = await postUploadPack(server.port, gzipSync(LS_REFS_REQUEST), "gzip")
		expect(res.status).toBe(200)
		const text = Buffer.from(await res.arrayBuffer()).toString("utf8")
		expect(text).toContain("refs/heads/main")
	})

	// Guard the un-encoded path: the new decode boundary must not break identity bodies.
	it("still serves an uncompressed (identity) request body", async () => {
		const res = await postUploadPack(server.port, LS_REFS_REQUEST)
		expect(res.status).toBe(200)
		const text = Buffer.from(await res.arrayBuffer()).toString("utf8")
		expect(text).toContain("refs/heads/main")
	})

	// Fail loud: an encoding we do not implement must be rejected, never fed raw
	// to the pkt-line parser as if it were plaintext. It is a client-caused error
	// (a `GitProtocolError`), so the boundary returns a clean 400, not a 500.
	it("rejects an unsupported Content-Encoding with a clean 400", async () => {
		const res = await postUploadPack(server.port, gzipSync(LS_REFS_REQUEST), "deflate")
		expect(res.status).toBe(400)
	})
})

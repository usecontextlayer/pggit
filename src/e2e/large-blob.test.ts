/**
 * Large blobs past V8's maximum string length (0x1fffffe8 ≈ 512M chars) — the
 * ingest and the serve halves of one contract, over one fixture.
 *
 * A blob whose raw inflated content exceeds ~256MiB cannot round-trip through the
 * porsager driver's TEXT wire form for `bytea` (`'\x' + hex`, DOUBLE the byte
 * length): the string exceeds V8's hard cap. Both directions must therefore move
 * the bytes AS bytes — ingest writes raw (binary COPY), and serve reads the value
 * back in chunks rather than as one decoded string. Postgres itself takes `bytea`
 * to ~1GB and canonical git stores blobs this size happily, so anything smaller
 * than this is pggit refusing what git accepts.
 *
 * THE CONTRACT: canonical git creates and pushes the blob, the ref lands, then a
 * fresh canonical-git repository fetches the tag and is fsck-clean with exactly
 * that one object, of type blob and the original byte length. This observes both
 * wire directions from the client side without asking pggit's own pack encoder or
 * parser to certify pggit's result.
 *
 * The ref is a TAG: tags legally hold ANY object type (canonical git accepts a
 * blob-tipped tag), which isolates the string-cap subject from the
 * branch-tips-must-be-commits policy without faking a commit wrapper.
 *
 * ORIGINATED as two breakage probes over the same shape — a07 (INGEST: the push
 * came back with an unpacker error and no ref) and blb01 (SERVE: the blob stored
 * but every fetch died with `RPC failed; HTTP 500`, i.e. write-only storage). Both
 * fixed; merged into one describe because two byte-identical 270MB fixtures were
 * paying twice for one shape.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { allObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const TAG = "huge"
/** 270_000_000 bytes > 0x1fffffe8 / 2 ≈ 268_435_443, so this value's hex text form
 * — in EITHER direction — exceeds V8's max string length. */
const SIZE = 270_000_000

describe("large blob past the V8 string cap — pushed, then fetched back", () => {
	let db: IsolatedDb
	let server: GitServer
	let objects: ObjectStore
	let refs: RefStore
	let src = ""
	let url = ""
	let blobOid = ""

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		server = await serveOnPort(createGitApp({ objects, refs }), 0)
		url = `http://127.0.0.1:${server.port}/r`

		src = mkdtempSync(join(tmpdir(), "pggit-large-blob-src-"))
		await spawnGit(["init", "-q"], { cwd: src })

		// Deterministic fill, no randomness: the size is what matters. Canonical git
		// owns the object encoding and hashes the exact bytes it is about to push.
		const content = Buffer.alloc(SIZE)
		for (let i = 0; i < SIZE; i += 4096) content.writeUInt32LE((i * 2654435761) >>> 0, i)
		blobOid = (
			await spawnGit(["hash-object", "-w", "--stdin"], { cwd: src, input: content })
		).stdout.trim()
		await spawnGit(["update-ref", `refs/tags/${TAG}`, blobOid], { cwd: src })
		await spawnGit(["push", "-q", url, `refs/tags/${TAG}:refs/tags/${TAG}`], {
			cwd: src,
		})
	}, 300_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("ingests a ~257MB blob and lands the ref", async () => {
		expect(await refs.listRefs("r")).toEqual([{ name: `refs/tags/${TAG}`, oid: blobOid }])
		expect(await objects.hasObject("r", blobOid)).toBe(true)
	})

	it("serves the exact blob to a fresh canonical-git repository", async () => {
		const dest = mkdtempSync(join(tmpdir(), "pggit-large-blob-dest-"))
		try {
			await spawnGit(["init", "-q"], { cwd: dest })
			await spawnGit(
				[
					"-c",
					"protocol.version=2",
					"fetch",
					"-q",
					url,
					`refs/tags/${TAG}:refs/tags/${TAG}`,
				],
				{ cwd: dest },
			)
			await spawnGit(["fsck", "--full", "--no-dangling"], { cwd: dest })
			expect(await allObjectOids(dest)).toEqual([blobOid])
			expect(
				(await spawnGit(["cat-file", "-t", blobOid], { cwd: dest })).stdout.trim(),
			).toBe("blob")
			expect(
				Number(
					(await spawnGit(["cat-file", "-s", blobOid], { cwd: dest })).stdout.trim(),
				),
			).toBe(SIZE)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	}, 300_000)
})

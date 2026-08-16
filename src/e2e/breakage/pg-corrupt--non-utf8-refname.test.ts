/**
 * PG TYPE-BOUNDARY PROBE — a refname is BYTES; `git_ref.name` is `text`.
 *
 * git refnames are byte strings (only a small set of ASCII control/meta chars is
 * banned by check-ref-format). `refs/heads/caf\xe9` and `refs/heads/caf\xea` are
 * two DISTINCT, perfectly legal refs that canonical git stores and transfers
 * byte-exact (proved here against a file:// remote oracle).
 *
 * pggit decodes the receive-pack command line with `payload.toString("utf8")`
 * (protocol/receive-pack.ts parseReceivePack) and stores the result in
 * `git_ref.name text`. Every invalid byte becomes U+FFFD, so:
 *
 *   1. the stored refname is NOT the pushed refname (silent rename), and
 *   2. two distinct refnames COLLIDE on one `text` value — `git_ref`'s PK
 *      (repo_id, name) then rejects the second as a CAS failure.
 *
 * `git_ref` is AUTHORITATIVE state (the ref namespace itself), not the derived
 * `repo_file` projection whose UTF-8 lossiness is a documented, accepted limit
 * (src/e2e/non-utf8-paths.test.ts). Nothing documents this one.
 *
 * The refs are created through `git update-ref --stdin -z` because argv from Node is
 * always UTF-8 encoded — plumbing is the only way to hand git these bytes — and the
 * control is a real `file://` bare remote: canonical git doing the same push.
 *
 * Converted from `breakage/pg-corrupt--non-utf8-refname.ts`, whose verdict was:
 * exit 0 = pggit matches the oracle; non-zero = reproduced, with the bytes printed.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/badref"
const SOLO_REPO = `${REPO}-solo`

/** The two refnames, as RAW BYTES. Latin-1 "é"/"ê" — invalid UTF-8, legal git. */
const REF_E9 = Buffer.concat([Buffer.from("refs/heads/caf"), Buffer.from([0xe9])])
const REF_EA = Buffer.concat([Buffer.from("refs/heads/caf"), Buffer.from([0xea])])

/** `git update-ref --stdin -z` — the only way to hand git a refname whose bytes
 * are not valid UTF-8 (argv from Node is always UTF-8 encoded). */
function createRefStdin(ref: Buffer, oid: string): Buffer {
	return Buffer.concat([
		Buffer.from("create "),
		ref,
		Buffer.from([0]),
		Buffer.from(oid),
		Buffer.from([0]),
	])
}

/** show-ref's raw bytes, sorted by line, so a byte-level comparison is order-free. */
function refLines(bytes: Buffer): string[] {
	return bytes
		.toString("latin1")
		.split("\n")
		.filter((l) => l.length > 0)
		.sort()
}

const hexOf = (l: string): string => Buffer.from(l, "latin1").toString("hex")

/** A push whose failure is data, not a thrown error. */
type PushOutcome = { code: number; stderr: string }
async function tryPush(args: string[], cwd: string): Promise<PushOutcome> {
	return spawnGit(args, { cwd }).catch((e: unknown) => ({ code: 1, stderr: String(e) }))
}

describe("pg-corrupt — non-UTF-8 refnames through git_ref.name text", () => {
	let db: IsolatedDb
	let server: GitServer
	let srcRefs: string[] = []
	let oracleRefs: string[] = []
	let clonedRefs: string[] = []
	let storedHex: string[] = []
	let push: PushOutcome = { code: 0, stderr: "" }
	let soloPush: PushOutcome = { code: 0, stderr: "" }
	let soloStoredHex: string[] = []
	let soloApplied = false
	const dirs: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-badref-${tag}-`))
		dirs.push(d)
		return d
	}

	beforeAll(async () => {
		const src = mk("src")
		await spawnGit(["init", "-q", "-b", "main", "--ref-format=reftable", src])
		await spawnGit(["hash-object", "-w", "--stdin"], { cwd: src, input: "one\n" })
		// Two distinct commits, so a collision cannot be dismissed as "same value anyway".
		const emptyTree = (
			await spawnGit(["hash-object", "-w", "-t", "tree", "--stdin"], {
				cwd: src,
				input: Buffer.alloc(0),
			})
		).stdout.trim()
		const c1 = (
			await spawnGit(["commit-tree", emptyTree, "-m", "c1"], { cwd: src, input: "" })
		).stdout.trim()
		const c2 = (
			await spawnGit(["commit-tree", emptyTree, "-p", c1, "-m", "c2"], {
				cwd: src,
				input: "",
			})
		).stdout.trim()
		await spawnGit(["update-ref", "refs/heads/main", c1], { cwd: src })
		await spawnGit(["update-ref", "--stdin", "-z"], {
			cwd: src,
			input: createRefStdin(REF_E9, c1),
		})
		await spawnGit(["update-ref", "--stdin", "-z"], {
			cwd: src,
			input: createRefStdin(REF_EA, c2),
		})
		srcRefs = refLines((await spawnGit(["show-ref"], { cwd: src })).stdoutBytes)
		console.log("SOURCE refs (hex of each show-ref line):")
		for (const l of srcRefs) console.log(`  ${hexOf(l)}`)
		if (srcRefs.length !== 3) throw new Error("fixture: expected 3 source refs")

		// ── ORACLE: canonical git over a file:// remote ────────────────────────────
		const oracleDir = join(mk("oracle"), "o.git")
		await spawnGit(["init", "-q", "--bare", "--ref-format=reftable", oracleDir])
		const oraclePush = await spawnGit(["push", oracleDir, "refs/heads/*:refs/heads/*"], {
			cwd: src,
		})
		console.log(`ORACLE push exit=${oraclePush.code}`)
		oracleRefs = refLines((await spawnGit(["show-ref"], { cwd: oracleDir })).stdoutBytes)
		console.log("ORACLE refs after push:")
		for (const l of oracleRefs) console.log(`  ${hexOf(l)}`)

		// ── SUBJECT: pggit ────────────────────────────────────────────────────────
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		push = await tryPush(["push", url, "refs/heads/*:refs/heads/*"], src)
		console.log(`pggit push exit=${push.code}`)
		console.log(push.stderr.trim().replace(/^/gm, "  | "))

		// What the server ACTUALLY stored, as bytes (bypassing every text decode).
		const stored = await db.sql<{ h: string }[]>`
			select encode(convert_to(g.name, 'UTF8'), 'hex') as h
			from git_ref g join repos r on r.id = g.repo_id
			where r.name = ${REPO} order by g.name`
		storedHex = stored.map((r) => r.h)
		console.log("git_ref.name rows (hex of the STORED bytes):")
		for (const h of storedHex) console.log(`  ${h}`)

		// What a client sees on the wire.
		const advertised = refLines(
			(await spawnGit(["-c", "protocol.version=2", "ls-remote", url])).stdoutBytes,
		)
		console.log("pggit ls-remote lines (hex):")
		for (const l of advertised) console.log(`  ${hexOf(l)}`)

		// And what a real clone materializes.
		const dest = join(mk("clone"), "c.git")
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			"--mirror",
			"--ref-format=reftable",
			url,
			dest,
		])
		clonedRefs = refLines((await spawnGit(["show-ref"], { cwd: dest })).stdoutBytes)
		console.log("pggit CLONE refs (hex):")
		for (const l of clonedRefs) console.log(`  ${hexOf(l)}`)

		// ── PHASE 2: ONE non-UTF-8 ref, no collision possible ─────────────────────
		// Isolates the RENAME from the COLLISION. A single `refs/heads/caf\xe9`
		// cannot hit `git_ref`'s PK — so whatever happens here is the decode alone.
		console.log("── phase 2: a SINGLE non-UTF-8 ref into a fresh repo ──")
		const solo = mk("solo")
		await spawnGit(["init", "-q", "-b", "main", "--ref-format=reftable", solo])
		const st = (
			await spawnGit(["hash-object", "-w", "-t", "tree", "--stdin"], {
				cwd: solo,
				input: Buffer.alloc(0),
			})
		).stdout.trim()
		const sc = (
			await spawnGit(["commit-tree", st, "-m", "solo"], { cwd: solo, input: "" })
		).stdout.trim()
		await spawnGit(["update-ref", "--stdin", "-z"], {
			cwd: solo,
			input: createRefStdin(REF_E9, sc),
		})
		const soloUrl = `http://127.0.0.1:${server.port}/${SOLO_REPO}`
		soloPush = await tryPush(["push", soloUrl, "refs/heads/*:refs/heads/*"], solo)
		console.log(`  push exit=${soloPush.code}`)
		console.log(soloPush.stderr.trim().replace(/^/gm, "    | "))
		const soloRows = await db.sql<{ h: string; oid: string }[]>`
			select encode(convert_to(g.name, 'UTF8'), 'hex') as h, encode(g.oid, 'hex') as oid
			from git_ref g join repos r on r.id = g.repo_id
			where r.name = ${SOLO_REPO} and g.oid is not null order by g.name`
		soloStoredHex = soloRows.map((r) => r.h)
		soloApplied = soloRows.some((r) => r.oid.startsWith(sc.slice(0, 8)))
		console.log("  stored refs (name hex → oid):")
		for (const r of soloRows) console.log(`    ${r.h} → ${r.oid.slice(0, 8)}`)
	}, 300_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("the oracle harness is sound: a file:// push preserves the refs byte-exact", () => {
		expect(oracleRefs).toEqual(srcRefs)
	})

	it("pggit's ref namespace matches canonical git's for the SAME push", () => {
		expect(clonedRefs.map(hexOf)).toEqual(oracleRefs.map(hexOf))
	})

	it("git_ref holds a row whose name bytes are the pushed refname", () => {
		const missing = [REF_E9, REF_EA]
			.map((want) => want.toString("hex"))
			.filter((wantHex) => !storedHex.includes(wantHex))
		expect(missing).toEqual([])
	})

	it("pggit accepts a push canonical git accepts", () => {
		expect(push.code).toBe(0)
	})

	it("a lone non-UTF-8 refname is stored under the bytes that were pushed", () => {
		// The decode alone, no PK collision involved.
		expect(soloStoredHex).toContain(REF_E9.toString("hex"))
	})

	it("client and server agree about whether the lone-ref push happened", () => {
		// A push that reported FAILURE must not have applied the ref — otherwise the
		// server holds a ref under a name the client never asked for, and the two
		// disagree about whether the push happened at all.
		expect(soloPush.code !== 0 && soloApplied).toBe(false)
	})
})

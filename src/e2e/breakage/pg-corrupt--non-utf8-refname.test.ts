/**
 * PG TYPE-BOUNDARY PROBE — a git refname is BYTES; pggit refnames are UTF-8.
 *
 * git refnames are byte strings (only a small set of ASCII control/meta chars is
 * banned by check-ref-format). `refs/heads/caf\xe9` and `refs/heads/caf\xea` are
 * two DISTINCT, perfectly legal refs that canonical git stores and transfers
 * byte-exact (proved here against a file:// remote oracle — kept as the record
 * of exactly what pggit diverges from).
 *
 * pggit's contract (design D16, a deliberate divergence): a refname must be
 * valid UTF-8, judged on the raw command-line bytes at the push boundary
 * (`parseReceivePack` decodes with `fatal: true`). The alternative was silent
 * corruption: a lossy decode turned every invalid byte into U+FFFD, so the
 * stored refname was NOT the pushed refname (silent rename), and two distinct
 * refnames COLLIDED on one `git_ref (repo_id, name)` PK value, surfacing as a
 * spurious CAS failure. Rejection is protocol-level (HTTP 400) rather than a
 * per-ref `ng`: a name whose bytes cannot decode cannot be echoed truthfully in
 * a report-status line.
 *
 * Asserted here: the push is REJECTED, NOTHING lands (no objects, no refs, no
 * mangled row), and the repo is not wedged — a follow-up all-UTF-8 push of the
 * same objects succeeds.
 *
 * The refs are created through `git update-ref --stdin -z` because argv from
 * Node is always UTF-8 encoded — plumbing is the only way to hand git these
 * bytes — and the control is a real `file://` bare remote: canonical git doing
 * the same push.
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

/** A push whose failure is data, not a thrown error. */
type PushOutcome = { code: number; stderr: string }
async function tryPush(args: string[], cwd: string): Promise<PushOutcome> {
	return spawnGit(args, { cwd }).catch((e: unknown) => ({ code: 1, stderr: String(e) }))
}

describe("pg-corrupt — non-UTF-8 refnames are rejected at the push boundary", () => {
	let db: IsolatedDb
	let server: GitServer
	let srcRefs: string[] = []
	let oracleRefs: string[] = []
	let push: PushOutcome = { code: 0, stderr: "" }
	let storedNamesHex: string[] = []
	let storedObjects = -1
	let retryPush: PushOutcome = { code: 1, stderr: "not run" }
	let advertisedAfterRetry: string[] = []
	let mainOid = ""
	let soloPush: PushOutcome = { code: 0, stderr: "" }
	let soloStoredHex: string[] = []
	const dirs: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-badref-${tag}-`))
		dirs.push(d)
		return d
	}

	beforeAll(async () => {
		const src = mk("src")
		await spawnGit(["init", "-q", "-b", "main", "--ref-format=reftable", src])
		// Two distinct commits, so the two bad refs carry different values.
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
		mainOid = c1
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
		if (srcRefs.length !== 3) throw new Error("fixture: expected 3 source refs")

		// ── ORACLE: canonical git over a file:// remote — the behaviour pggit
		// deliberately diverges from (D16). ────────────────────────────────────────
		const oracleDir = join(mk("oracle"), "o.git")
		await spawnGit(["init", "-q", "--bare", "--ref-format=reftable", oracleDir])
		await spawnGit(["push", oracleDir, "refs/heads/*:refs/heads/*"], { cwd: src })
		oracleRefs = refLines((await spawnGit(["show-ref"], { cwd: oracleDir })).stdoutBytes)

		// ── SUBJECT: pggit rejects the same push at the boundary. ─────────────────
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

		push = await tryPush(["push", url, "refs/heads/*:refs/heads/*"], src)

		// What actually landed, as bytes (bypassing every text decode): must be
		// nothing — no oid-bearing ref rows, no ingested objects.
		const stored = await db.sql<{ h: string }[]>`
			select encode(convert_to(g.name, 'UTF8'), 'hex') as h
			from git_ref g join repos r on r.id = g.repo_id
			where r.name = ${REPO} and g.oid is not null order by g.name`
		storedNamesHex = stored.map((r) => r.h)
		const [objs] = await db.sql<{ n: number }[]>`
			select count(*)::int as n from git_object o
			join repos r on r.id = o.repo_id where r.name = ${REPO}`
		storedObjects = objs?.n ?? -1

		// The repo is not wedged: the same objects under an all-UTF-8 refspec land.
		retryPush = await tryPush(["push", url, "refs/heads/main:refs/heads/main"], src)
		advertisedAfterRetry = refLines(
			(await spawnGit(["-c", "protocol.version=2", "ls-remote", url])).stdoutBytes,
		)

		// ── SOLO: one bad ref, no sibling refs — the decode alone, rejected. ──────
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
		const soloRows = await db.sql<{ h: string }[]>`
			select encode(convert_to(g.name, 'UTF8'), 'hex') as h
			from git_ref g join repos r on r.id = g.repo_id
			where r.name = ${SOLO_REPO} and g.oid is not null order by g.name`
		soloStoredHex = soloRows.map((r) => r.h)
	}, 300_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("the oracle records the divergence: a file:// push preserves the refs byte-exact", () => {
		expect(oracleRefs).toEqual(srcRefs)
	})

	it("pggit REJECTS the push carrying non-UTF-8 refnames", () => {
		expect(push.code, push.stderr).not.toBe(0)
	})

	it("nothing landed: no ref rows (exact OR mangled), no ingested objects", () => {
		expect(storedNamesHex).toEqual([])
		expect(storedObjects).toBe(0)
	})

	it("the repo is not wedged: an all-UTF-8 push of the same objects then succeeds", () => {
		expect(retryPush.code, retryPush.stderr).toBe(0)
		expect(advertisedAfterRetry.some((l) => l.endsWith("refs/heads/main"))).toBe(true)
		expect(advertisedAfterRetry.some((l) => l.startsWith(mainOid))).toBe(true)
	})

	it("a lone non-UTF-8 refname is rejected the same way, nothing stored", () => {
		expect(soloPush.code, soloPush.stderr).not.toBe(0)
		expect(soloStoredHex).toEqual([])
	})
})

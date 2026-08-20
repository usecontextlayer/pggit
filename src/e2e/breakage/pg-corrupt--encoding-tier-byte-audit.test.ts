/**
 * PG BYTE-FIDELITY AUDIT — does anything at the type boundary mangle bytes?
 *
 * Three seams carry git bytes through Postgres types, each with its own physics:
 *
 *   ingest  git_object.content  bytea COMPRESSION lz4, written by BINARY COPY
 *   derive  git_pack_encoding.data  bytea STORAGE EXTERNAL, written by BINARY COPY
 *   serve   both read back through porsager as `\x`+hex TEXT (2× the bytes)
 *
 * This hunts mangling on all three at once, with adversarial CONTENT (bytes that
 * look like framing to a text-COPY parser, a PGCOPY header/trailer, a `\x` bytea
 * literal, NUL runs, 0xFF runs, invalid UTF-8, incompressible random) and
 * adversarial OIDs (mined so the 20-byte key leads with 0x00 or 0xFF — the bytes a
 * hex round-trip is most likely to lose).
 *
 * Then it AUDITS the derived tier row by row, straight out of the database:
 *   whole row  →  inflate(data) must equal git_object.content, len == data_size
 *   delta row  →  applyDelta(base.content, inflate(data)) must equal content,
 *                 inflate(data).length == data_size, and the base must be WHOLE
 *                 (star topology, depth ≤ 1 — the invariant no DDL can express)
 *
 * A single mismatch here is silent corruption served as a verbatim byte copy.
 *
 * Converted from `breakage/pg-corrupt--encoding-tier-byte-audit.ts`, whose verdict
 * was: exit 0 = every byte survived and every encoding row reconstructs its object;
 * non-zero = reproduced, with the offending oid + offset printed.
 */
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyDelta } from "@/pack/delta"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/fidelity"
/** Enough versions of one path that ANCHOR_EVERY=32 segments and real deltas form. */
const LINEAGE = 80

/** Offset of the first differing byte, or -1 when the buffers are identical. */
function firstDiff(a: Buffer, b: Buffer): number {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
	return a.length === b.length ? -1 : n
}

/** PGCOPY binary signature + a −1 field-count trailer, verbatim inside a blob. */
const PGCOPY_HEADER = Buffer.from([
	0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00,
])

const ADVERSARIAL: Record<string, Buffer> = {
	"all-0x00": Buffer.alloc(4096, 0x00),
	"all-0xff": Buffer.alloc(4096, 0xff),
	"bytea-literal": Buffer.from(`\\x${"deadbeef".repeat(200)}`, "latin1"),
	"copy-text-terminators": Buffer.from("\\N\n\\.\n\t\r\n\\\\\n".repeat(200), "latin1"),
	"invalid-utf8": Buffer.from(Array.from({ length: 4096 }, (_, i) => 0x80 + (i % 0x80))),
	"pgcopy-framing": Buffer.concat([
		PGCOPY_HEADER,
		Buffer.alloc(8),
		Buffer.from([0xff, 0xff]),
		randomBytes(2000),
		PGCOPY_HEADER,
	]),
	"random-1kb": randomBytes(1_000),
	"random-1mb": randomBytes(1_000_000),
	"random-50mb": randomBytes(50_000_000),
	"surrogate-cesu8": Buffer.from(
		Array.from({ length: 3000 }, (_, i) => [0xed, 0xa0, 0x80][i % 3] as number),
	),
}

/** Mine content whose blob OID starts with `lead` — the key bytes a hex round-trip
 * is most likely to lose (leading zero, high bit set). */
function mineOid(lead: number, salt: string): Buffer {
	for (let i = 0; i < 200_000; i++) {
		const body = Buffer.from(`${salt}-${i}\n`)
		const h = createHash("sha1")
			.update(Buffer.from(`blob ${body.length}\0`))
			.update(body)
			.digest()
		if (h[0] === lead) return body
	}
	throw new Error(`could not mine an oid leading with 0x${lead.toString(16)}`)
}

type AuditRow = {
	oid: string
	base_oid: string | null
	data_size: number
	data: Buffer
	content: Buffer
	base_content: Buffer | null
	base_is_delta: boolean | null
}

describe("pg-corrupt — byte fidelity through ingest, derive, and serve", () => {
	let db: IsolatedDb
	let server: GitServer
	let url = ""
	let src = ""
	let deltasWritten = 0
	let rowCount = 0
	const minedOids = new Map<string, string>()
	/** Every audit failure, sorted by which promise it breaks. */
	const problems = {
		delta: [] as string[],
		inflate: [] as string[],
		size: [] as string[],
		star: [] as string[],
		whole: [] as string[],
	}
	const dirs: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-fid-${tag}-`))
		dirs.push(d)
		return d
	}

	beforeAll(async () => {
		src = mk("src")
		await spawnGit(["init", "-q", "-b", "main", src])

		// 1. Adversarial CONTENT, one file each.
		for (const [name, buf] of Object.entries(ADVERSARIAL)) {
			writeFileSync(join(src, name), buf)
		}
		// 2. Adversarial OIDs: 8 blobs leading with 0x00, 8 leading with 0xff.
		const mined: string[] = []
		for (let i = 0; i < 8; i++) {
			for (const lead of [0x00, 0xff]) {
				const body = mineOid(lead, `${lead}-${i}`)
				const fname = `mined-${lead.toString(16)}-${i}`
				writeFileSync(join(src, fname), body)
				mined.push(fname)
			}
		}
		await spawnGit(["add", "-A"], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "adversarial"], { cwd: src })

		// 3. A real LINEAGE so the delta tier is exercised, not just the whole path.
		for (let i = 0; i < LINEAGE; i++) {
			writeFileSync(
				join(src, "grow.jsonl"),
				`{"i":${i},"pad":"${"x".repeat(300)}"}\n`.repeat(i + 1),
			)
			await spawnGit(["add", "-A"], { cwd: src })
			await spawnGit(["commit", "-q", "-m", `grow ${i}`], { cwd: src })
		}
		for (const f of mined) {
			minedOids.set(
				f,
				(await spawnGit(["rev-parse", `HEAD:${f}`], { cwd: src })).stdout.trim(),
			)
		}
		console.log(
			`fixture: ${Object.keys(ADVERSARIAL).length} adversarial blobs, ` +
				`${mined.length} mined oids, ${LINEAGE} lineage versions`,
		)
		console.log(
			`  mined oid leads: ${[...minedOids.values()].map((o) => o.slice(0, 2)).join(" ")}`,
		)

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		url = repoUrl(server, REPO)

		await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], { cwd: src })
		const r = await createRepack(db.sql).repack(REPO)
		deltasWritten = r.deltas
		console.log(`repack: ${r.wholes} wholes + ${r.deltas} deltas`)

		// One pass over the derived tier, straight out of Postgres, sorting every
		// mismatch into the promise it breaks. The rows are released before the tests
		// run — a 50 MB blob's content + encoding is on the heap twice while they load.
		const rows = await db.sql<AuditRow[]>`
			select encode(e.oid, 'hex') as oid, encode(e.base_oid, 'hex') as base_oid,
			       e.data_size, e.data, o.content,
			       b.content as base_content,
			       (be.base_oid is not null) as base_is_delta
			from git_pack_encoding e
				join repos rr on rr.id = e.repo_id
				join git_object o on o.repo_id = e.repo_id and o.oid = e.oid
				left join git_object b on b.repo_id = e.repo_id and b.oid = e.base_oid
				left join git_pack_encoding be on be.repo_id = e.repo_id and be.oid = e.base_oid
			where rr.name = ${REPO}`
		rowCount = rows.length
		console.log(`auditing ${rowCount} encoding rows straight out of Postgres…`)
		for (const row of rows) {
			let inflated: Buffer
			try {
				inflated = inflateSync(row.data)
			} catch (err) {
				problems.inflate.push(
					`encoding ${row.oid}: stored data does not inflate — ${String(err)}`,
				)
				continue
			}
			if (inflated.length !== row.data_size) {
				problems.size.push(
					`encoding ${row.oid}: data_size=${row.data_size} but inflate(data) is ${inflated.length} bytes`,
				)
			}
			if (row.base_oid === null) {
				const d = firstDiff(inflated, row.content)
				if (d !== -1) {
					problems.whole.push(
						`whole encoding ${row.oid}: bytes differ from content at offset ${d}`,
					)
				}
				continue
			}
			if (row.base_content === null) {
				problems.delta.push(
					`delta encoding ${row.oid}: base ${row.base_oid} has NO git_object row`,
				)
				continue
			}
			if (row.base_is_delta) {
				problems.star.push(
					`delta encoding ${row.oid}: its base ${row.base_oid} is ITSELF a delta — ` +
						"star topology (depth ≤ 1) violated",
				)
			}
			let rebuilt: Buffer
			try {
				rebuilt = applyDelta(row.base_content, inflated)
			} catch (err) {
				problems.delta.push(
					`delta encoding ${row.oid}: applyDelta threw — ${String(err)}`,
				)
				continue
			}
			const d = firstDiff(rebuilt, row.content)
			if (d !== -1) {
				problems.delta.push(
					`delta encoding ${row.oid}: reconstruction differs from content at offset ${d} ` +
						`(rebuilt ${rebuilt.length}B, content ${row.content.length}B)`,
				)
			}
		}
		rows.length = 0
	}, 1_800_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("the fixture exercises the delta seam at all", () => {
		expect(rowCount).toBeGreaterThan(0)
		expect(deltasWritten).toBeGreaterThan(0)
	})

	it("every stored encoding inflates", () => {
		expect(problems.inflate).toEqual([])
	})

	it("every data_size is the inflated byte length of `data`", () => {
		expect(problems.size).toEqual([])
	})

	it("every whole encoding equals its canonical content byte-for-byte", () => {
		expect(problems.whole).toEqual([])
	})

	it("every delta encoding reconstructs its object from a stored base", () => {
		expect(problems.delta).toEqual([])
	})

	it("holds the star invariant: no delta's base is itself a delta", () => {
		expect(problems.star).toEqual([])
	})

	it("a real client's clone is fsck-clean and every adversarial blob byte-identical", async () => {
		const dest = join(mk("clone"), "c")
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
		await spawnGit(["fsck", "--full", "--strict", "--no-dangling"], { cwd: dest })
		const mismatches: string[] = []
		for (const [name, want] of Object.entries(ADVERSARIAL)) {
			const got = readFileSync(join(dest, name))
			const d = firstDiff(got, want)
			if (d !== -1) {
				mismatches.push(
					`blob "${name}": clone differs at offset ${d} ` +
						`(got 0x${got[d]?.toString(16)}, want 0x${want[d]?.toString(16)}; ` +
						`lengths ${got.length} vs ${want.length})`,
				)
			}
		}
		expect(mismatches).toEqual([])

		// The mined-oid blobs, read out of the clone's object store by oid.
		const lost: string[] = []
		for (const [fname, oid] of minedOids) {
			const got = (await spawnGit(["cat-file", "blob", oid], { cwd: dest })).stdoutBytes
			if (!got.equals(readFileSync(join(src, fname)))) {
				lost.push(`mined-oid blob ${oid} (${fname}) did not survive the round-trip`)
			}
		}
		expect(lost).toEqual([])
		console.log(
			`clone: fsck clean; ${Object.keys(ADVERSARIAL).length + minedOids.size} blobs byte-compared`,
		)
	}, 900_000)
})

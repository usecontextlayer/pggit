/**
 * PG DRIVER-PHYSICS PROBE — the encoding tier's `data` read has NO size guard.
 *
 * porsager decodes a `bytea` RESULT from its text form (`\x`+hex, DOUBLE the byte
 * length), so every large-bytea read on the serve path has to dodge V8's max string
 * length. The RAW path does: `object-store.ts` CASE-guards `content` at
 * `MAX_INLINE_BYTEA_BYTES` (200 MB) and falls back to `readContentChunked`.
 *
 * The NEW encoding read in the same query does not:
 *
 *     select …, e.data_size, e.data
 *     from git_object o left join git_pack_encoding e on …
 *     where o.repo_id = … and o.oid in ${pg(batch)}          -- batch = 1000 OIDs
 *
 * `e.data` comes back whole, for up to 1000 rows at once, with no CASE and no
 * chunked fallback. Repack's own `content()` point read is likewise unguarded.
 * Coverage is "every object under 200 MB" (design D6), and deflate of INCOMPRESSIBLE
 * bytes is ~the input size — so an object just under the cap parks a ~2×200 MB hex
 * string on the JS heap on every single clone.
 *
 * The sizes BRACKET the cap with crypto-random (incompressible) blobs: 64 MB is the
 * comfortable case, 190 MB sits just under `MAX_INLINE_BYTEA_BYTES` where the doubled
 * hex string is at its worst while an encoding row still gets written. The scale is
 * the test — do not shrink it.
 *
 * Converted from `breakage/pg-corrupt--big-bytea-encoding-serve.ts`, whose verdict
 * was: exit 0 = the blob round-trips byte-exact through push → repack → clone;
 * non-zero = reproduced (bytes differ, or an operation git does trivially crashed).
 */
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/bigbytea"
/** Brackets MAX_INLINE_BYTEA_BYTES = 200 MB from below. */
const SIZES_MB = [64, 190]

const mb = (n: number): string => `${(n / 1_000_000).toFixed(1)} MB`
const rss = (): string => `rss=${mb(process.memoryUsage().rss)}`

for (const sizeMb of SIZES_MB) {
	describe(`pg-corrupt — a ${sizeMb} MB incompressible blob through the encoding tier`, () => {
		type EncodingState =
			| { kind: "missing" }
			| { kind: "present"; dataSize: number; dataLength: number; stored: number }
		const size = Math.round(sizeMb * 1_000_000)
		let db: IsolatedDb
		let server: GitServer
		let url = ""
		let src = ""
		let payload = Buffer.alloc(0)
		/** Whether repack wrote the big blob's `git_pack_encoding` row. */
		let encoding: EncodingState = { kind: "missing" }
		const dirs: string[] = []
		const mk = (tag: string): string => {
			const d = mkdtempSync(join(tmpdir(), `pggit-bigb-${tag}-`))
			dirs.push(d)
			return d
		}

		beforeAll(async () => {
			console.log(`blob size: ${mb(size)} incompressible (crypto random)`)
			console.log("cap: MAX_INLINE_BYTEA_BYTES = 200.0 MB")

			src = mk("src")
			await spawnGit(["init", "-q", "-b", "main", src])
			payload = randomBytes(size)
			writeFileSync(join(src, "big.bin"), payload)
			writeFileSync(join(src, "small.txt"), "hello\n")
			await spawnGit(["add", "-A"], { cwd: src })
			await spawnGit(["commit", "-q", "-m", "big"], { cwd: src })
			const bigOid = (
				await spawnGit(["rev-parse", "HEAD:big.bin"], { cwd: src })
			).stdout.trim()
			console.log(`blob oid ${bigOid} (${rss()})`)

			const fixture = await setupGitServerFixture()
			db = fixture.db
			server = fixture.server
			url = repoUrl(server, REPO)

			let t = Date.now()
			await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], { cwd: src })
			console.log(`push: ok in ${Date.now() - t}ms (${rss()})`)

			t = Date.now()
			const r = await createRepack(db.sql).repack(REPO)
			console.log(
				`repack: ${r.wholes} wholes + ${r.deltas} deltas in ${Date.now() - t}ms (${rss()})`,
			)

			// The exact size of the unguarded read the serve path is about to make.
			// `data` comes back as `\x`+hex, so the JS string is TWICE `data_len`.
			const [row] = await db.sql<
				{
					n: number
					data_size: number | null
					data_len: number | null
					stored: number | null
				}[]
			>`
				select count(*)::int as n,
				       max(e.data_size)::int as data_size,
				       max(octet_length(e.data))::int as data_len,
				       max(pg_column_size(e.data))::int as stored
				from git_pack_encoding e
					join repos rr on rr.id = e.repo_id
				where rr.name = ${REPO} and e.oid = ${Buffer.from(bigOid, "hex")}`
			if (row === undefined) throw new Error("encoding aggregate returned no row")
			if (row.n === 0) {
				encoding = { kind: "missing" }
			} else if (
				row.n === 1 &&
				row.data_size !== null &&
				row.data_len !== null &&
				row.stored !== null
			) {
				encoding = {
					dataLength: row.data_len,
					dataSize: row.data_size,
					kind: "present",
					stored: row.stored,
				}
				console.log(
					`encoding row: data_size=${mb(row.data_size)} data=${mb(row.data_len)} ` +
						`stored=${mb(row.stored)} → serve reads a ${mb(row.data_len * 2)} hex string`,
				)
			} else {
				throw new Error(
					`invalid encoding aggregate for ${bigOid}: ${JSON.stringify(row)}`,
				)
			}
		}, 900_000)

		afterAll(async () => {
			await teardownGitServerFixture({ db, server })
			payload = Buffer.alloc(0)
			for (const d of dirs) rmSync(d, { force: true, recursive: true })
			console.log(`peak ${rss()}`)
		})

		it("has the fixture it needs: the big blob got an encoding row", () => {
			// Repack covers every object under MAX_INLINE_BYTEA_BYTES, and both sizes
			// here sit below it. Without the row, the second test drives the raw
			// chunked path — not the unguarded `e.data` read this file exists to probe
			// — and passes identically.
			if (encoding.kind !== "present") {
				throw new Error("no encoding row — the unguarded e.data read is never exercised")
			}
			expect(
				encoding.dataLength,
				"the encoding row carries no bytes, so the doubled-hex read is not on the serve path",
			).toBeGreaterThan(0)
		})

		it("clones fsck-clean and returns the blob byte-identical", async () => {
			// The read that has no guard, driven exactly as the serve path drives it: a
			// repo canonical git serves trivially.
			const t = Date.now()
			const dest = join(mk("clone"), "c")
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
			console.log(`clone: ok in ${Date.now() - t}ms (${rss()})`)
			await spawnGit(["fsck", "--full", "--strict", "--no-dangling"], { cwd: dest })

			const got = readFileSync(join(dest, "big.bin"))
			expect(got.length).toBe(payload.length)
			expect(got.equals(payload)).toBe(true)
			console.log(`byte-compare: identical (${mb(got.length)})`)
		}, 900_000)

		it("serves the same bytes again once the encoding row exists", async () => {
			// Second clone: the encoding row now definitely exists, so this is the pure
			// byte-copy serve path.
			const dest2 = join(mk("clone2"), "c")
			const t = Date.now()
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest2])
			console.log(`clone #2 (encoding present): ok in ${Date.now() - t}ms (${rss()})`)
			expect(readFileSync(join(dest2, "big.bin")).equals(payload)).toBe(true)
		}, 900_000)
	})
}

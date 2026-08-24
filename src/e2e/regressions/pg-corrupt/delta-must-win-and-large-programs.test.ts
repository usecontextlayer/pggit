/**
 * PG SIZE-SEAM PROBE — `data_size int4`, the "delta must WIN" guard, and delta
 * programs that are LARGER than the object they encode.
 *
 * Two size seams meet here:
 *
 *  - `git_pack_encoding.data_size` is `int4` and holds the inflated length of what
 *    `data` holds — the object's size for a whole row, the DELTA PROGRAM's length
 *    for a delta row. The shared 200 MB `MAX_INLINE_BYTEA_BYTES` ceiling keeps
 *    `data_size` inside int4.
 *  - `encodeDelta` is TOTAL — it never refuses. On a pathological pair (successive
 *    versions of one tree that share NO 16-byte block) the program it emits is
 *    LARGER than the target, because every byte ships as an INSERT with a length
 *    byte every 127. Only `repack`'s `deflated.length < whole.length` comparison
 *    stops that program from being stored and served.
 *
 * The fixture drives both: a lineage whose every version replaces every entry
 * (pathological — no shared blocks), and a lineage of multi-MB trees (100k entries)
 * so real delta programs run into the megabytes. The entry counts ARE the test —
 * the large-program seam only exists at that scale.
 *
 * Asserted behaviorally, from the database and from a real client:
 *   - no stored encoding is larger than that object's own whole form
 *   - data_size always equals the inflated byte length of `data`
 *   - the pack a client receives WITH the tier is never larger than without it
 *   - both clones are fsck-clean and byte-identical to the source
 *
 */
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync, inflateSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import { FAST_IMPORT_COMMITTER } from "@/testing/append-only-repo"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/deltasize"
/** Versions of the pathological lineage (> ANCHOR_EVERY so segments form). */
const PATHOLOGICAL_VERSIONS = 40
/** Entries in the WIDE directory — sets the tree size, hence the delta program size. */
const WIDE_ENTRIES = 100_000
/** Versions of the wide lineage. */
const WIDE_VERSIONS = 6
/** The largest value `data_size int4` can hold. */
const INT4_MAX = 2_147_483_647

type EncodingAudit = {
	oid: string
	base_oid: string | null
	data_size: number
	data: Buffer
	content: Buffer
}

type CloneAudit = {
	bytes: number
	inventory: string[]
	refs: string[]
}

const mb = (n: number): string => `${(n / 1_000_000).toFixed(2)} MB`

const nameFor = (salt: string, i: number): string =>
	createHash("sha1").update(`${salt}:${i}`).digest("hex").slice(0, 24)

describe("pg-corrupt — the delta-must-win guard and large delta programs", () => {
	let db: IsolatedDb
	let base: IsolatedDb
	let server: GitServer
	let baseServer: GitServer
	let url = ""
	let baseUrl = ""
	let src = ""
	let rows: EncodingAudit[] = []
	let baseline: CloneAudit = { bytes: 0, inventory: [], refs: [] }
	let sourceInventory: string[] = []
	let sourceRefs: string[] = []
	/** Delta rows the repack actually stored — zero makes three tests below vacuous. */
	let deltaRowCount = 0
	/** Inflated length of the largest stored delta PROGRAM, in bytes. */
	let maxProgram = 0
	const dirs: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-dsz-${tag}-`))
		dirs.push(d)
		return d
	}

	/**
	 * Two lineages in one history:
	 *   `path/` — every version replaces ALL entries with fresh names (no shared
	 *             16-byte block with its predecessor ⇒ the delta must lose)
	 *   `wide/` — WIDE_ENTRIES files, all pointing at ONE blob, half renamed each
	 *             version ⇒ multi-MB trees and multi-MB delta programs
	 */
	async function buildSource(dir: string): Promise<void> {
		await spawnGit(["init", "-q", "-b", "main", dir])
		const out: string[] = []
		out.push("blob\nmark :1\ndata 3\nxy\n")
		let prev = 0
		let mark = 1
		for (let v = 0; v < PATHOLOGICAL_VERSIONS; v++) {
			const cm = ++mark
			const msg = `path ${v}`
			const ops = ["D path"]
			for (let e = 0; e < 24; e++) ops.push(`M 100644 :1 path/${nameFor(`p${v}`, e)}`)
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${msg.length}\n${msg}\n` +
					(prev === 0 ? "" : `from :${prev}\n`) +
					`${ops.join("\n")}\n`,
			)
			prev = cm
		}
		for (let v = 0; v < WIDE_VERSIONS; v++) {
			const cm = ++mark
			const msg = `wide ${v}`
			const ops = ["D wide"]
			// HALF the entries persist across versions and half are replaced: enough
			// shared structure that the delta WINS, enough churn that the program it
			// emits is a large fraction of a multi-MB tree.
			for (let e = 0; e < WIDE_ENTRIES; e++) {
				ops.push(`M 100644 :1 wide/${nameFor(e % 2 === 0 ? "stable" : `w${v}`, e)}`)
			}
			out.push(
				`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata ${msg.length}\n${msg}\n` +
					`from :${prev}\n${ops.join("\n")}\n`,
			)
			prev = cm
		}
		await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: out.join("") })
	}

	/** Mirror-clone, fsck it, and return its exact client-visible state and pack size. */
	async function cloneAudit(from: string, dest: string): Promise<CloneAudit> {
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--mirror", from, dest])
		await spawnGit(["fsck", "--full", "--strict", "--no-dangling"], { cwd: dest })
		const out = await spawnGit(["count-objects", "-v"], { cwd: dest })
		const line = out.stdout.split("\n").find((l) => l.startsWith("size-pack:"))
		if (line === undefined) throw new Error("git count-objects -v omitted size-pack")
		const kibibytes = Number(line.slice("size-pack:".length).trim())
		if (!Number.isSafeInteger(kibibytes) || kibibytes < 0) {
			throw new Error(`git count-objects -v returned an invalid size-pack line: ${line}`)
		}
		const inventory = (
			await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], { cwd: dest })
		).stdout
			.split("\n")
			.filter(Boolean)
			.sort()
		const refs = (
			await spawnGit(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: dest })
		).stdout
			.split("\n")
			.filter(Boolean)
			.sort()
		return { bytes: kibibytes * 1024, inventory, refs }
	}

	beforeAll(async () => {
		src = mk("src")
		console.log(
			`building: ${PATHOLOGICAL_VERSIONS} pathological versions + ` +
				`${WIDE_VERSIONS} × ${WIDE_ENTRIES}-entry trees…`,
		)
		await buildSource(src)
		sourceInventory = (
			await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], { cwd: src })
		).stdout
			.split("\n")
			.filter(Boolean)
			.sort()
		sourceRefs = (
			await spawnGit(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd: src })
		).stdout
			.split("\n")
			.filter(Boolean)
			.sort()
		const treeSize = Number(
			(await spawnGit(["cat-file", "-s", "HEAD:wide"], { cwd: src })).stdout.trim(),
		)
		console.log(`wide/ tree object: ${mb(treeSize)}`)

		// BASELINE: same repo, NO repack — the raw serve path, for a pack-size compare.
		const baseFixture = await setupGitServerFixture()
		base = baseFixture.db
		baseServer = baseFixture.server
		baseUrl = repoUrl(baseServer, REPO)
		// SUBJECT: same repo, repacked.
		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		url = repoUrl(server, REPO)

		await spawnGit(["push", "-q", baseUrl, "refs/heads/main:refs/heads/main"], {
			cwd: src,
		})
		await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], { cwd: src })
		baseline = await cloneAudit(baseUrl, join(mk("base"), "c.git"))
		console.log(`baseline clone (no encoding tier): ${mb(baseline.bytes)}`)

		const t = Date.now()
		const r = await createRepack(db.sql).repack(REPO)
		console.log(`repack: ${r.wholes} wholes + ${r.deltas} deltas in ${Date.now() - t}ms`)

		rows = await db.sql<EncodingAudit[]>`
			select encode(e.oid, 'hex') as oid, encode(e.base_oid, 'hex') as base_oid,
			       e.data_size, e.data, o.content
			from git_pack_encoding e
				join repos rr on rr.id = e.repo_id
				join git_object o on o.repo_id = e.repo_id and o.oid = e.oid
			where rr.name = ${REPO}`

		let maxDeltaRow = ""
		for (const row of rows) {
			if (row.base_oid === null) continue
			deltaRowCount++
			const len = inflateSync(row.data).length
			if (len > maxProgram) {
				maxProgram = len
				maxDeltaRow = row.oid
			}
		}
		console.log(
			`audited ${rows.length} rows; ${deltaRowCount} deltas; ` +
				`largest delta PROGRAM ${mb(maxProgram)} (${maxDeltaRow.slice(0, 8)})`,
		)
	}, 1_800_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		await teardownGitServerFixture({ db: base, server: baseServer })
		rows = []
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	it("has the fixture it needs: stored deltas, one of them a multi-MB program", () => {
		// Both named subjects live in delta rows: with none stored, the delta-must-win
		// guard judges only whole encodings and the large-program seam is never
		// reached, while every test below still passes.
		expect(
			deltaRowCount,
			"the delta-must-win guard needs stored deltas to judge",
		).toBeGreaterThan(0)
		expect(
			maxProgram,
			"the large-program seam needs a multi-MB delta program",
		).toBeGreaterThan(1_000_000)
	})

	it("data_size is the inflated byte length of what `data` holds", () => {
		const problems: string[] = []
		for (const row of rows) {
			const inflated = inflateSync(row.data).length
			if (inflated !== row.data_size) {
				problems.push(
					`${row.oid}: data_size=${row.data_size} but inflate(data)=${inflated}`,
				)
			}
		}
		expect(problems).toEqual([])
	}, 600_000)

	it("every data_size stays inside int4", () => {
		const problems = rows
			.filter((row) => row.data_size < 0 || row.data_size > INT4_MAX)
			.map((row) => `${row.oid}: data_size ${row.data_size} is outside int4`)
		expect(problems).toEqual([])
	})

	it("no stored encoding is larger than that object's own whole form", () => {
		// The "delta must win" guard: `encodeDelta` is total, so a pathological pair
		// emits a program LARGER than the target. Only repack's size comparison keeps
		// that program out of the table.
		const problems: string[] = []
		for (const row of rows) {
			const whole = deflateSync(row.content).length
			if (row.data.length > whole) {
				problems.push(
					`${row.oid}: stored encoding is ${row.data.length}B but its whole form deflates to ` +
						`${whole}B — the "delta must win" guard did not hold ` +
						`(base_oid=${row.base_oid ?? "null"})`,
				)
			}
		}
		expect(problems).toEqual([])
	}, 600_000)

	it("the encoding tier never makes the served pack bigger than the raw path", async () => {
		const subject = await cloneAudit(url, join(mk("subj"), "c.git"))
		console.log(
			`clone WITH encoding tier: ${mb(subject.bytes)} (baseline ${mb(baseline.bytes)})`,
		)
		expect(baseline.inventory).toEqual(sourceInventory)
		expect(baseline.refs).toEqual(sourceRefs)
		expect(subject.inventory).toEqual(sourceInventory)
		expect(subject.refs).toEqual(sourceRefs)
		expect(subject.bytes).toBeLessThanOrEqual(baseline.bytes)
	}, 900_000)
})

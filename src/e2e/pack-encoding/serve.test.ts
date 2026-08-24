/**
 * Serving from the encoding tier (docs/2026-08-15-delta-pack-design.md D8).
 *
 * The serve contract after repack, judged ONLY at observables a client owns:
 *
 *   1. Correctness by canonical git: a real `git clone` of a repacked repo is
 *      fsck-clean and object-identical to the source.
 *   2. Size at the client: the BYTES THAT ARRIVED — the clone's own pack files on
 *      disk — must be a fraction of the undeltified total. This is the whole
 *      point of the work, measured where the customer pays it, with no reach into
 *      server counters.
 *   3. Incremental fetch stays correct after the tier exists (the delta-eligibility
 *      rule: a cached delta is emitted only when its base is in the served set —
 *      wrong handling shows up here as a corrupt or over-full fetch).
 *   4. A repack committing DURING a clone changes nothing: the derived model's
 *      central safety claim (D1), asserted as a raw race rather than trusted.
 *
 * The first and third contracts hold for the raw path too, by design: they pin that
 * the encoding tier never regresses what already worked.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createRepack, type Repack } from "@/store/repack"
import { createAppendOnlyRepo, RUNS_DIR, runDirName } from "@/testing/append-only-repo"
import {
	allObjectOids,
	loadAllObjects,
	packFileBytes,
	seedRepoIntoStore,
} from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "enc-serve"
// The lineage must be several ANCHOR_EVERY segments long for the size assertion
// to be meaningful: a star delta at distance d from its anchor carries d inserted
// entries, so on a lineage barely past one segment that within-segment cost IS
// the tier and the reduction is marginal. The win the design measured (3.5–9.6×
// on the 1,476-version production lineage) needs length ≫ K; 200 ≈ 6 segments is
// the smallest shape where "under half of undeltified" holds with margin.
const RUNS = 200

describe("serve — a repacked repo over the real wire", () => {
	let db: IsolatedDb
	let objects: ObjectStore
	let refs: RefStore
	let repack: Repack
	let server: GitServer
	let src = ""
	let url = ""
	let undeltifiedBytes = 0

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
		refs = createRefStore(db.sql)
		repack = createRepack(db.sql)

		src = await createAppendOnlyRepo({ docs: 4, runs: RUNS })
		await seedRepoIntoStore(REPO, src, { objects, refs })
		await repack.repack(REPO)

		// What serving every object individually-deflated would cost — the baseline
		// the size assertion is judged against, derived from the fixture itself.
		for (const o of await loadAllObjects(src)) {
			undeltifiedBytes += deflateSync(o.content).length
		}

		server = await serveOnPort(createGitApp({ objects, refs }), 0)
		url = `http://127.0.0.1:${server.port}/${REPO}`
	}, 300_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	async function cloneInto(tag: string): Promise<string> {
		const dest = join(mkdtempSync(join(tmpdir(), `enc-serve-${tag}-`)), "c")
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest])
		return dest
	}

	it("clones fsck-clean and object-identical to the source", async () => {
		const dest = await cloneInto("full")
		try {
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			expect(await allObjectOids(dest)).toEqual(await allObjectOids(src))
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})

	it("transfers a fraction of the undeltified bytes — measured at the client", async () => {
		const dest = await cloneInto("size")
		try {
			const transferred = await packFileBytes(dest)
			expect(transferred).toBeGreaterThan(0)
			// The append-only fixture deltifies overwhelmingly (measured 3.5–9.6× on
			// the real repo depending on K); half is a deliberately loose floor that
			// only a genuinely deltified pack can meet.
			expect(transferred).toBeLessThan(undeltifiedBytes / 2)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})

	it("serves a correct incremental fetch after the tier exists", async () => {
		const dest = await cloneInto("incr")
		try {
			// The repo advances AFTER the clone; the encoding tier catches up.
			for (let i = RUNS; i < RUNS + 6; i++) {
				const run = join(src, RUNS_DIR, runDirName(i))
				mkdirSync(run, { recursive: true })
				writeFileSync(join(run, "record.json"), `{"n":${i}}\n`)
				await spawnGit(["add", "-A"], { cwd: src })
				await spawnGit(["commit", "-q", "-m", `run ${i}`], { cwd: src })
			}
			await seedRepoIntoStore(REPO, src, { objects, refs })
			await repack.repack(REPO)

			await spawnGit(["fetch", "-q", "origin"], { cwd: dest })
			await spawnGit(["merge", "-q", "--ff-only", "origin/main"], { cwd: dest })
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			const srcTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
			const destTip = (await spawnGit(["rev-parse", "HEAD"], { cwd: dest })).stdout.trim()
			expect(destTip).toBe(srcTip)
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})

	it("stays valid when a repack commits mid-clone (the derived model's safety claim)", async () => {
		// The repo GROWS first: the test above left the tier complete, and a repack
		// with nothing to encode cannot interleave with anything — the "race" would be
		// a no-op running beside a clone.
		for (let i = RUNS + 6; i < RUNS + 12; i++) {
			const run = join(src, RUNS_DIR, runDirName(i))
			mkdirSync(run, { recursive: true })
			writeFileSync(join(run, "record.json"), `{"n":${i}}\n`)
			await spawnGit(["add", "-A"], { cwd: src })
			await spawnGit(["commit", "-q", "-m", `run ${i}`], { cwd: src })
		}
		await seedRepoIntoStore(REPO, src, { objects, refs })

		// A raw race, not a scripted interleaving: the clone and a concurrent repack
		// run together. Under the derived model the served OID set comes from the
		// inventory, so WHATEVER the interleaving, the pack must arrive complete and
		// fsck-clean.
		const dest = join(mkdtempSync(join(tmpdir(), "enc-serve-race-")), "c")
		try {
			const [, encoded] = await Promise.all([
				spawnGit(["-c", "protocol.version=2", "clone", "-q", url, dest]),
				repack.repack(REPO),
			])
			// The concurrent participant really wrote rows — without this the race is
			// a clone running beside a no-op, which proves nothing about interleaving.
			expect(encoded.wholes + encoded.deltas).toBeGreaterThan(0)
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			expect(await allObjectOids(dest)).toEqual(await allObjectOids(src))
		} finally {
			rmSync(dest, { force: true, recursive: true })
		}
	})
})

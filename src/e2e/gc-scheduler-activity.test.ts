import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	type GcFixture,
	pushFile,
	repoGcState,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"

/**
 * GC scheduler — activity signal (`docs/2026-06-24-gc-scheduler-design.md` §6,
 * items SCH-1 "any storage-mutating push stamps activity" and SCH-2 "delete is
 * captured"). The activity signal is `repos.last_pushed_at`, written by the store
 * in the push transaction (§3); this file probes ONLY that stamp — it never calls
 * `drainOnce()`.
 *
 * OBSERVABLE-ONLY: every assertion is on Postgres rows — `repoGcState`'s
 * `last_pushed_at` (§6 "Postgres surface") — or the real `git` oracle that drove
 * the push (`spawnGit`). Nothing here probes which store method stamped, the SQL
 * shape, or any internal of the bump (§3 names `insertObjects` + `applyRefUpdates`
 * but the test pins only the OUTCOME: the column moved). Determinism is from the
 * pushes themselves (each push is a distinct round-trip, so `clock_timestamp()`
 * advances between them — no wall-clock sleep, no `ageObjects`).
 *
 * RED now because the store does NOT yet stamp `repos.last_pushed_at` (it stays
 * NULL after a push), so `expect(...).not.toBeNull()` rejects. GREEN once the
 * store writes the bump per §3.
 */
describe("GC scheduler — activity signal (§6: SCH-1, SCH-2)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	// SCH-1 — Any storage-mutating push stamps activity. A never-pushed repo's
	// `last_pushed_at` is NULL; the first push (create) makes it non-null; a
	// fast-forward update and a non-ff force push each strictly advance it. Pins
	// that EVERY push type that mutates storage moves the column forward — a wrong
	// impl that stamps once and never again (or only on a force) fails the strict
	// `>` between the captured snapshots.
	it("SCH-1: create, fast-forward, and force pushes each stamp/advance last_pushed_at", async () => {
		const repo = "sch1-activity"

		// Never pushed → no activity recorded yet (row absent or column unset; the
		// helper returns null for both). This is the NULL baseline SCH-5 keys off.
		expect((await repoGcState(fx.db, repo)).lastPushedAt).toBeNull()

		// First push (create): the column becomes non-null.
		await pushFile(fx, repo, { content: "first\n" })
		const afterCreate = (await repoGcState(fx.db, repo)).lastPushedAt
		expect(afterCreate).not.toBeNull()

		// Fast-forward update: build a real descendant of the current tip by fetching
		// it back, committing on top, and pushing the (fast-forward) child. A ff push
		// ingests a new commit/tree/blob, so it must advance the stamp too — this is
		// the push type a "force-only" stamp would miss.
		const ffDir = mkdtempSync(join(tmpdir(), "pggit-sch1-ff-"))
		try {
			const url = repoUrl(fx, repo)
			await spawnGit(["init", "-q", "-b", "main"], { cwd: ffDir })
			await spawnGit(["fetch", url, "refs/heads/main"], { cwd: ffDir })
			await spawnGit(["checkout", "-q", "FETCH_HEAD"], { cwd: ffDir })
			writeFileSync(join(ffDir, "file.txt"), "second (ff child)\n")
			await spawnGit(["add", "."], { cwd: ffDir })
			await spawnGit(["commit", "-q", "-m", "ff"], { cwd: ffDir })
			// No `--force`: this is a genuine fast-forward (the child is a descendant).
			await spawnGit(["push", url, "HEAD:refs/heads/main"], { cwd: ffDir })
		} finally {
			rmSync(ffDir, { force: true, recursive: true })
		}
		const afterFf = (await repoGcState(fx.db, repo)).lastPushedAt
		expect(afterFf).not.toBeNull()
		expect((afterFf as Date).getTime()).toBeGreaterThan((afterCreate as Date).getTime())

		// Non-ff force push (the §1 force-commit workload): an independent root orphans
		// the prior tip and re-stamps the column, strictly later than the ff stamp.
		await pushFile(fx, repo, { content: "third (force)\n", force: true })
		const afterForce = (await repoGcState(fx.db, repo)).lastPushedAt
		expect(afterForce).not.toBeNull()
		expect((afterForce as Date).getTime()).toBeGreaterThan((afterFf as Date).getTime())
	})

	// SCH-2 — Delete is captured. Create a second branch `refs/heads/topic`, capture
	// `last_pushed_at`, then DELETE that ref. The delete ingests NO new object, yet
	// must still advance the stamp (the case a `git_object.created_at`-derived signal
	// would miss — §3). Pins that the ref-update path itself stamps activity: an impl
	// that only bumps on object ingest leaves the column unchanged across the delete
	// and fails the strict `>`.
	it("SCH-2: a ref-delete (ingesting no object) still advances last_pushed_at", async () => {
		const repo = "sch2-delete"
		const url = repoUrl(fx, repo)

		// Seed main so the repo exists, then push a second branch `topic` whose tip is
		// an independent commit (a real storage mutation that creates the ref).
		await pushFile(fx, repo, { content: "main\n" })
		const topicDir = mkdtempSync(join(tmpdir(), "pggit-sch2-topic-"))
		try {
			await spawnGit(["init", "-q", "-b", "topic"], { cwd: topicDir })
			writeFileSync(join(topicDir, "file.txt"), "topic branch\n")
			await spawnGit(["add", "."], { cwd: topicDir })
			await spawnGit(["commit", "-q", "-m", "topic"], { cwd: topicDir })
			await spawnGit(["push", url, "HEAD:refs/heads/topic"], { cwd: topicDir })
		} finally {
			rmSync(topicDir, { force: true, recursive: true })
		}
		const afterCreateTopic = (await repoGcState(fx.db, repo)).lastPushedAt
		expect(afterCreateTopic).not.toBeNull()

		// Delete `refs/heads/topic` — a ref update with no pack, no new object. Run
		// from a throwaway repo (git needs a local repo to drive the transport even
		// for a delete-only refspec, but sends nothing).
		const delDir = mkdtempSync(join(tmpdir(), "pggit-sch2-del-"))
		try {
			await spawnGit(["init", "-q"], { cwd: delDir })
			await spawnGit(["push", url, ":refs/heads/topic"], { cwd: delDir })
		} finally {
			rmSync(delDir, { force: true, recursive: true })
		}

		// The delete still moved the stamp forward (it is a storage mutation: a ref
		// disappeared, orphaning its commit). Strictly greater than the create.
		const afterDelete = (await repoGcState(fx.db, repo)).lastPushedAt
		expect(afterDelete).not.toBeNull()
		expect((afterDelete as Date).getTime()).toBeGreaterThan(
			(afterCreateTopic as Date).getTime(),
		)
	})

	// SCH-1 (negative) — a no-op ref op leaves `last_pushed_at` UNCHANGED. The §6
	// SCH-1 clause "a zero-command no-op push leaves it unchanged" is the discriminator
	// against an over-eager impl that stamps on every received push regardless of
	// effect (which would re-trigger GC on traffic that created no garbage). git
	// refuses a wire-level delete of an absent ref client-side (it never POSTs), so we
	// drive the no-op at the store boundary: an unconditional delete of a ref that does
	// not exist — canonical receive-pack reports it as a no-op SUCCESS, but it changes
	// no row, so the activity stamp must NOT move. Observable: the Postgres column
	// before == after.
	it("SCH-1: a ref op that changes nothing leaves last_pushed_at unchanged", async () => {
		const repo = "sch1-noop"
		const zero = "0".repeat(40)

		await pushFile(fx, repo, { content: "seed\n" })
		const before = (await repoGcState(fx.db, repo)).lastPushedAt
		expect(before).not.toBeNull()

		// Unconditional delete (zero old-oid) of a ref that was never created: a
		// no-op success that mutates no storage.
		const results = await fx.refs.applyRefUpdates(
			repo,
			[{ newOid: zero, oldOid: zero, ref: "refs/heads/never-existed" }],
			false,
		)
		expect(results).toEqual([true])

		// The stamp must be byte-identical: a non-mutating op records no activity.
		const after = (await repoGcState(fx.db, repo)).lastPushedAt
		expect(after).not.toBeNull()
		expect((after as Date).getTime()).toBe((before as Date).getTime())
	})
})

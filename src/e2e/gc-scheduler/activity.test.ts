import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ZERO_OID } from "@/object/oid"
import {
	type GcFixture,
	pushFile,
	repoGcState,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"
import { withTempDir } from "@/testing/temp-dir"

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
 * These cases pin the §3 activity-stamp contract.
 */
describe("GC scheduler — activity signal (§6: SCH-1, SCH-2)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	async function pushedAt(repo: string): Promise<Date> {
		const state = await repoGcState(fx.db, repo)
		if (state.kind !== "pushed-never-drained") {
			throw new Error(`expected pushed, undrained repo ${repo}; got ${state.kind}`)
		}
		return state.pushedAt
	}

	// SCH-1 — Any storage mutation stamps activity. A never-pushed repo's
	// `last_pushed_at` is NULL; the first push (create) makes it non-null; a
	// fast-forward update and a store-level rewind each strictly advance it. Pins
	// that EVERY mutation type moves the column forward — a wrong impl that
	// stamps once and never again (or only on a rewind) fails the strict `>`
	// between the captured snapshots.
	it("SCH-1: a create push, a fast-forward push, and a store rewind each stamp/advance last_pushed_at", async () => {
		const repo = "sch1-activity"

		// Never pushed → no repo row and therefore no activity recorded yet.
		expect(await repoGcState(fx.db, repo)).toEqual({ kind: "absent" })

		// First push (create): the column becomes non-null.
		await pushFile(fx, repo, { content: "first\n" })
		const afterCreate = await pushedAt(repo)

		// Fast-forward update: build a real descendant of the current tip by fetching
		// it back, committing on top, and pushing the (fast-forward) child. A ff push
		// ingests a new commit/tree/blob, so it must advance the stamp too — this is
		// the mutation a "rewind-only" stamp would miss.
		await withTempDir("pggit-sch1-ff-", async (ffDir) => {
			const url = repoUrl(fx, repo)
			await spawnGit(["init", "-q", "-b", "main"], { cwd: ffDir })
			await spawnGit(["fetch", url, "refs/heads/main"], { cwd: ffDir })
			await spawnGit(["checkout", "-q", "FETCH_HEAD"], { cwd: ffDir })
			writeFileSync(join(ffDir, "file.txt"), "second (ff child)\n")
			await spawnGit(["add", "."], { cwd: ffDir })
			await spawnGit(["commit", "-q", "-m", "ff"], { cwd: ffDir })
			// No `--force`: this is a genuine fast-forward (the child is a descendant).
			await spawnGit(["push", url, "HEAD:refs/heads/main"], { cwd: ffDir })
		})
		const afterFf = await pushedAt(repo)
		expect(afterFf.getTime()).toBeGreaterThan(afterCreate.getTime())

		// A store-level rewind to an independent root orphans the prior tip and
		// re-stamps the column,
		// strictly later than the ff stamp (applyRefUpdates stamps on mutation).
		await pushFile(fx, repo, { content: "third (rewind)\n", rewind: true })
		const afterRewind = await pushedAt(repo)
		expect(afterRewind.getTime()).toBeGreaterThan(afterFf.getTime())
	})

	// SCH-2 — Delete is captured (and a DENIED wire delete is not). Create a second
	// branch `refs/heads/topic`, capture `last_pushed_at`, prove the wire refusal
	// leaves the stamp untouched, then delete the ref at the STORE level. The delete
	// ingests NO new object, yet must still advance the stamp (the case a
	// `git_object.created_at`-derived signal would miss — §3). Pins that the
	// ref-update path itself stamps activity: an impl that only bumps on object
	// ingest leaves the column unchanged across the delete and fails the strict `>`.
	it("SCH-2: a store ref-delete (ingesting no object) still advances last_pushed_at; a denied wire delete does not", async () => {
		const repo = "sch2-delete"
		const url = repoUrl(fx, repo)

		// Seed main so the repo exists, then push a second branch `topic` whose tip is
		// an independent commit (a real storage mutation that creates the ref).
		await pushFile(fx, repo, { content: "main\n" })
		await withTempDir("pggit-sch2-topic-", async (topicDir) => {
			await spawnGit(["init", "-q", "-b", "topic"], { cwd: topicDir })
			writeFileSync(join(topicDir, "file.txt"), "topic branch\n")
			await spawnGit(["add", "."], { cwd: topicDir })
			await spawnGit(["commit", "-q", "-m", "topic"], { cwd: topicDir })
			await spawnGit(["push", url, "HEAD:refs/heads/topic"], { cwd: topicDir })
		})
		const afterCreateTopic = await pushedAt(repo)

		// A WIRE delete is denied outright now (deny-non-FF policy) and, being a
		// pure refusal, must NOT advance the stamp.
		await withTempDir("pggit-sch2-del-", async (delDir) => {
			await spawnGit(["init", "-q"], { cwd: delDir })
			await expect(
				spawnGit(["push", url, ":refs/heads/topic"], { cwd: delDir }),
			).rejects.toThrow(/deletion denied/i)
		})
		expect(await pushedAt(repo)).toEqual(afterCreateTopic)

		// The STORE-level delete is a ref
		// update with no pack, no new object — and must still stamp activity.
		// Bracketed by existence checks: the store reports an absent-ref delete as
		// a `true` no-op too, so `[true]` alone would not prove removal.
		const names = async () => (await fx.refs.listRefs(repo)).map((r) => r.name)
		expect(await names()).toContain("refs/heads/topic")
		const deleted = await fx.refs.applyRefUpdates(
			repo,
			[{ newOid: ZERO_OID, oldOid: ZERO_OID, ref: "refs/heads/topic" }],
			false,
		)
		expect(deleted).toEqual([true])
		expect(await names()).not.toContain("refs/heads/topic")

		// The delete still moved the stamp forward (it is a storage mutation: a ref
		// disappeared, orphaning its commit). Strictly greater than the create.
		const afterDelete = await pushedAt(repo)
		expect(afterDelete.getTime()).toBeGreaterThan(afterCreateTopic.getTime())
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

		await pushFile(fx, repo, { content: "seed\n" })
		const before = await pushedAt(repo)

		// Unconditional delete (zero old-oid) of a ref that was never created: a
		// no-op success that mutates no storage.
		const results = await fx.refs.applyRefUpdates(
			repo,
			[{ newOid: ZERO_OID, oldOid: ZERO_OID, ref: "refs/heads/never-existed" }],
			false,
		)
		expect(results).toEqual([true])

		// The stamp must be byte-identical: a non-mutating op records no activity.
		const after = await pushedAt(repo)
		expect(after.getTime()).toBe(before.getTime())
	})
})

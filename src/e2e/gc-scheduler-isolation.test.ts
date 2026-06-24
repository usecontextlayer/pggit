/**
 * GC scheduler — tenant isolation & all-eligible-correctly-GC'd through one drain
 * (`docs/2026-06-24-gc-scheduler-design.md` §6, item SCH-8 "Isolation &
 * robustness": a drain that GCs repo A never alters repo B's rows or clone, and
 * with many eligible repos ALL end up correctly GC'd — survivors == each repo's
 * reachable closure — regardless of concurrency; GC-8 reached through the
 * scheduler, outcome-asserted not concurrency-asserted).
 *
 * OBSERVABLE-ONLY: every assertion is on the real-`git` oracle
 * (`cloneAndFsck` / `gitReachableOids` via the throwaway-fetch `reachableOfTip`),
 * Postgres rows (`objectOids` over `git_object`), or the `drainOnce()`
 * `DrainSummary` return value. Nothing here probes scheduler internals (timer
 * mechanics, concurrency choreography, advisory locks, the candidate SQL,
 * batch/transaction shape) — those stay free to change. Grace is made
 * deterministic with `graceSeconds: 0` + `ageObjects`, never a wall-clock sleep;
 * concurrency is exercised (`concurrency: 4`) but only its OUTCOME is asserted.
 *
 * RED now because `createGcScheduler(...).drainOnce()` is a throwing TDD stub
 * ("pggit gc-scheduler: not implemented (TDD stub)") AND the store does not yet
 * stamp `repos.last_pushed_at`, so today no repo is even judged eligible and no
 * object is reclaimed. GREEN once the store stamps `last_pushed_at` on each push
 * and `drainOnce()` GCs exactly the eligible set per §6.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createGcScheduler } from "@/gc-scheduler"
import {
	ageObjects,
	cloneAndFsck,
	type GcFixture,
	gitReachableOids,
	objectOids,
	pushFile,
	repoUrl,
	setupGcFixture,
	teardownGcFixture,
	withTempDir,
} from "@/testing/gc-helpers"
import { spawnGit } from "@/testing/spawn-git"

describe("GC scheduler isolation through one drain (§6: SCH-8)", () => {
	let fx: GcFixture

	beforeAll(async () => {
		fx = await setupGcFixture()
	}, 180_000)

	afterAll(async () => {
		await teardownGcFixture(fx)
	})

	/**
	 * The real-git reachable closure (sorted hex OIDs) of `repo`'s current
	 * `refs/heads/main` tip, computed by the oracle from a throwaway fetch of that
	 * ref — independent of any `pushFile` return value. The per-repo
	 * expected-survivors oracle: with `graceSeconds: 0` on aged rows, a correct
	 * drain leaves `git_object` reduced to EXACTLY this set (live kept, orphans
	 * gone).
	 */
	async function reachableOfTip(repo: string): Promise<string[]> {
		return withTempDir("pggit-sch8-tip-", async (dir) => {
			await spawnGit(["init", "-q"], { cwd: dir })
			await spawnGit(
				["-c", "protocol.version=2", "fetch", repoUrl(fx, repo), "refs/heads/main"],
				{ cwd: dir },
			)
			await spawnGit(["update-ref", "refs/heads/main", "FETCH_HEAD"], { cwd: dir })
			return gitReachableOids(dir)
		})
	}

	// SCH-8 — Tenant isolation through the loop. ONE fixture, several repos all made
	// eligible (each pushed → `last_pushed_at` set, none yet GC'd), then a SINGLE
	// `drainOnce({ graceSeconds: 0, concurrency: 4 })`. Repos:
	//   - four force-commit repos (sch8-f0..f3): each pushed then force-committed, so
	//     each holds orphans (the prior tip's objects) that the drain must reclaim;
	//   - one single-push repo (sch8-solo): pushed exactly once, NO orphans, but still
	//     eligible (last_pushed_at set, last_gc_at null) — it must be GC'd (appear in
	//     the summary) yet survive byte-for-byte intact.
	// Every repo uses a DISTINCT file path + body, so their reachable closures are
	// pairwise disjoint — that disjointness is what makes cross-repo contamination
	// observable (no repo's survivor set may contain another repo's objects).
	//
	// Why a wrong impl fails: (a) a per-repo over-reach (A's GC deleting B's rows)
	// shows up as B's survivors !== B's closure or B's clone breaking; (b) a per-repo
	// under-reach (orphans left behind) shows up as a force-repo's survivors strictly
	// containing its orphans (!== closure); (c) a drain that skips eligible repos
	// (e.g. ignores the no-orphan solo repo, or only does a subset under concurrency)
	// shows up as a missing summary entry or un-reclaimed orphans; (d) cross-repo
	// bleed shows up in the explicit "no repo's survivors intersect another's" check.
	it("SCH-8: one drain GCs every eligible repo correctly with no cross-repo bleed", async () => {
		const forceRepos = ["sch8-f0", "sch8-f1", "sch8-f2", "sch8-f3"]
		const soloRepo = "sch8-solo"
		const allRepos = [...forceRepos, soloRepo]

		// Build the force-commit repos: an initial push, then a force-commit from an
		// independent root → the prior tip's objects are orphaned in Postgres. Each
		// repo's content is unique to keep all closures pairwise disjoint.
		for (const repo of forceRepos) {
			await pushFile(fx, repo, { content: `${repo}-v1\n`, path: `${repo}.txt` })
			const tip = await pushFile(fx, repo, {
				content: `${repo}-v2\n`,
				force: true,
				path: `${repo}.txt`,
			})
			// Sanity: the force-commit actually orphaned objects (so reclamation is not
			// vacuous) — there exist stored objects outside this tip's closure.
			const tipClosure = new Set(tip.reachable)
			const stored = await objectOids(fx.db, repo)
			expect(stored.some((oid) => !tipClosure.has(oid))).toBe(true)
		}

		// The single-push repo: eligible (pushed once, never GC'd) but with NO orphans
		// — its stored objects already equal its reachable closure.
		const soloTip = await pushFile(fx, soloRepo, {
			content: `${soloRepo}-only\n`,
			path: `${soloRepo}.txt`,
		})

		// Every repo is eligible: each was pushed (so the store must have stamped
		// `last_pushed_at`) and none has been GC'd. Age every repo's rows past the
		// grace cutoff so a single `graceSeconds: 0` drain is free to reclaim orphans.
		for (const repo of allRepos) await ageObjects(fx.db, repo, "1 hour")

		// ONE pass, concurrency > 1 so multiple repos GC at once. Only the OUTCOME is
		// asserted; nothing about the concurrency mechanism is observed.
		const scheduler = createGcScheduler(fx.db.sql, {
			concurrency: 4,
			graceSeconds: 0,
			intervalMs: 30_000,
		})
		const summary = await scheduler.drainOnce()

		// The drain judged EXACTLY the five eligible repos (the eligible set is
		// observable via the summary). A missing entry = an eligible repo skipped.
		expect(summary.map((entry) => entry.repo).sort()).toEqual([...allRepos].sort())

		// Per repo, INDEPENDENTLY: survivors in Postgres == that repo's own real-git
		// reachable closure of its current tip, and a clone is its own latest content
		// + fsck-clean. We collect each repo's survivor set to also prove disjointness.
		const survivorsByRepo = new Map<string, string[]>()
		for (const repo of allRepos) {
			const expected = await reachableOfTip(repo)
			const survivors = await objectOids(fx.db, repo)
			survivorsByRepo.set(repo, survivors)
			// Exact equality: orphans gone (force repos) AND nothing live lost.
			expect(survivors).toEqual(expected)
		}

		// Each force repo clones to its v2 tip + content, fsck-clean — unaffected by
		// the others' concurrent GC.
		for (const repo of forceRepos) {
			const clone = await cloneAndFsck(fx, repo, "refs/heads/main", `${repo}.txt`)
			expect(clone.fileContent).toBe(`${repo}-v2\n`)
		}
		// The solo repo survived its drain intact: same tip, same single-push content,
		// fsck-clean — GC'd-but-nothing-to-reclaim, not corrupted.
		const soloClone = await cloneAndFsck(
			fx,
			soloRepo,
			"refs/heads/main",
			`${soloRepo}.txt`,
		)
		expect(soloClone.head).toBe(soloTip.head)
		expect(soloClone.fileContent).toBe(`${soloRepo}-only\n`)

		// CROSS-REPO ISOLATION: no repo's survivor set contains ANY other repo's
		// objects. Because every repo's content is unique, the closures are pairwise
		// disjoint; a drain that deleted or kept B's rows while GCing A would surface
		// here as an intersection (a foreign oid bleeding into a survivor set).
		for (const repo of allRepos) {
			const mine = survivorsByRepo.get(repo) ?? []
			const mineSet = new Set(mine)
			for (const other of allRepos) {
				if (other === repo) continue
				const theirs = survivorsByRepo.get(other) ?? []
				for (const oid of theirs) {
					expect(mineSet.has(oid)).toBe(false)
				}
			}
		}
	})
})

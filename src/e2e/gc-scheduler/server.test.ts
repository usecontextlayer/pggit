import { setTimeout as sleep } from "node:timers/promises"
import type { Kysely } from "kysely"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type Database, initKysely } from "@/database"
import { applyMigrations } from "@/database/migrate"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort, startServer } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import {
	ageObjects,
	cloneAndFsck,
	encodingViolations,
	objectOids,
	pushFile,
	repoGcState,
} from "@/testing/gc-helpers"

/**
 * GC scheduler — server wiring & config (`docs/2026-06-24-gc-scheduler-design.md`
 * §6 "Isolation & robustness"): SCH-9 (disabled = inert) and SCH-10 (standalone
 * server self-GCs; the mounted `createGitApp` path with no scheduler is
 * unchanged). These are BLACK-BOX tests of `startServer` (§4 wires the scheduler
 * over the same `pg`, `start()`s it when enabled, `stop()`s it in `close()`).
 *
 * OBSERVABLE-ONLY (§6): every assertion is on the real `git` oracle
 * (clone/fetch/fsck via `cloneAndFsck`), Postgres rows (`git_object` via
 * `objectOids`, scheduling state via `repoGcState`, and encoding coverage), or — for the
 * mount comparison — the absence of any reclamation. Nothing probes scheduler
 * internals (timer mechanics, the candidate SQL, concurrency choreography); the
 * orphan set is computed from the `git` reachable closures `pushFile` returns.
 * Determinism: orphan eligibility is set by `ageObjects` backdating rows PAST a
 * real grace window, never a wall-clock grace wait. The enabled scheduler runs
 * with a NONZERO grace on purpose: grace is what shields in-flight pushes and
 * fetches from a drain tick's stale-refs scan, and with `graceSeconds: 0` the
 * 50 ms cadence can reclaim a just-pushed closure mid-fetch (observed: a fetch
 * refused with "not our ref" on its own freshly pushed tip). SCH-10's self-GC is
 * the ONE place a real timer is exercised, so it POLLS (bounded) for the
 * observable reclamation effect.
 *
 * The PUBLIC schema on the shared `globalSetup` container: `startServer` builds its
 * own porsager client from `databaseUrl` and sets no per-connection `search_path`, so
 * the isolated-schema `setupGcFixture` (which hides the schema behind `search_path`)
 * cannot back it. We migrate `public` ourselves and keep a raw `postgres(uri)` client
 * (passed as `{ sql }`) for the row helpers. No other test touches `public`, so this
 * stays isolated from the schema-per-file tests sharing the container.
 *
 * These cases pin the server wiring and activity-stamp contracts under §6.
 */
describe("GC scheduler — server wiring & config (§6: SCH-9, SCH-10)", () => {
	const POLL_TIMEOUT_MS = 8000
	const POLL_STEP_MS = 100
	const SCHEDULER_OBSERVATION_WINDOW_MS = 2000

	let db: Kysely<Database>
	let pg: Sql
	let baseUrl: string

	beforeAll(async () => {
		// `applyMigrations` (each up() once, no tracking table), NOT `migrateToLatest`:
		// on the shared globalSetup container, Kysely's Migrator introspects EVERY schema
		// to check its bookkeeping table and throws `3F000` the moment a sibling test
		// `DROP SCHEMA … CASCADE`s a `t_<uuid>` schema mid-introspection. `public` here is
		// a throwaway-per-run schema (only this file touches it), so it needs each
		// migration exactly once with no incremental tracking — the race-free path.
		baseUrl = inject("pgBaseUrl")
		pg = postgres(baseUrl)
		db = initKysely<Database>(pg)
		await applyMigrations(db)
	}, 180_000)

	afterAll(async () => {
		await db?.destroy()
		await pg?.end()
	})

	/** The DB shape the row helpers want (`{ sql }`), backed by our public-schema
	 * client — `objectOids` / `ageObjects` / `repoGcState` resolve `git_object` and
	 * `repos` in `public`. */
	const sqlDb = (): { sql: Sql } => ({ sql: pg })

	/** A `Pick<GcFixture, "server" | "refs">` shape so the gc-helpers' URL builder,
	 * `pushFile` (including its store-level rewind), and `cloneAndFsck` target one of
	 * our dedicated servers. */
	const at = (s: GitServer): { server: GitServer; refs: RefStore } => ({
		// Built on demand over the shared client — createRefStore is a cheap wrapper.
		refs: createRefStore(pg),
		server: s,
	})

	/** The orphan OID set a store-level rewind leaves behind: reachable(before) minus
	 * reachable(after), both from real-git closures `pushFile` returns. Distinct
	 * roots ⇒ disjoint closures, so this is the prior tip's whole closure — exactly
	 * what GC must reclaim once aged. */
	async function pushThenRewindOrphan(
		s: GitServer,
		repo: string,
	): Promise<{ orphans: string[]; head: string }> {
		const r1 = await pushFile(at(s), repo, { content: `${repo} v1\n` })
		const r2 = await pushFile(at(s), repo, { content: `${repo} v2\n`, rewind: true })
		const live = new Set(r2.reachable)
		const orphans = r1.reachable.filter((oid) => !live.has(oid))
		return { head: r2.head, orphans }
	}

	/** Poll `predicate` on a fixed cadence up to a fixed deadline; resolve on the
	 * first true, else throw a clear timeout (never an unbounded wait). The ONLY real-timer wait
	 * in the suite — SCH-10's self-GC reclamation is an asynchronous effect of the
	 * server's own `setInterval`, so it is polled for, not slept past. */
	async function pollUntil(
		label: string,
		predicate: () => Promise<boolean>,
	): Promise<void> {
		const deadline = Date.now() + POLL_TIMEOUT_MS
		for (;;) {
			if (await predicate()) return
			if (Date.now() >= deadline) {
				throw new Error(
					`pollUntil timed out after ${POLL_TIMEOUT_MS}ms waiting for: ${label}`,
				)
			}
			await sleep(POLL_STEP_MS)
		}
	}

	/** A fixed bounded wait — the controlled exception for asserting an ABSENCE (no
	 * reclamation): there is no event to poll for, so we wait a window comfortably
	 * larger than the scheduler interval and then assert nothing changed. */
	async function waitForSchedulerObservationWindow(): Promise<void> {
		await sleep(SCHEDULER_OBSERVATION_WINDOW_MS)
	}

	// SCH-10 — Standalone server self-GCs on its cadence; the mounted path is
	// unchanged. With GC enabled and a tiny interval, rewind orphans (aged
	// past a grace=0 cutoff) are reclaimed end-to-end via the server's own timer,
	// and a clone is fsck-clean at the latest tree. The SAME workload against a
	// `createGitApp` served with NO scheduler reclaims nothing over the same window
	// — proving GC runs only because the server wired it (not as a clone side
	// effect).
	it("SCH-10: an enabled startServer reclaims orphans on its cadence; an unscheduled mount does not", async () => {
		// Part 1 — an enabled server reclaims orphans via its OWN interval. Scoped so
		// its scheduler is STOPPED (close()) before Part 2 (and SCH-9) run: it shares
		// the `public` schema with them, so a still-running drain would reclaim their
		// repos and pollute the later no-reclamation assertions. Closing it here also
		// implicitly pins that close() halts the drain.
		// Nonzero grace: the drain ticks every 50 ms while the pushes and closure
		// fetches below are in flight, and grace is the only thing keeping their
		// fresh rows out of a stale-refs scan's reclaim set.
		const enabled = await startServer({
			databaseUrl: baseUrl,
			gc: { enabled: true, graceSeconds: 3600, intervalMs: 50 },
			port: 0,
		})
		try {
			const repo = "sch10-self-gc"
			const { head, orphans } = await pushThenRewindOrphan(enabled, repo)
			expect(orphans.length).toBeGreaterThan(0)

			// Age every row past the grace cutoff so the drain is free to reclaim the
			// orphans without any wall-clock grace wait.
			await ageObjects(sqlDb(), repo, "2 hours")

			// The server's own interval must drive a drain that removes the orphans AND
			// (repack phase, env-default-enabled — the drain-repack doc) brings the
			// encoding tier to coverage. Polled as a conjunction: repack runs after GC
			// within a pass, so orphans-gone alone could race the pass's second half.
			await pollUntil(
				`${repo} orphans reclaimed + tier covered by the scheduler`,
				async () => {
					const survivors = new Set(await objectOids(sqlDb(), repo))
					if (!orphans.every((oid) => !survivors.has(oid))) return false
					return (await encodingViolations(sqlDb(), repo)).length === 0
				},
			)

			// Reclamation happened, the tier covers the survivors, AND the repo still
			// clones clean at the latest tip.
			const survivors = new Set(await objectOids(sqlDb(), repo))
			for (const oid of orphans) expect(survivors.has(oid)).toBe(false)
			expect(await encodingViolations(sqlDb(), repo)).toEqual([])
			const clone = await cloneAndFsck(at(enabled), repo)
			expect(clone.head).toBe(head)
			expect(clone.fileContent).toBe(`${repo} v2\n`)
		} finally {
			await enabled.close()
		}

		// Part 2 — the mounted path is UNCHANGED. The same stores served via a bare
		// `createGitApp` with NO scheduler (and no enabled server now alive on this
		// schema): over a window larger than the interval, orphans persist — GC runs
		// only because a server wired it.
		const objects = createObjectStore(pg)
		const refs = createRefStore(pg)
		const mountSrv = await serveOnPort(createGitApp({ objects, refs }), 0)
		try {
			const mountRepo = "sch10-mount-unchanged"
			const mounted = await pushThenRewindOrphan(mountSrv, mountRepo)
			expect(mounted.orphans.length).toBeGreaterThan(0)
			await ageObjects(sqlDb(), mountRepo, "1 hour")

			// Wait comfortably past the interval a wired scheduler would have fired on,
			// then assert EVERY orphan still present (no reclamation on the mount path).
			await waitForSchedulerObservationWindow()
			const mountSurvivors = new Set(await objectOids(sqlDb(), mountRepo))
			for (const oid of mounted.orphans) expect(mountSurvivors.has(oid)).toBe(true)

			// And the mounted path still serves a clean clone at its latest tip.
			const mountClone = await cloneAndFsck(at(mountSrv), mountRepo)
			expect(mountClone.head).toBe(mounted.head)
			expect(mountClone.fileContent).toBe(`${mountRepo} v2\n`)
		} finally {
			await mountSrv.close()
		}
	}, 60_000)

	// SCH-9 — Disabled = inert. With `gc.enabled: false` no drain ever runs:
	// pushes still stamp `repos.last_pushed_at`, but no object is reclaimed and the
	// server serves exactly as today. (The "orphans persist" assertion must hold in
	// BOTH states — disabling stops the drain, not the stamp.)
	it("SCH-9: a disabled startServer never reclaims, yet still stamps last_pushed_at and serves clean", async () => {
		const disabled = await startServer({
			databaseUrl: baseUrl,
			gc: { enabled: false, graceSeconds: 0, intervalMs: 50 },
			port: 0,
		})
		try {
			const repo = "sch9-disabled"
			const { head, orphans } = await pushThenRewindOrphan(disabled, repo)
			expect(orphans.length).toBeGreaterThan(0)
			await ageObjects(sqlDb(), repo, "1 hour")

			// Wait the same bounded window an enabled server would have GC'd within,
			// then assert NO object was reclaimed — the drain is off.
			await waitForSchedulerObservationWindow()
			const survivors = new Set(await objectOids(sqlDb(), repo))
			for (const oid of orphans) expect(survivors.has(oid)).toBe(true)

			// Disabling stops the loop, NOT the stamp: the push still recorded activity.
			const state = await repoGcState(sqlDb(), repo)
			if (state.kind !== "pushed-never-drained") {
				throw new Error(`expected pushed, undrained repo ${repo}; got ${state.kind}`)
			}

			// The server still serves a complete, fsck-clean clone at the latest tip.
			const clone = await cloneAndFsck(at(disabled), repo)
			expect(clone.head).toBe(head)
			expect(clone.fileContent).toBe(`${repo} v2\n`)
		} finally {
			await disabled.close()
		}
	}, 60_000)
})

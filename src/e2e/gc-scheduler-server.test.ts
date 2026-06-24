import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import type { Kysely } from "kysely"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Database, initKysely } from "@/database"
import { migrateToLatest } from "@/database/migrate"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort, startServer } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import {
	ageObjects,
	cloneAndFsck,
	objectOids,
	pushFile,
	repoGcState,
} from "@/testing/gc-helpers"
import { startPostgres } from "@/testing/pg"

/**
 * GC scheduler — server wiring & config (`docs/2026-06-24-gc-scheduler-design.md`
 * §6 "Isolation & robustness"): SCH-9 (disabled = inert) and SCH-10 (standalone
 * server self-GCs; the mounted `createGitApp` path with no scheduler is
 * unchanged). These are BLACK-BOX tests of `startServer` (§4 wires the scheduler
 * over the same `pg`, `start()`s it when enabled, `stop()`s it in `close()`).
 *
 * OBSERVABLE-ONLY (§6): every assertion is on the real `git` oracle
 * (clone/fetch/fsck via `cloneAndFsck`), Postgres rows (`git_object` via
 * `objectOids`, the two scheduling columns via `repoGcState`), or — for the
 * mount comparison — the absence of any reclamation. Nothing probes scheduler
 * internals (timer mechanics, the candidate SQL, concurrency choreography); the
 * orphan set is computed from the `git` reachable closures `pushFile` returns.
 * Determinism: orphan age is set by `ageObjects` + `graceSeconds: 0`, never a
 * wall-clock grace wait. SCH-10's self-GC is the ONE place a real timer is
 * exercised, so it POLLS (bounded) for the observable reclamation effect.
 *
 * Dedicated DB on the PUBLIC schema: `startServer` builds its own porsager
 * client from `databaseUrl` and sets no per-connection `search_path`, so the
 * isolated-schema `setupGcFixture` (which hides the schema behind `search_path`)
 * cannot back it. We stand up our own container + `public`-schema migrations and
 * keep a raw `postgres(uri)` client (passed as `{ sql }`) for the row helpers.
 *
 * RED now because: the store does NOT yet stamp `repos.last_pushed_at` (stays
 * NULL after a push → SCH-9's stamp assertion fails) and `startServer` ignores
 * its `gc` opts (no drain is ever started → SCH-10's self-GC poll times out with
 * orphans never reclaimed). GREEN once §6 is implemented.
 */
describe("GC scheduler — server wiring & config (§6: SCH-9, SCH-10)", () => {
	let container: StartedPostgreSqlContainer
	let db: Kysely<Database>
	let pg: Sql

	beforeAll(async () => {
		container = await startPostgres()
		const uri = container.getConnectionUri()
		pg = postgres(uri)
		db = initKysely<Database>(pg)
		await migrateToLatest(db)
	}, 180_000)

	afterAll(async () => {
		await db?.destroy()
		await pg?.end()
		await container?.stop()
	})

	/** The DB shape the row helpers want (`{ sql }`), backed by our raw public-schema
	 * client — `objectOids` / `ageObjects` / `repoGcState` resolve `git_object` and
	 * `repos` in `public`. */
	const sqlDb = (): { sql: Sql } => ({ sql: pg })

	/** A `Pick<GcFixture, "server">` shape so the gc-helpers' URL builder, `pushFile`,
	 * and `cloneAndFsck` target one of our dedicated servers (the helpers read only
	 * `server.port`). */
	const at = (s: GitServer): { server: GitServer } => ({ server: s })

	/** The orphan OID set a force-commit leaves behind: reachable(before) minus
	 * reachable(after), both from real-git closures `pushFile` returns. Distinct
	 * roots ⇒ disjoint closures, so this is the prior tip's whole closure — exactly
	 * what GC must reclaim once aged. */
	async function pushThenForceOrphan(
		s: GitServer,
		repo: string,
	): Promise<{ orphans: string[]; head: string }> {
		const r1 = await pushFile(at(s), repo, { content: `${repo} v1\n` })
		const r2 = await pushFile(at(s), repo, { content: `${repo} v2\n`, force: true })
		const live = new Set(r2.reachable)
		const orphans = r1.reachable.filter((oid) => !live.has(oid))
		return { head: r2.head, orphans }
	}

	/** Poll `predicate` every `stepMs` up to `timeoutMs`; resolve on the first true,
	 * else throw a clear timeout (never an unbounded wait). The ONLY real-timer wait
	 * in the suite — SCH-10's self-GC reclamation is an asynchronous effect of the
	 * server's own `setInterval`, so it is polled for, not slept past. */
	async function pollUntil(
		label: string,
		predicate: () => Promise<boolean>,
		timeoutMs = 8000,
		stepMs = 100,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			if (await predicate()) return
			if (Date.now() >= deadline) {
				throw new Error(`pollUntil timed out after ${timeoutMs}ms waiting for: ${label}`)
			}
			await new Promise((resolve) => setTimeout(resolve, stepMs))
		}
	}

	/** A fixed bounded wait — the controlled exception for asserting an ABSENCE (no
	 * reclamation): there is no event to poll for, so we wait a window comfortably
	 * larger than the scheduler interval and then assert nothing changed. */
	async function waitMs(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms))
	}

	// SCH-10 — Standalone server self-GCs on its cadence; the mounted path is
	// unchanged. With GC enabled and a tiny interval, force-commit orphans (aged
	// past a grace=0 cutoff) are reclaimed end-to-end via the server's own timer,
	// and a clone is fsck-clean at the latest tree. The SAME workload against a
	// `createGitApp` served with NO scheduler reclaims nothing over the same window
	// — proving GC runs only because the server wired it (not as a clone side
	// effect). RED now: `startServer` ignores `gc` opts, so the self-GC poll times
	// out (orphans never reclaimed).
	it("SCH-10: an enabled startServer reclaims orphans on its cadence; an unscheduled mount does not", async () => {
		// Part 1 — an enabled server reclaims orphans via its OWN interval. Scoped so
		// its scheduler is STOPPED (close()) before Part 2 (and SCH-9) run: it shares
		// the `public` schema with them, so a still-running drain would reclaim their
		// repos and pollute the later no-reclamation assertions. Closing it here also
		// implicitly pins that close() halts the drain.
		const enabled = await startServer({
			databaseUrl: container.getConnectionUri(),
			gc: { enabled: true, graceSeconds: 0, intervalMs: 50 },
			port: 0,
		})
		try {
			const repo = "sch10-self-gc"
			const { head, orphans } = await pushThenForceOrphan(enabled, repo)
			expect(orphans.length).toBeGreaterThan(0)

			// Age every row past the grace=0 cutoff so the drain is free to reclaim the
			// orphans without any wall-clock grace wait.
			await ageObjects(sqlDb(), repo, "1 hour")

			// The server's own interval must drive a drain that removes the orphans —
			// poll the Postgres survivor set until none of the orphans remain.
			await pollUntil(`${repo} orphans reclaimed by the server's scheduler`, async () => {
				const survivors = new Set(await objectOids(sqlDb(), repo))
				return orphans.every((oid) => !survivors.has(oid))
			})

			// Reclamation happened AND the repo still clones clean at the latest tip.
			const survivors = new Set(await objectOids(sqlDb(), repo))
			for (const oid of orphans) expect(survivors.has(oid)).toBe(false)
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
			const mounted = await pushThenForceOrphan(mountSrv, mountRepo)
			expect(mounted.orphans.length).toBeGreaterThan(0)
			await ageObjects(sqlDb(), mountRepo, "1 hour")

			// Wait comfortably past the interval a wired scheduler would have fired on,
			// then assert EVERY orphan still present (no reclamation on the mount path).
			await waitMs(2000)
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
	// server serves exactly as today. RED now: the store does not yet stamp
	// `last_pushed_at` (stays NULL), so the stamp assertion fails. (The "orphans
	// persist" assertion must hold in BOTH states — disabling stops the drain, not
	// the stamp.)
	it("SCH-9: a disabled startServer never reclaims, yet still stamps last_pushed_at and serves clean", async () => {
		const disabled = await startServer({
			databaseUrl: container.getConnectionUri(),
			gc: { enabled: false, graceSeconds: 0, intervalMs: 50 },
			port: 0,
		})
		try {
			const repo = "sch9-disabled"
			const { head, orphans } = await pushThenForceOrphan(disabled, repo)
			expect(orphans.length).toBeGreaterThan(0)
			await ageObjects(sqlDb(), repo, "1 hour")

			// Wait the same bounded window an enabled server would have GC'd within,
			// then assert NO object was reclaimed — the drain is off.
			await waitMs(2000)
			const survivors = new Set(await objectOids(sqlDb(), repo))
			for (const oid of orphans) expect(survivors.has(oid)).toBe(true)

			// Disabling stops the loop, NOT the stamp: the push still recorded activity.
			const state = await repoGcState(sqlDb(), repo)
			expect(state.lastPushedAt).not.toBeNull()

			// The server still serves a complete, fsck-clean clone at the latest tip.
			const clone = await cloneAndFsck(at(disabled), repo)
			expect(clone.head).toBe(head)
			expect(clone.fileContent).toBe(`${repo} v2\n`)
		} finally {
			await disabled.close()
		}
	}, 60_000)
})

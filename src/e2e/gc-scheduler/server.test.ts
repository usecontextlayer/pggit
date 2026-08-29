import { setTimeout as sleep } from "node:timers/promises"
import type { Kysely } from "kysely"
import postgres, { type Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type Database, initKysely } from "@/database"
import { applyMigrations } from "@/database/migrate"
import { createGcDrain } from "@/gc-drain"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort, startServer } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import {
	ageObjects,
	cloneAndFsck,
	encodingRows,
	encodingViolations,
	objectOids,
	pushFile,
	repoGcState,
} from "@/testing/gc-helpers"

/**
 * SCH-10 exercises the real server timer with nonzero grace: a zero-grace tick
 * may scan stale refs while a push or fetch is still using its fresh closure.
 * The asynchronous drain effect is therefore polled to a bound. `startServer`
 * also creates its own clients without an isolated `search_path`, so this file
 * migrates and queries the shared container's `public` schema directly.
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

	const publicSchemaDb = (): { sql: Sql } => ({ sql: pg })

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
			await ageObjects(publicSchemaDb(), repo, "2 hours")

			await pollUntil(
				`${repo} orphans reclaimed + tier covered by the scheduler`,
				async () => {
					const survivors = new Set(await objectOids(publicSchemaDb(), repo))
					if (!orphans.every((oid) => !survivors.has(oid))) return false
					return (await encodingViolations(publicSchemaDb(), repo)).length === 0
				},
			)

			const survivors = new Set(await objectOids(publicSchemaDb(), repo))
			for (const oid of orphans) expect(survivors.has(oid)).toBe(false)
			expect(await encodingViolations(publicSchemaDb(), repo)).toEqual([])
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
			await ageObjects(publicSchemaDb(), mountRepo, "1 hour")

			// Wait comfortably past the interval a wired scheduler would have fired on,
			// then assert EVERY orphan still present (no reclamation on the mount path).
			await waitForSchedulerObservationWindow()
			const mountSurvivors = new Set(await objectOids(publicSchemaDb(), mountRepo))
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
			await ageObjects(publicSchemaDb(), repo, "1 hour")

			// Wait the same bounded window an enabled server would have GC'd within,
			// then assert NO object was reclaimed — the drain is off.
			await waitForSchedulerObservationWindow()
			const survivors = new Set(await objectOids(publicSchemaDb(), repo))
			for (const oid of orphans) expect(survivors.has(oid)).toBe(true)

			// Disabling stops the loop, NOT the stamp: the push still recorded activity.
			const state = await repoGcState(publicSchemaDb(), repo)
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

	it("createGcDrain defaults explicitly-undefined tunable overrides", async () => {
		const mountSrv = await serveOnPort(
			createGitApp({ objects: createObjectStore(pg), refs: createRefStore(pg) }),
			0,
		)
		try {
			const drain = createGcDrain(baseUrl, {
				concurrency: undefined,
				graceSeconds: undefined,
				intervalMs: undefined,
				repackEnabled: undefined,
			})
			try {
				const repo = "gc-drain-undefined-overrides"
				await pushFile(at(mountSrv), repo, { content: "undefined overrides\n" })

				// Default grace keeps this just-pushed repo unsettled, but grace never gates
				// repack; direct drainOnce also makes the default interval irrelevant.
				const summary = await drain.drainOnce()
				const entry = summary.find((candidate) => candidate.repo === repo)
				if (entry === undefined) throw new Error(`drain summary omitted ${repo}`)
				if (entry.repack === null) {
					throw new Error(`drain entry for ${repo} carries no repack result`)
				}

				const coveredRows = await encodingRows(publicSchemaDb(), repo)
				expect(coveredRows.length).toBeGreaterThan(0)
				expect(entry.repack.wholes + entry.repack.deltas).toBe(coveredRows.length)
				expect(await encodingViolations(publicSchemaDb(), repo)).toEqual([])
			} finally {
				await drain.stop()
			}
		} finally {
			await mountSrv.close()
		}
	}, 60_000)

	// The host's log is the drain's ONLY failure surface (the watermarks are its
	// success surface, so a healthy pass says nothing) — and a pass MANUFACTURES
	// Postgres notices: every gc opens with `drop table if exists gc_live` on a
	// fresh reserved connection, which the server NOTICEs as absent. A pool that
	// does not silence them hands each to porsager's default handler, `console.log`,
	// so the drain buries the surface it depends on. Driven end-to-end — real pool,
	// real Postgres, real notices — because whether a notice prints is the driver's
	// behaviour over the wire, and a fake of it could only restate this assumption.
	// Placed LAST on purpose: this pass drains every candidate in the shared
	// `public` schema, so ahead of SCH-9/SCH-10 it would reclaim their repos and
	// break their no-reclamation assertions.
	it("drains without printing: the pool's Postgres notices never reach the host's log", async () => {
		const mountSrv = await serveOnPort(
			createGitApp({ objects: createObjectStore(pg), refs: createRefStore(pg) }),
			0,
		)
		try {
			const drain = createGcDrain(baseUrl)
			try {
				const repo = "gc-drain-silent-pass"
				await pushFile(at(mountSrv), repo, { content: "silent pass\n" })

				const printed: string[] = []
				const realLog = console.log.bind(console)
				console.log = (...args: unknown[]) => {
					// Notices arrive as plain objects, so render them: a failure here must
					// say WHICH notice got through, not `[object Object]`.
					printed.push(
						args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
					)
				}
				const summary = await drain.drainOnce().finally(() => {
					console.log = realLog
				})

				// Silence is evidence only once the pass has actually run the GC arm the
				// notices come from: a pass that selected nothing is quiet either way.
				const entry = summary.find((candidate) => candidate.repo === repo)
				if (entry === undefined) throw new Error(`drain summary omitted ${repo}`)
				if (entry.gc === null) {
					throw new Error(`drain pass ran no GC on ${repo}; its silence proves nothing`)
				}

				expect(printed).toEqual([])
			} finally {
				await drain.stop()
			}
		} finally {
			await mountSrv.close()
		}
	}, 60_000)
})

/**
 * PG NAMESPACE PROBE — two isolated schemas share ONE database. Does anything leak?
 *
 * `createIsolatedSchema` carves a schema per test/composition out of ONE postgres
 * database, and `repos.id` is a per-schema identity sequence, so the SAME surrogate
 * id (1, 2, 3…) exists in every schema simultaneously. Several things in this
 * codebase are named by that id, or by a bare relation name, and are resolved
 * through `search_path` rather than being schema-qualified in the SQL:
 *
 *   gc.ts        `create temp table gc_live`             (TEMP since D12; resolves
 *                via pg_temp ahead of the schema — session-private BY DESIGN, so
 *                the cross-schema question this test asks is now answered
 *                structurally for the live set; the probe still earns its keep
 *                on the remaining unqualified names below)
 *   gc.ts        `vacuum (analyze) git_object`, `vacuum (analyze)
 *                git_pack_encoding`
 *   copy-insert  `create temp table copy_stg_${target}`  (target-named)
 *
 * If any of those resolved database-globally instead of per-schema, two schemas
 * running the same repo NAME (hence the same repo id) would collide: B's `truncate`
 * or `drop` could wipe A's live set mid-sweep and A's anti-join would then match —
 * and delete — its entire reachable set. That is the shape the GC docstring itself
 * warns about for two PROCESSES; this test asks the same question for two SCHEMAS.
 *
 * Method: identical repo names, DIFFERENT content, every phase run CONCURRENTLY in
 * both schemas (push, repack, gc, clone ×2 rounds), then each clone byte-compared
 * against its OWN source and each schema's object inventory checked for the other's
 * oids. Both schemas come from `inject("pgBaseUrl")` — the SAME container database,
 * which is the entire point.
 *
 * Converted from `breakage/pg-corrupt--cross-schema-bleed.ts`, whose verdict was:
 * exit 0 = no bleed; non-zero = cross-contamination, with the leaked oids printed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { parseRevListObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** IDENTICAL on both sides — so both schemas mint the same `repos.id`. */
const REPO = "workspace/probe/collide"
const STEPS = 45
const ROUNDS = [1, 2]

type Side = {
	tag: string
	db: IsolatedDb
	server: GitServer
	url: string
	src: string
	tip: string
}

describe("pg-corrupt — two same-named repos in two schemas of one database", () => {
	let alpha: Side
	let beta: Side
	let sides: Side[] = []
	const dirs: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-bleed-${tag}-`))
		dirs.push(d)
		return d
	}

	async function buildSource(tag: string): Promise<{ dir: string; tip: string }> {
		const dir = mk(`src-${tag}`)
		await spawnGit(["init", "-q", "-b", "main", dir])
		for (let i = 0; i < STEPS; i++) {
			writeFileSync(join(dir, "grow.jsonl"), `{"side":"${tag}","i":${i}}\n`.repeat(i + 1))
			writeFileSync(join(dir, `f-${tag}-${i}.txt`), `${tag} payload ${i}\n`.repeat(20))
			await spawnGit(["add", "-A"], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", `${tag} ${i}`], { cwd: dir })
		}
		const tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
		return { dir, tip }
	}

	async function makeSide(tag: string): Promise<Side> {
		const { dir, tip } = await buildSource(tag)
		const db = await createIsolatedSchema(inject("pgBaseUrl"))
		const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		return {
			db,
			server,
			src: dir,
			tag,
			tip,
			url: `http://127.0.0.1:${server.port}/${REPO}`,
		}
	}

	/** The oids the schema holds for this repo name, straight out of `git_object`. */
	async function storedOids(db: IsolatedDb): Promise<Set<string>> {
		const rows = await db.sql<{ oid: string }[]>`
			select encode(o.oid, 'hex') as oid from git_object o
				join repos r on r.id = o.repo_id where r.name = ${REPO}`
		return new Set(rows.map((r) => r.oid))
	}

	/** Every reachable object oid in a real repo working copy. */
	async function repoOids(dir: string): Promise<Set<string>> {
		const out = await spawnGit(["rev-list", "--objects", "--all"], { cwd: dir })
		return new Set(parseRevListObjectOids(out.stdout))
	}

	beforeAll(async () => {
		alpha = await makeSide("alpha")
		beta = await makeSide("beta")
		sides = [alpha, beta]
		console.log(`schemas: ${alpha.db.schema} / ${beta.db.schema} (same database)`)

		// CONCURRENT push — both schemas mint repo id 1 at the same moment.
		await Promise.all(
			sides.map((s) =>
				spawnGit(["push", "-q", s.url, "refs/heads/main:refs/heads/main"], {
					cwd: s.src,
				}),
			),
		)
		const ids = await Promise.all(
			sides.map(
				async (s) =>
					(await s.db.sql<{ id: string }[]>`select id from repos where name = ${REPO}`)[0]
						?.id,
			),
		)
		console.log(
			`repos.id per schema: ${ids.join(" / ")} (identical ⇒ gc_live_N collides by name)`,
		)
		// The premise, not an observation: `repos.id` is a per-schema identity
		// sequence and each schema is freshly migrated, so both sides must mint the
		// SAME id for the same repo name. If they ever diverge, every id-named
		// object below (`gc_live_<id>`, `copy_stg_<target>`) lands in a distinct
		// name per schema and the collision surface this file exists to probe is
		// not exercised at all — while both rounds still pass.
		expect(
			ids[0],
			"the id-collision surface requires both schemas to mint the same repos.id",
		).toBe(ids[1])
	}, 900_000)

	afterAll(async () => {
		for (const s of sides) {
			await s.server.close()
			await s.db.drop()
		}
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	for (const round of ROUNDS) {
		it(`round ${round}: concurrent repack + gc + clone leaves each schema's history intact`, async () => {
			// Interleaved as hard as possible: gc_live_<id> is created, truncated,
			// loaded, swept and dropped by both sides at once, while both serve a
			// mirror clone.
			const targets = sides.map((s) => ({
				dest: join(mk(`clone-${s.tag}-${round}`), "c"),
				side: s,
			}))
			const [repacks, gcs] = await Promise.all([
				Promise.all(sides.map((s) => createRepack(s.db.sql).repack(REPO))),
				Promise.all(sides.map((s) => createGc(s.db.sql).gc(REPO, { graceSeconds: 0 }))),
				Promise.all(
					targets.map((t) =>
						spawnGit([
							"-c",
							"protocol.version=2",
							"clone",
							"-q",
							"--mirror",
							t.side.url,
							t.dest,
						]),
					),
				),
			])
			console.log(
				`round ${round}: repack ${repacks
					.map((r) => `${r.wholes}w/${r.deltas}d`)
					.join(" ")} | gc ${gcs.map((r) => `${r.deletedObjects}obj`).join(" ")}`,
			)

			const problems: string[] = []
			for (const { dest, side } of targets) {
				await spawnGit(["fsck", "--full", "--strict", "--no-dangling"], { cwd: dest })
				const tip = (
					await spawnGit(["rev-parse", "refs/heads/main"], { cwd: dest })
				).stdout.trim()
				if (tip !== side.tip) {
					problems.push(`${side.tag}: clone tip ${tip} != source tip ${side.tip}`)
				}
				// Byte-compare EVERY object against the source.
				for (const oid of await repoOids(dest)) {
					const got = (await spawnGit(["cat-file", "-p", oid], { cwd: dest })).stdoutBytes
					const want = (await spawnGit(["cat-file", "-p", oid], { cwd: side.src }))
						.stdoutBytes
					if (!got.equals(want)) problems.push(`${side.tag}: object ${oid} BYTES DIFFER`)
				}
			}

			// Inventory cross-check: neither schema may hold the other's objects, and
			// neither may have lost one of its own to the other's concurrent sweep.
			const [alphaStored, betaStored] = await Promise.all([
				storedOids(alpha.db),
				storedOids(beta.db),
			])
			for (const [self, other, side] of [
				[alphaStored, betaStored, alpha],
				[betaStored, alphaStored, beta],
			] as const) {
				const own = await repoOids(side.src)
				const foreign = [...self].filter((o) => !own.has(o) && other.has(o))
				if (foreign.length > 0) {
					problems.push(
						`${side.tag}: holds ${foreign.length} FOREIGN oids: ${foreign.slice(0, 5).join(", ")}`,
					)
				}
				const lost = [...own].filter((o) => !self.has(o))
				if (lost.length > 0) {
					problems.push(
						`${side.tag}: ${lost.length} reachable object(s) MISSING after concurrent gc: ${lost.slice(0, 5).join(", ")}`,
					)
				}
			}
			expect(problems).toEqual([])
		}, 900_000)
	}
})

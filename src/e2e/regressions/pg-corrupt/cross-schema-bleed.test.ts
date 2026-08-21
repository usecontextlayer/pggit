/**
 * PG NAMESPACE PROBE — two isolated schemas share ONE database. Does anything leak?
 *
 * `createIsolatedSchema` carves a schema per test/composition out of ONE postgres
 * database. Several operations use bare relation names resolved through
 * `search_path` rather than schema-qualified SQL:
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
 * running the same repo name would collide: B's `truncate`
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
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import {
	gitReachableOids,
	listDifferences,
	objectBytesDigest,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

/** Identical on both sides so only schema isolation distinguishes the stores. */
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
		const { db, server } = await setupGitServerFixture()
		return {
			db,
			server,
			src: dir,
			tag,
			tip,
			url: repoUrl(server, REPO),
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
		return new Set(await gitReachableOids(dir))
	}

	beforeAll(async () => {
		alpha = await makeSide("alpha")
		beta = await makeSide("beta")
		sides = [alpha, beta]
		console.log(`schemas: ${alpha.db.schema} / ${beta.db.schema} (same database)`)

		// CONCURRENT push of the same repo name through both schemas.
		await Promise.all(
			sides.map((s) =>
				spawnGit(["push", "-q", s.url, "refs/heads/main:refs/heads/main"], {
					cwd: s.src,
				}),
			),
		)
	}, 900_000)

	afterAll(async () => {
		for (const s of sides) {
			await teardownGitServerFixture(s)
		}
		for (const d of dirs) rmSync(d, { force: true, recursive: true })
	})

	for (const round of ROUNDS) {
		it(`round ${round}: concurrent repack + gc + clone leaves each schema's history intact`, async () => {
			// Interleaved as hard as possible: `gc_live` is created, truncated, loaded,
			// swept and dropped by both sides at once, while both serve a
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
				const cloneOids = [...(await repoOids(dest))].sort()
				const sourceOids = [...(await repoOids(side.src))].sort()
				const objectDiff = listDifferences(cloneOids, sourceOids)
				if (objectDiff.onlyLeft.length > 0 || objectDiff.onlyRight.length > 0) {
					problems.push(
						`${side.tag}: clone object set differs from source ` +
							`(clone-only ${objectDiff.onlyLeft.length}, source-only ${objectDiff.onlyRight.length})`,
					)
				} else if (
					(await objectBytesDigest(dest, cloneOids)) !==
					(await objectBytesDigest(side.src, sourceOids))
				) {
					problems.push(`${side.tag}: clone object bytes differ from source`)
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

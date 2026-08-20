/**
 * PROBE: deep directory nesting. `encodeTreePair` recurses once per level of a
 * changed path, and every level is an `await` — so a repo whose churn happens at
 * the bottom of a deep tree drives a recursion as deep as the path. Does it
 * survive, and what does the pass cost versus real `git repack -adf` on the same
 * repo?
 *
 * A crash here is a correctness finding, not a performance one: the repo becomes
 * permanently un-repackable and every explicit repack pass fails.
 *
 * The deepest case also gets a real clone + `git fsck --strict` off the wire, so a
 * silently-wrong pack cannot pass as a fast one.
 *
 * Routed as a perf harness because the EXIT verdict is the wall-time ratio
 * threshold against `git repack -adf`; the crash and the fsck oracle ride along as
 * sub-checks that also flip the exit code.
 *
 *   NODE_OPTIONS=--expose-gc npx tsx perf/breakage/perf--deep-nesting.ts [--depths=125,250,500,1000,2000]
 */
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import {
	allObjectOids,
	assertCanonicalStoreFixture,
	canonicalStoreRefsOf,
	loadGitObjects,
	repackEligibleObjects,
	revParse,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"
import { increasingIntegerListArg, parseArgs, pgUrlArg } from "../args"
import {
	cleanupTmp,
	gitRepack,
	importRepo,
	mb,
	mkTmp,
	secs,
	seedRepo,
	table,
	withPeakRss,
} from "./_perf-util"

const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
const { depths: DEPTHS, pg: PG_URL } = parseArgs(
	z
		.object({
			depths: increasingIntegerListArg([125, 250, 500, 1000, 2000]),
			pg: pgUrlArg,
		})
		.strict(),
)
const COMMITS = 16
const RATIO_LIMIT = 20

function stream(depth: number): string {
	const path = `${Array.from({ length: depth }, (_, i) => `d${i % 10}${i}`).join("/")}/leaf.txt`
	const out: string[] = []
	let mark = 0
	type CommitParent = { kind: "root" } | { kind: "child"; mark: number }
	let parent: CommitParent = { kind: "root" }
	for (let c = 0; c < COMMITS; c++) {
		const body = `version ${c}\n`
		const bm = ++mark
		out.push(`blob\nmark :${bm}\ndata ${body.length}\n${body}\n`)
		const cm = ++mark
		const msg = `c${c}`
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata ${msg.length}\n${msg}\n` +
				(parent.kind === "root" ? "" : `from :${parent.mark}\n`) +
				`M 100644 :${bm} ${path}\n`,
		)
		parent = { kind: "child", mark: cm }
	}
	return out.join("")
}

async function main(): Promise<void> {
	const rows: (string | number)[][] = []
	let crashed = false
	let worstRatio = 0
	let fsckNote = "not run"

	for (const depth of DEPTHS) {
		const dir = await importRepo(`deep-${depth}`, stream(depth))
		try {
			const expectedOids = await allObjectOids(dir)
			const expectedObjects = await loadGitObjects(dir, expectedOids)
			const expectedTip = await revParse(dir, "refs/heads/main")
			const git = await gitRepack(dir, `deep-git-${depth}`)
			if (git.ms <= 0)
				throw new Error(`depth ${depth}: canonical git timer was nonpositive`)
			const db = await createIsolatedSchema(PG_URL)
			try {
				const seeded = await seedRepo(db.sql, "probe/deep", dir)
				if (seeded.objects !== expectedOids.length) {
					throw new Error(
						`depth ${depth}: seeded ${seeded.objects}/${expectedOids.length} canonical objects`,
					)
				}
				let outcome = ""
				let ms = 0
				let rss = 0
				let caseCrashed = false
				try {
					const r = await withPeakRss(() => createRepack(db.sql).repack("probe/deep"))
					if (
						r.value.wholes + r.value.deltas !== seeded.eligibleObjects ||
						r.value.deltas <= 0
					) {
						throw new Error(
							`repack covered ${r.value.wholes + r.value.deltas}/${seeded.eligibleObjects} eligible objects with ${r.value.deltas} deltas`,
						)
					}
					ms = r.ms
					if (ms <= 0)
						throw new Error(`depth ${depth}: pggit repack timer was nonpositive`)
					rss = r.peakRss - r.baseRss
					outcome = `${r.value.wholes}w+${r.value.deltas}d`
					await assertCanonicalStoreFixture(db.sql, "probe/deep", {
						encodings: {
							kind: "exact",
							objects: repackEligibleObjects(expectedObjects),
						},
						objects: expectedObjects,
						refs: await canonicalStoreRefsOf(dir),
					})
					worstRatio = Math.max(worstRatio, ms / git.ms)
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e)
					outcome = `THREW: ${message.slice(0, 50)}`
					caseCrashed = true
					crashed = true
				}
				rows.push([
					depth,
					seeded.objects,
					mb(seeded.rawBytes),
					secs(ms),
					mb(rss),
					secs(git.ms),
					caseCrashed ? "—" : `${(ms / git.ms).toFixed(1)}×`,
					outcome,
				])

				// Deepest case: a real clone must round-trip through canonical git.
				if (depth === DEPTHS[DEPTHS.length - 1] && !caseCrashed) {
					const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
					const dest = join(mkTmp("deep-clone"), "c")
					mkdirSync(dest, { recursive: true })
					try {
						await spawnGit([
							"-c",
							"protocol.version=2",
							"clone",
							"-q",
							"--bare",
							`http://127.0.0.1:${server.port}/probe/deep`,
							dest,
						])
						await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
						const gotOids = await allObjectOids(dest)
						const gotTip = await revParse(dest, "refs/heads/main")
						if (
							gotTip !== expectedTip ||
							gotOids.length !== expectedOids.length ||
							gotOids.some((oid, i) => oid !== expectedOids[i])
						) {
							throw new Error("deep clone diverged from canonical refs/object set")
						}
						fsckNote = "clone + fsck --strict clean"
					} catch (e) {
						const message = e instanceof Error ? e.message : String(e)
						fsckNote = `CLONE/FSCK FAILED: ${message.slice(0, 120)}`
						crashed = true
					} finally {
						await server.close()
					}
				}
			} finally {
				await db.drop()
			}
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}

	console.log(`# deep nesting — ${COMMITS} commits changing one file at depth D\n`)
	console.log(
		table(
			[
				"depth",
				"objects",
				"raw MB",
				"pggit repack s",
				"ΔRSS MB",
				"git repack s",
				"pggit/git",
				"outcome",
			],
			rows,
		),
	)
	console.log(`\ndeepest clone: ${fsckNote}`)
	console.log(
		`\nFAIL CONDITION: repack throws / serves a bad pack, or costs > ${RATIO_LIMIT}× git's repack.`,
	)
	console.log(`observed worst ratio: ${worstRatio.toFixed(1)}×`)
	if (crashed || worstRatio > RATIO_LIMIT) process.exitCode = 1
}

main()
	.catch((err) => {
		console.error(err)
		process.exitCode = 1
	})
	.finally(cleanupTmp)

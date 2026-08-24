/**
 * Lifecycle regression — exotic fetch shapes and grace splits, each run against
 * pggit TWICE: once with no encoding tier, once after repack. A difference
 * between the two is the tier's fault; identical behavior belongs to their shared
 * serving path.
 *
 * The tier differential alone would be pggit-vs-pggit — a probe that fails the
 * same way in both arms compares equal — so every probe ALSO runs against a
 * `file://` bare remote of the identical history, which decides what the right
 * answer was. Two of the four shapes (`--depth=1`, `fetch --unshallow`) sit
 * outside pggit's scope: it does not implement the v2 `shallow` feature, so the
 * contract there is a loud client-side failure against a control that succeeds.
 *
 * Full scale is four probes × two tier states over 120-commit repos, then the
 * grace-split sequence over a 140-commit repo.
 *
 * Each (probe, tier-state) run gets its own isolated schema, exactly as the
 * no-tier run must never see a repack the tier run performed.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGc } from "@/store/gc"
import { createRepack, type RepackResult } from "@/store/repack"
import { buildLifecycleSource, commitsOldestFirst } from "@/testing/append-only-repo"
import {
	listDifferences,
	mirrorClone,
	parseRevListObjectOids,
	requiredAt,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/exotic"

/**
 * `contract` says what the probe is held to against a `file://` bare remote of the
 * identical history:
 *   "oracle"      — pggit must produce exactly what canonical git produces.
 *   "unsupported" — pggit deliberately does not implement the v2 `shallow`
 *                   (deepen) feature, so the contract is a LOUD client-side
 *                   failure where the control succeeds
 *                   (`transport/shallow-unsupported.test.ts` owns that decision).
 */
type Probe = {
	name: string
	contract: "oracle" | "unsupported"
	run: (url: string, dest: string) => Promise<string>
}

const PROBES: Probe[] = [
	{
		contract: "oracle",
		name: "mirror clone",
		run: async (url, dest) => {
			const mirror = await mirrorClone(url, dest)
			return `${mirror.objects.length} objects`
		},
	},
	{
		contract: "oracle",
		name: "partial clone --filter=blob:none + checkout (lazy fetch)",
		run: async (url, dest) => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--filter=blob:none",
				url,
				dest,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			const n = (
				await spawnGit(["rev-list", "--count", "HEAD"], { cwd: dest })
			).stdout.trim()
			return `${n} commits, checkout ok`
		},
	},
	{
		contract: "unsupported",
		name: "shallow clone --depth=1",
		run: async (url, dest) => {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--depth=1", url, dest])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			return `${
				parseRevListObjectOids(
					(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dest })).stdout,
				).sort().length
			} objects`
		},
	},
	{
		contract: "unsupported",
		name: "clone then deepen (fetch --unshallow)",
		run: async (url, dest) => {
			await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--depth=5", url, dest])
			await spawnGit(["-c", "protocol.version=2", "fetch", "-q", "--unshallow"], {
				cwd: dest,
			})
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
			return `${
				parseRevListObjectOids(
					(await spawnGit(["rev-list", "--objects", "--all"], { cwd: dest })).stdout,
				).sort().length
			} objects`
		},
	},
]

type ProbeOutcome = {
	name: string
	contract: Probe["contract"]
	noTier: string
	withTier: string
	/** The same probe against a `file://` bare remote of the identical history. */
	control: string
}

/** Normalise a probe failure so the runs are comparable: only the REASON matters. */
function normalizeThrow(err: unknown): string {
	const raw = (err as Error).message.split("\n").pop() ?? ""
	return `THREW: ${raw
		.replace(/(?:http|file):\/\/\S+/g, "<url>")
		.replace(/\/\S*T\/\S+/g, "<tmp>")
		.slice(0, 200)}`
}

describe("regressions/lifecycle — exotic fetch shapes and grace splits", () => {
	let root = ""
	const outcomes: ProbeOutcome[] = []
	let graceConverge: RepackResult = { deltas: 0, wholes: 0 }
	let graceOnlyPg = 0
	let graceOnlyRef = 0
	let graceFsck = ""

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pggit-exotic-fetch-"))
		const dir = (name: string): string => join(root, name)
		const baseUrl = inject("pgBaseUrl")

		/** One (probe × tier-state) run on its own schema; returns the git-visible
		 * result, or the normalised failure reason. */
		const runProbe = async (
			probe: Probe,
			index: number,
			withTier: boolean,
		): Promise<string> => {
			const fixture = await setupGitServerFixture(baseUrl)
			const { db, server } = fixture
			try {
				const src = dir(`src-${index}-${withTier}`)
				await buildLifecycleSource(src, 120)
				const commits = await commitsOldestFirst(src, "main")
				const url = repoUrl(server, REPO)
				await spawnGit(
					[
						"push",
						"-q",
						url,
						`${requiredAt(commits, commits.length - 1, "main commit history")}:refs/heads/main`,
					],
					{ cwd: src },
				)
				if (withTier) await createRepack(db.sql).repack(REPO)
				const dest = dir(`d-${index}-${withTier}`)
				let result: string
				try {
					result = await probe.run(url, dest)
				} catch (err) {
					result = normalizeThrow(err)
				}
				rmSync(dest, { force: true, recursive: true })
				rmSync(src, { force: true, recursive: true })
				return result
			} finally {
				await teardownGitServerFixture(fixture)
			}
		}

		// THE ORACLE: one `file://` bare remote holding the identical history. The
		// tier differential alone is pggit-vs-pggit — a probe that fails the same way
		// in both arms compares equal — so every probe is also run against canonical
		// git, which decides what the right answer was.
		const ctlSrc = dir("ctl-src")
		await buildLifecycleSource(ctlSrc, 120)
		const ctlCommits = await commitsOldestFirst(ctlSrc, "main")
		const ctl = dir("ctl.git")
		await spawnGit(["init", "-q", "--bare", "-b", "main", ctl])
		// Without this the control silently ignores `--filter` and full-clones, which
		// would make the blobless probe a comparison against a non-filtering server.
		await spawnGit(["config", "uploadpack.allowFilter", "true"], { cwd: ctl })
		await spawnGit(
			[
				"push",
				"-q",
				ctl,
				`${requiredAt(ctlCommits, ctlCommits.length - 1, "control commit history")}:refs/heads/main`,
			],
			{ cwd: ctlSrc },
		)

		for (const [index, probe] of PROBES.entries()) {
			const ctlDest = dir(`ctl-d-${index}`)
			let control: string
			try {
				control = await probe.run(`file://${ctl}`, ctlDest)
			} catch (err) {
				control = normalizeThrow(err)
			}
			rmSync(ctlDest, { force: true, recursive: true })
			outcomes.push({
				contract: probe.contract,
				control,
				name: probe.name,
				noTier: await runProbe(probe, index, false),
				withTier: await runProbe(probe, index, true),
			})
		}

		// --- grace split: some garbage reclaimed, some retained, repack in between ---
		const fixture = await setupGitServerFixture(baseUrl)
		const { db, server } = fixture
		try {
			const src = dir("gsrc")
			await buildLifecycleSource(src, 140)
			const commits = await commitsOldestFirst(src, "main")
			const ref = dir("gref.git")
			await spawnGit(["init", "-q", "--bare", "-b", "main", ref])
			const url = repoUrl(server, REPO)
			const repack = createRepack(db.sql)
			const gc = createGc(db.sql)
			const refs = fixture.deps.refs

			await spawnGit(
				[
					"push",
					"-q",
					url,
					`${requiredAt(commits, 99, "main commit history")}:refs/heads/main`,
				],
				{
					cwd: src,
				},
			)
			await spawnGit(
				[
					"push",
					"-q",
					ref,
					`${requiredAt(commits, 99, "main commit history")}:refs/heads/main`,
				],
				{
					cwd: src,
				},
			)
			await repack.repack(REPO)
			await sleep(2500)
			await spawnGit(
				[
					"push",
					"-q",
					url,
					`${requiredAt(commits, 139, "main commit history")}:refs/heads/main`,
				],
				{
					cwd: src,
				},
			)
			await spawnGit(
				[
					"push",
					"-q",
					ref,
					`${requiredAt(commits, 139, "main commit history")}:refs/heads/main`,
				],
				{
					cwd: src,
				},
			)
			await repack.repack(REPO)
			// rewind far back: everything after commit 50 is now garbage, but only the
			// FIRST push's objects are older than the 2s grace.
			await refs.setRef(
				REPO,
				"refs/heads/main",
				requiredAt(commits, 50, "main commit history"),
			)
			await spawnGit(
				["update-ref", "refs/heads/main", requiredAt(commits, 50, "main commit history")],
				{ cwd: ref },
			)
			await gc.gc(REPO, { graceSeconds: 2 })
			await repack.repack(REPO)
			await gc.gc(REPO, { graceSeconds: 0 })
			await repack.repack(REPO)
			graceConverge = await repack.repack(REPO)
			await spawnGit(["gc", "-q", "--prune=now"], { cwd: ref })

			const a = dir("gpg")
			const b = dir("gref")
			const served = await mirrorClone(url, a)
			const oracle = await mirrorClone(`file://${ref}`, b)
			const d = listDifferences(served.objects, oracle.objects)
			graceOnlyPg = d.onlyLeft.length
			graceOnlyRef = d.onlyRight.length
			graceFsck = served.fsck
		} finally {
			await teardownGitServerFixture(fixture)
		}
	}, 900_000)

	afterAll(() => {
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("gives every exotic fetch shape the same outcome with and without the tier", () => {
		expect(
			outcomes
				.filter((o) => o.noTier !== o.withTier)
				.map((o) => `${o.name}: no-tier=${o.noTier} | w/ tier=${o.withTier}`),
		).toEqual([])
	})

	it("answers every implemented fetch shape exactly as the file:// oracle does", () => {
		const oracled = outcomes.filter((o) => o.contract === "oracle")
		expect(oracled.length).toBeGreaterThan(0)
		for (const o of oracled) {
			expect(o.control, `${o.name}: the file:// control itself failed`).not.toMatch(
				/^THREW:/,
			)
		}
		expect(
			oracled
				.filter((o) => o.noTier !== o.control)
				.map((o) => `${o.name}: pggit=${o.noTier} | file://=${o.control}`),
		).toEqual([])
	})

	it("fails loudly on the shapes it does not implement, which the oracle serves", () => {
		// pggit does not implement the v2 shallow (deepen) feature;
		// `transport/shallow-unsupported.test.ts` pins that deliberate scope choice
		// with a LOUD failure. Both halves matter here: a silent success would violate
		// the contract, and a control that
		// also failed would mean the probe proves nothing about pggit.
		const unsupported = outcomes.filter((o) => o.contract === "unsupported")
		expect(unsupported.length).toBeGreaterThan(0)
		for (const o of unsupported) {
			expect(o.noTier, `${o.name}: pggit did not refuse an unimplemented shape`).toMatch(
				/^THREW:/,
			)
			expect(o.control, `${o.name}: the file:// control must serve it`).not.toMatch(
				/^THREW:/,
			)
		}
	})

	it("converges the repack after a grace split", () => {
		expect(graceConverge).toEqual({ deltas: 0, wholes: 0 })
	})

	it("clones the post-grace-split state identically to the file:// oracle", () => {
		expect({ onlyPg: graceOnlyPg, onlyRef: graceOnlyRef }).toEqual({
			onlyPg: 0,
			onlyRef: 0,
		})
	})

	it("clones the post-grace-split state fsck --strict clean", () => {
		expect(graceFsck).toBe("")
	})
})

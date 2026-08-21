/**
 * WIRE — the ORDER pggit emits deltas in, and the client-side resolver that order
 * stresses.
 *
 * Before the wholes-first fix, `buildPack` emitted in closure-discovery order, so
 * newer deltas preceded the older anchors they referenced. The originating probe
 * measured that on the append-only shape this work targets: 100% of served
 * REF_DELTAs preceded their base, where canonical git's own packs were 0%. That
 * ordering is legal (REF_DELTA resolution is by OID, not offset) but pathological
 * for client-side resolution. This test pins the fixed emission order.
 *
 * So this file does two things:
 *   1. Measures the ratio and requires that NO majority of served deltas precede
 *      their bases, over a fixture built to produce a deltified pack (a
 *      zero-delta serve fails loudly rather than passing vacuously).
 *   2. Drives the OTHER client resolver: `git unpack-objects`, which git uses
 *      instead of `index-pack` for a fetch under `fetch.unpackLimit`. It resolves
 *      out-of-order REF_DELTAs from a deferred list rather than a second pass, and
 *      no other test reaches it. Both a full clone and a small incremental fetch
 *      are forced down that path.
 *
 * Originated as breakage probe `wire--delta-before-base-ordering.ts`, which
 * measured the delta-ahead-of-base ratio; fixed.
 */
import { statSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { GitServer } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import {
	allObjectOids,
	objectBytesDigest,
	PACK_DIR,
	packFiles,
	parseVerifyPackObjects,
} from "@/testing/git-fixtures"
import {
	repoUrl,
	setupGitServerFixture,
	teardownGitServerFixture,
} from "@/testing/git-server-fixture"
import type { IsolatedDb } from "@/testing/pg"
import { createScratchArena } from "@/testing/scratch-arena"
import { spawnGit } from "@/testing/spawn-git"
import {
	captureTestResult,
	type TestResult,
	testResultContext,
} from "@/testing/test-result"

const REPO = "workspace/probe/ordering"
const RUNS = 300
const RUNS_2 = 12

type Ordering = { deltas: number; ahead: number; bytes: number }

/** Deltas in a clone's packs, and how many sit at a LOWER offset than their base. */
async function ordering(dir: string): Promise<Ordering> {
	let deltas = 0
	let ahead = 0
	let bytes = 0
	for (const file of packFiles(dir)) {
		bytes += statSync(join(dir, PACK_DIR, file)).size
		const index = join(dir, PACK_DIR, file.replace(/\.pack$/, ".idx"))
		const out = await spawnGit(["verify-pack", "-v", index], { cwd: dir })
		const objects = parseVerifyPackObjects(out.stdout)
		const offsetOf = new Map(objects.map((object) => [object.oid, object.offset]))
		for (const object of objects) {
			if (object.kind === "whole") continue
			deltas++
			const baseOffset = offsetOf.get(object.baseOid)
			if (baseOffset === undefined) {
				throw new Error(
					`verify-pack delta ${object.oid} names absent base ${object.baseOid}`,
				)
			}
			if (object.offset < baseOffset) ahead++
		}
	}
	return { ahead, bytes, deltas }
}

/** `<object count>:<sha256 over every local object's raw bytes, in oid order>`. */
async function digest(dir: string): Promise<string> {
	const oids = await allObjectOids(dir)
	return `${oids.length}:${await objectBytesDigest(dir, oids)}`
}

describe("wire — delta emission order and the client resolvers it stresses", () => {
	let db: IsolatedDb
	let server: GitServer
	const { cleanup: cleanupScratch, make: mk, own: ownScratch } = createScratchArena()

	let pggitOrder: Ordering
	let gitOrder: Ordering
	let unpackClone: TestResult<string>
	let indexPackDigest = ""
	const fetches = new Map<string, TestResult<string>>()

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS })
		ownScratch(src)
		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })

		const fixture = await setupGitServerFixture()
		db = fixture.db
		server = fixture.server
		const url = repoUrl(server, REPO)

		await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: src })
		await createRepack(db.sql).repack(REPO)

		// --- 1. the ordering measurement, against git's own pack for reference ----
		const dP = join(mk("cP"), "c")
		await spawnGit(["-c", "protocol.version=2", "clone", "-q", "--no-local", url, dP])
		const dG = join(mk("cG"), "c")
		await spawnGit(["clone", "-q", "--no-local", `file://${bare}`, dG])
		pggitOrder = await ordering(dP)
		gitOrder = await ordering(dG)

		// --- 2. the OTHER client resolver: git unpack-objects ---------------------
		// `fetch.unpackLimit` above the object count forces unpack-objects instead of
		// index-pack; it resolves out-of-order REF_DELTAs from a deferred list.
		const dU = join(mk("cU"), "c")
		unpackClone = await captureTestResult(async () => {
			await spawnGit([
				"-c",
				"protocol.version=2",
				"-c",
				"fetch.unpackLimit=1000000",
				"-c",
				"transfer.unpackLimit=1000000",
				"-c",
				"transfer.fsckobjects=true",
				"-c",
				"fetch.fsckobjects=true",
				"clone",
				"-q",
				"--no-local",
				url,
				dU,
			])
			await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dU })
			return digest(dU)
		})
		indexPackDigest = await digest(dP)

		// A SMALL incremental fetch — the shape a per-navigation pull actually is, and
		// the one that goes through unpack-objects by DEFAULT (under 100 objects).
		const grown = await createAppendOnlyRepo({ docs: 6, runs: RUNS + RUNS_2 })
		ownScratch(grown)
		await spawnGit(["push", "-q", url, "refs/heads/*:refs/heads/*"], { cwd: grown })
		await spawnGit(["push", "-q", `file://${bare}`, "refs/heads/*:refs/heads/*"], {
			cwd: grown,
		})
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })
		await createRepack(db.sql).repack(REPO)

		for (const [label, dest] of [
			["default resolver", dP],
			["forced unpack-objects", dU],
		] as const) {
			// A clone that never landed has nothing to fetch onto; its own assertion
			// above already reports the break.
			if (dest === dU && unpackClone.kind === "failed") continue
			const cfg =
				label === "forced unpack-objects"
					? ["-c", "fetch.unpackLimit=1000000", "-c", "transfer.unpackLimit=1000000"]
					: []
			fetches.set(
				label,
				await captureTestResult(async () => {
					await spawnGit(
						[
							"-c",
							"protocol.version=2",
							...cfg,
							"-c",
							"transfer.fsckobjects=true",
							"fetch",
							"-q",
							"origin",
						],
						{ cwd: dest },
					)
					await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
					return digest(dest)
				}),
			)
		}
	}, 600_000)

	afterAll(async () => {
		await teardownGitServerFixture({ db, server })
		cleanupScratch()
	})

	it("does not emit a MAJORITY of deltas ahead of their base in the pack", () => {
		// The fixture is BUILT to produce a deltified pack (repacked lineage) — a
		// zero-delta serve means the fixture stopped exercising the pathology,
		// which must fail loudly, never pass vacuously.
		expect(pggitOrder.deltas).toBeGreaterThan(0)
		expect(
			pggitOrder.ahead,
			`pggit served ${pggitOrder.deltas} deltas in ${pggitOrder.bytes}B of pack; ` +
				`canonical git emits ${gitOrder.ahead}/${gitOrder.deltas} deltas ahead of their base. ` +
				`Nothing in the stream is resolvable until the pack ends.`,
		).toBeLessThanOrEqual(pggitOrder.deltas / 2)
	})

	it("clones through git unpack-objects, fsck-clean and identical to index-pack", () => {
		expect(unpackClone.kind, testResultContext(unpackClone, "unpack-objects clone")).toBe(
			"succeeded",
		)
		if (unpackClone.kind === "succeeded") expect(unpackClone.value).toBe(indexPackDigest)
	})

	it("takes a small incremental fetch through BOTH client resolvers", () => {
		for (const [label, result] of fetches) {
			expect(result.kind, testResultContext(result, label)).toBe("succeeded")
		}
		expect(fetches.size).toBe(2)
	})

	it("leaves both resolvers with the same object store after the fetch", () => {
		const indexed = fetches.get("default resolver")
		const unpacked = fetches.get("forced unpack-objects")
		expect(indexed?.kind).toBe("succeeded")
		expect(unpacked?.kind).toBe("succeeded")
		if (indexed?.kind === "succeeded" && unpacked?.kind === "succeeded") {
			expect(unpacked.value).toBe(indexed.value)
		}
	})
})

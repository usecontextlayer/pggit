/**
 * WIRE — the ORDER pggit emits deltas in, and the client-side resolver that order
 * stresses.
 *
 * `buildPack` emits in closure order, and the closure CTE seeds at the wants (the
 * ref tips) and expands outward — so newer objects come first and a star delta's
 * ANCHOR (an older version of the same path) always lands AFTER the delta that
 * references it. The originating probe measured that on the append-only shape
 * this work targets: 100% of served REF_DELTAs preceded their base in the pack,
 * where canonical git's own packs are 0%. Legal (REF_DELTA resolution is by OID,
 * not offset) but it is the worst case for both client-side resolvers, and it
 * means nothing in the stream can be resolved until the whole pack has arrived —
 * relevant to the streaming/TTFB question this work left open.
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
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { parseVerifyPackObjects } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/probe/ordering"
const RUNS = 300
const RUNS_2 = 12

type Ordering = { deltas: number; ahead: number; bytes: number }

/** Deltas in a clone's packs, and how many sit at a LOWER offset than their base. */
async function ordering(dir: string): Promise<Ordering> {
	const p = join(dir, ".git", "objects", "pack")
	let deltas = 0
	let ahead = 0
	let bytes = 0
	for (const f of readdirSync(p)) {
		if (f.endsWith(".pack")) bytes += statSync(join(p, f)).size
		if (!f.endsWith(".idx")) continue
		const out = await spawnGit(["verify-pack", "-v", join(p, f)], { cwd: dir })
		const objects = parseVerifyPackObjects(out.stdout)
		const offsetOf = new Map(objects.map((object) => [object.oid, object.offset]))
		for (const object of objects) {
			if (object.baseOid === undefined) continue
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
	const list = await spawnGit(["cat-file", "--batch-check", "--batch-all-objects"], {
		cwd: dir,
	})
	const oids = list.stdout
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split(" ")[0] as string)
		.sort()
	const res = await spawnGit(["cat-file", "--batch"], {
		cwd: dir,
		input: `${oids.join("\n")}\n`,
	})
	return `${oids.length}:${createHash("sha256").update(res.stdoutBytes).digest("hex")}`
}

async function errorOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run()
		return null
	} catch (err) {
		return String(err)
	}
}

describe("wire — delta emission order and the client resolvers it stresses", () => {
	let db: IsolatedDb
	let server: GitServer
	const scratch: string[] = []
	const mk = (tag: string): string => {
		const d = mkdtempSync(join(tmpdir(), `pggit-brk-${tag}-`))
		scratch.push(d)
		return d
	}

	let pggitOrder: Ordering
	let gitOrder: Ordering
	let unpackCloneError: string | null = null
	let indexPackDigest = ""
	let unpackDigest = ""
	const fetchErrors = new Map<string, string | null>()
	let finalIndexPackDigest = ""
	let finalUnpackDigest = ""

	beforeAll(async () => {
		const src = await createAppendOnlyRepo({ docs: 6, runs: RUNS })
		scratch.push(src)
		const bare = join(mk("bare"), "oracle.git")
		await spawnGit(["clone", "--bare", "-q", src, bare])
		await spawnGit(["repack", "-a", "-d", "-q"], { cwd: bare })

		db = await createIsolatedSchema(inject("pgBaseUrl"))
		server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
		const url = `http://127.0.0.1:${server.port}/${REPO}`

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
		unpackCloneError = await errorOf(async () => {
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
		})
		indexPackDigest = await digest(dP)
		unpackDigest = unpackCloneError === null ? await digest(dU) : ""

		// A SMALL incremental fetch — the shape a per-navigation pull actually is, and
		// the one that goes through unpack-objects by DEFAULT (under 100 objects).
		const grown = await createAppendOnlyRepo({ docs: 6, runs: RUNS + RUNS_2 })
		scratch.push(grown)
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
			if (dest === dU && unpackCloneError !== null) continue
			const cfg =
				label === "forced unpack-objects"
					? ["-c", "fetch.unpackLimit=1000000", "-c", "transfer.unpackLimit=1000000"]
					: []
			fetchErrors.set(
				label,
				await errorOf(async () => {
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
				}),
			)
		}
		finalIndexPackDigest = await digest(dP)
		finalUnpackDigest = unpackCloneError === null ? await digest(dU) : ""
	}, 600_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		for (const d of scratch) rmSync(d, { force: true, recursive: true })
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
		expect(unpackCloneError).toBeNull()
		expect(unpackDigest).toBe(indexPackDigest)
	})

	it("takes a small incremental fetch through BOTH client resolvers", () => {
		for (const [label, err] of fetchErrors) expect(err, label).toBeNull()
		expect(fetchErrors.size).toBe(2)
	})

	it("leaves both resolvers with the same object store after the fetch", () => {
		expect(finalUnpackDigest).toBe(finalIndexPackDigest)
	})
})

/**
 * pg-bloat/encoding-tier-vs-git-pack — does the derived tier cost what a packfile
 * costs?
 *
 * `git_pack_encoding` holds the bytes a served pack is made of, so the tier should weigh roughly
 * what git's own packfile weighs for the same objects. That is the claim this
 * harness checks, and it checks the tier's complete physical footprint rather
 * than the payload: a row in Postgres is not just its bytes — it carries a 24-byte tuple header, a line
 * pointer, an entry in the primary-key index, and (for values over ~2 kB under
 * `STORAGE EXTERNAL`) a TOAST chunk plus a TOAST index entry. Sixteen leaf
 * partitions each pay their own relation, index, TOAST relation and TOAST index
 * floor on top.
 *
 * The encoding tier is ADDITIVE: authoritative `git_object` content does not
 * shrink when encodings are built, so the storage
 * question is not `encoding vs pack` but `git_object + git_commit + encoding` vs
 * `one packfile`.
 *
 * WHAT IT PRINTS
 *   - `git gc --aggressive`'s packfile for the same objects, and the loose-object
 *     total before it.
 *   - the encoding tier: payload bytes (`sum(octet_length(data))`), heap, TOAST,
 *     index, and the per-row Postgres tax.
 *   - the pack pggit actually serves for a full clone, so "the tier is
 *     pack-sized" can be checked against the pack it produces, not against git's.
 *   - the three measured storage tiers (`git_object`, `git_commit`, and
 *     `git_pack_encoding`) against the packfile.
 *
 * EXIT NON-ZERO when the encoding tier's on-disk total exceeds `TIER_LIMIT`× the
 * pack it exists to emit.
 *
 *   npx tsx perf/probes/pg-bloat/encoding-tier-vs-git-pack.ts --runs=1200
 *   npx tsx perf/probes/pg-bloat/encoding-tier-vs-git-pack.ts --repo=/path/to/repo
 */

import { nonemptyStringArg, parseArgs, pgUrlArg, positiveIntegerArg } from "@perf/args"
import { requiredCollector, requiredPositiveCounter } from "@perf/collector-evidence"
import { mb, pad, padr, scratchRoot, sizeOf } from "@perf/probes/pg-bloat/_util"
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import {
	deterministicFiller,
	FAST_IMPORT_COMMITTER,
	uuidFromSeed,
} from "@/testing/append-only-repo"
import { directoryBytes } from "@/testing/directory-size"
import {
	allRefsOf,
	assertCanonicalStoreFixture,
	assertGitReachableObjects,
	canonicalStoreRefsOf,
	loadAllReachableObjects,
	packFileBytes,
	repackEligibleObjects,
	seedGitRefs,
} from "@/testing/git-fixtures"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const REPO_ID = "workspace/slate/tier"
/** the tier may weigh this much more than the pack it emits before it is a defect */
const TIER_LIMIT = 2.0
type Source = { kind: "generated" } | { kind: "repository"; path: string }

const {
	docs: DOCS,
	pg: PG_URL,
	source: SOURCE,
	runs: RUNS,
} = parseArgs(
	z
		.object({
			docs: positiveIntegerArg.default(120),
			pg: pgUrlArg,
			repo: nonemptyStringArg.optional(),
			runs: positiveIntegerArg.default(1200),
		})
		.strict()
		.transform(
			({
				docs,
				pg,
				repo,
				runs,
			}): {
				docs: number
				pg: string
				runs: number
				source: Source
			} => ({
				docs,
				pg,
				runs,
				source:
					repo === undefined ? { kind: "generated" } : { kind: "repository", path: repo },
			}),
		),
)

function buildStream(): string {
	const out: string[] = []
	let mark = 0
	const next = () => ++mark
	const blob = (c: string): number => {
		const m = next()
		out.push(`blob\nmark :${m}\ndata ${Buffer.byteLength(c)}\n${c}\n`)
		return m
	}
	const seeded: string[] = []
	for (let i = 0; i < DOCS; i++) {
		const m = blob(`# doc ${i}\n\n${deterministicFiller(`doc-${i}-v0`, 2000)}\n`)
		seeded.push(`M 100644 :${m} docs/planner-updates/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	for (let i = 0; i < RUNS; i++) {
		const dir = uuidFromSeed(`tier-run-${i}`)
		const record = blob(
			`{"run":"${dir}","status":"ok","p":"${deterministicFiller(`rec-${i}`, 1200)}"}\n`,
		)
		const stderr = blob(`${deterministicFiller(`err-${i}`, 400)}\n`)
		const changes = [
			`M 100644 :${record} .engine/runs/planner-updates/${dir}/record.json`,
			`M 100644 :${stderr} .engine/runs/planner-updates/${dir}/stderr`,
		]
		if (i % 13 === 0) {
			const d = i % DOCS
			const m = blob(`# doc ${d}\n\n${deterministicFiller(`doc-${d}-v${i}`, 2000)}\n`)
			changes.push(`M 100644 :${m} docs/planner-updates/doc-${d}.md`)
		}
		const cm = next()
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${FAST_IMPORT_COMMITTER}\ndata 3\nrun\nfrom :${prev}\n${changes.join("\n")}\n`,
		)
		prev = cm
	}
	return out.join("")
}

async function main(): Promise<void> {
	const scratch = scratchRoot("tier")
	const db = await createIsolatedSchema(PG_URL)
	try {
		console.log(`# The derived encoding tier's storage bill, against git's packfile\n`)

		// ── the source repo ─────────────────────────────────────────────────
		const src = scratch.dir("src")
		if (SOURCE.kind === "repository") {
			// Mirror-clone first so the probe cannot mutate the selected source checkout.
			await spawnGit(["clone", "-q", "--mirror", SOURCE.path, src])
			console.log(`source: mirror clone of ${SOURCE.path}`)
		} else {
			await spawnGit(["init", "-q", "-b", "main", src])
			await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
			console.log(
				`source: generated append-only shape — ${RUNS} run-dir commits over ${DOCS} docs`,
			)
		}

		const objects = await loadAllReachableObjects(src)
		const eligibleObjects = repackEligibleObjects(objects)
		if (eligibleObjects.length !== objects.length) {
			throw new Error(
				`encoding-tier fixture has ${objects.length - eligibleObjects.length} objects above the stored-tier size ceiling`,
			)
		}
		const rawBytes = objects.reduce((n, o) => n + o.content.length, 0)
		const byType = new Map<string, { n: number; bytes: number }>()
		for (const o of objects) {
			const cur = byType.get(o.type) ?? { bytes: 0, n: 0 }
			cur.n++
			cur.bytes += o.content.length
			byType.set(o.type, cur)
		}
		console.log(
			`\n${objects.length} reachable objects, ${mb(rawBytes)} MB inflated: ` +
				[...byType]
					.map(([t, v]) => `${v.n} ${t}s (${mb(v.bytes)} MB)`)
					.sort()
					.join(", "),
		)

		// ── git's own packing of exactly these objects ──────────────────────
		const gcDir = scratch.dir("gc")
		await spawnGit(["clone", "-q", "--mirror", src, gcDir])
		const looseBytes = await directoryBytes(gcDir)
		await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: gcDir })
		const gcBytes = await directoryBytes(gcDir)
		const sizePack = await packFileBytes(gcDir)
		if (sizePack <= 0) throw new Error(`canonical git pack size is ${sizePack}`)
		console.log(
			`git: ${mb(looseBytes)} MB as received → ${mb(gcBytes)} MB after \`gc --aggressive\` ` +
				`(packfile itself ${mb(sizePack)} MB)`,
		)

		// ── the same objects in pggit ───────────────────────────────────────
		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		await store.putPack(REPO_ID, objects)
		await seedGitRefs(REPO_ID, src, refs)
		const canonicalRefs = await allRefsOf(src)

		const beforeRepack = await sizeOf(db.sql, "git_pack_encoding")
		const t0 = Date.now()
		const res = await createRepack(db.sql).repack(REPO_ID)
		if (
			objects.length === 0 ||
			res.wholes + res.deltas !== eligibleObjects.length ||
			res.deltas <= 0
		) {
			throw new Error(
				`repack covered ${res.wholes + res.deltas}/${eligibleObjects.length} eligible canonical objects with ${res.deltas} deltas`,
			)
		}
		await assertCanonicalStoreFixture(db.sql, REPO_ID, {
			encodings: { kind: "exact", objects: eligibleObjects },
			objects,
			refs: await canonicalStoreRefsOf(src),
		})
		const repackMs = Date.now() - t0
		console.log(
			`\nrepack: ${res.wholes} wholes + ${res.deltas} deltas in ${(repackMs / 1000).toFixed(1)}s ` +
				`(tier grew ${mb(beforeRepack.total)} → …)`,
		)

		// ── the pack pggit actually serves ──────────────────────────────────
		const app = createGitApp(createGitDeps(db.sql), { instrument: true })
		const server = await serveOnPort(app, 0)
		const dest = scratch.dir("clone")
		try {
			resetCollected()
			await spawnGit([
				"-c",
				"protocol.version=2",
				"clone",
				"-q",
				"--mirror",
				`http://127.0.0.1:${server.port}/${REPO_ID}`,
				dest,
			])
		} finally {
			await server.close()
		}
		const storedPack = await packFileBytes(dest)
		const run = requiredCollector(collectedRuns(), "fetch", "encoding-tier clone")
		const servedPack = requiredPositiveCounter(run, "packBytes", "encoding-tier clone")
		const objectsServed = requiredPositiveCounter(
			run,
			"objectsServed",
			"encoding-tier clone",
		)
		requiredPositiveCounter(run, "deltasServed", "encoding-tier clone")
		if (objectsServed !== objects.length) {
			throw new Error(
				`serve prerequisite failed: objects=${objectsServed}/${objects.length}`,
			)
		}
		const clonedRefs = await allRefsOf(dest)
		const expectedOids = objects.map((object) => object.oid).sort()
		await assertGitReachableObjects(dest, expectedOids, "encoding-tier clone")
		if (JSON.stringify(clonedRefs) !== JSON.stringify(canonicalRefs)) {
			throw new Error("pggit mirror clone diverged from canonical refs")
		}
		console.log(
			`served: raw wire pack ${mb(servedPack)} MB; client stored ${mb(storedPack)} MB after index-pack, fsck clean`,
		)

		// ── the bill ────────────────────────────────────────────────────────
		const enc = await sizeOf(db.sql, "git_pack_encoding")
		const obj = await sizeOf(db.sql, "git_object")
		const commit = await sizeOf(db.sql, "git_commit")
		const [payload] = await db.sql<
			{
				n: string
				oct: string
				col: string
				big: string
				maxo: string
				deltas: string
			}[]
		>`
			select count(*)::text as n, sum(octet_length(data))::text as oct,
				sum(pg_column_size(data))::text as col,
				count(*) filter (where octet_length(data) > 2000)::text as big,
				max(octet_length(data))::text as maxo,
				count(*) filter (where base_oid is not null)::text as deltas
			from git_pack_encoding`
		if (!payload) throw new Error("encoding payload census returned no row")
		const payloadBytes = Number(payload.oct)
		const rows = Number(payload.n)
		const storedDeltas = Number(payload.deltas)
		if (
			rows !== eligibleObjects.length ||
			storedDeltas !== res.deltas ||
			storedDeltas <= 0 ||
			payloadBytes <= 0 ||
			enc.total <= 0 ||
			obj.total <= 0 ||
			commit.total <= 0
		) {
			throw new Error(
				`encoding census has ${rows}/${eligibleObjects.length} eligible rows, ${storedDeltas}/${res.deltas} deltas, and ${payloadBytes} payload bytes`,
			)
		}

		console.log(`\n## the encoding tier, itemised\n`)
		console.log(
			`${padr("component", 34)} ${pad("MB", 9)} ${pad("bytes/row", 11)}  share of tier`,
		)
		const line = (name: string, v: number) =>
			console.log(
				`${padr(name, 34)} ${pad(mb(v), 9)} ${pad((v / rows).toFixed(1), 11)}  ${((v / enc.total) * 100).toFixed(1)}%`,
			)
		line("deflated payload (octet_length)", payloadBytes)
		line("heap (payload inline + tuple hdr)", enc.heap)
		line("TOAST (values over ~2 kB)", enc.toast)
		line("primary-key index (repo_id, oid)", enc.indexes)
		console.log(
			`${padr("TOTAL", 34)} ${pad(mb(enc.total), 9)} ${pad((enc.total / rows).toFixed(1), 11)}  100%`,
		)
		console.log(
			`\n${rows} rows · ${payload.big} of them (${((Number(payload.big) / rows) * 100).toFixed(1)}%) exceed ~2 kB and ` +
				`go out-of-line under STORAGE EXTERNAL (max ${payload.maxo} B) — each is one extra\n` +
				`TOAST index probe + chunk read on the serve path that an inline value would not pay.`,
		)
		console.log(
			`\nPostgres tax on the payload: ${mb(enc.total - payloadBytes)} MB over ${mb(payloadBytes)} MB of ` +
				`actual pack bytes = ${((enc.total / payloadBytes - 1) * 100).toFixed(0)}% overhead ` +
				`(${((enc.total - payloadBytes) / rows).toFixed(0)} bytes per object).`,
		)

		console.log(`\n## the three measured storage tiers\n`)
		console.log(`${padr("store", 34)} ${pad("MB", 9)} ${pad("× git pack", 11)}`)
		const row = (name: string, v: number) =>
			console.log(
				`${padr(name, 34)} ${pad(mb(v), 9)} ${pad((v / sizePack).toFixed(2), 11)}`,
			)
		row("git packfile (gc --aggressive)", sizePack)
		row("pack pggit serves", servedPack)
		row("git_pack_encoding (the tier)", enc.total)
		row("git_object (canonical, unshrunk)", obj.total)
		row("git_commit (the topology rows)", commit.total)
		row("all three", enc.total + obj.total + commit.total)

		const ratio = enc.total / servedPack
		console.log(
			`\nthe tier weighs ${ratio.toFixed(2)}× the pack it exists to emit (expected: ~1×).`,
		)
		console.log(
			`git_object does not shrink when the derived tier is built; the measured consequence is\n` +
				`that a repo whose packfile is ${mb(sizePack)} MB occupies ` +
				`${mb(enc.total + obj.total + commit.total)} MB of Postgres — ` +
				`${((enc.total + obj.total + commit.total) / sizePack).toFixed(1)}× — of which the\n` +
				`encoding tier is the smallest term.`,
		)
		if (ratio > TIER_LIMIT) process.exitCode = 1
	} finally {
		await db.drop()
		scratch.cleanup()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 1
})

/**
 * WIRE-LEVEL DIFFERENTIAL on REAL repositories, against real git as the oracle.
 *
 * Scored verdicts are black-box: the pggit surface exercised is the HTTP wire
 * (`serveOnPort(createGitApp(createGitDeps(sql)), 0)` + real `git push` /
 * `git clone` / `git fetch`), plus the two offline verbs `createRepack().repack()`
 * and `createGc().gc()`. Every verdict is a git-observable outcome — object bytes,
 * ref listings, `git fsck --strict`, transfer sizes. Exact database censuses prove
 * the named unencoded/repacked fixture states before those outcomes are scored.
 *
 * The oracle is a plain `file://` bare remote replaying the same sequence.
 *
 * A perf harness rather than a vitest e2e test because its corpus is a REAL local repository selected at run time (`--repo=` or `--mirror=`), which no committed fixture can stand in for — the same reason `perf/probes/delta-corpus.ts` lives here. The serve-size phase additionally scores a MEASURED ratio (`> 4.0x` is a finding), so the file carries both kinds of verdict into the one exit code, as the source script did.
 *
 *   npx tsx perf/probes/realrepo/differential.ts --repo=/path/to/checkout --slug=<name> \
 *     [--phases=full,shapes,size,replay] [--step=50]
 *
 * Exit 0 = every phase matched git. Non-zero = a divergence, named on stdout.
 */
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { nonemptyStringArg, parseArgs, pgUrlArg, positiveIntegerArg } from "@perf/args"
import { requiredCollector, requiredPositiveCounter } from "@perf/collector-evidence"
import { table } from "@perf/probes/_table"
import {
	assertCanonicalRealRepoStore,
	canonicalV2Pack,
	createScratch,
	mb,
	mirrorSourceFromArgs,
	postPggitV2Pack,
	prepareMirror,
	secs,
} from "@perf/probes/realrepo/_util"
import { z } from "zod"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import type { Oid } from "@/object/oid"
import { readPack } from "@/pack/read-pack"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import {
	type GitObjectInventory,
	gitObjectInventory,
	loadGitObjects,
	parseRevListObjectOids,
	requiredAt,
	revParse,
	typedRefsOf,
} from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, type GitAttempt, spawnGit } from "@/testing/spawn-git"
import { fetchRequest } from "@/testing/wire-fetch"

// ── args ────────────────────────────────────────────────────────────────────
const PHASE_NAMES = ["full", "orphan", "replay", "shapes", "size"] as const
type PhaseName = (typeof PHASE_NAMES)[number]
const phaseListArg = nonemptyStringArg
	.default("full,shapes,size,replay")
	.transform((value) => value.split(","))
	.pipe(z.array(z.enum(PHASE_NAMES)).min(1))
	.superRefine((values, context) => {
		if (new Set(values).size !== values.length) {
			context.addIssue({ code: "custom", message: "phase names must be unique" })
		}
	})

const args = parseArgs(
	z
		.object({
			mirror: nonemptyStringArg.optional(),
			pg: pgUrlArg,
			phases: phaseListArg,
			repo: nonemptyStringArg.optional(),
			slug: nonemptyStringArg.default("repo"),
			step: positiveIntegerArg.default(50),
		})
		.strict()
		.transform(({ mirror, repo, ...values }) => ({
			...values,
			source: mirrorSourceFromArgs({ mirror, repo }),
		})),
)
const SLUG = args.slug
const PHASES = new Set<PhaseName>(args.phases)
const STEP = args.step
const PG_URL = args.pg

const scratch = createScratch(`realrepo-${SLUG}`)
const UPLOAD_PACK_CONFIG = [
	["uploadpack.allowFilter", "true"],
	["uploadpack.allowAnySHA1InWant", "true"],
	["uploadpack.allowReachableSHA1InWant", "true"],
] as const
/** The private mirror clone of the selected source; set by `prepareMirror` in `main`. */
let MIRROR = ""

// ── findings ledger ─────────────────────────────────────────────────────────
type Finding = { phase: string; what: string; detail: string }
const findings: Finding[] = []
const fail = (phase: string, what: string, detail: string): void => {
	findings.push({ detail, phase, what })
	console.log(`\n!! FINDING [${SLUG}/${phase}] ${what}\n   ${detail}\n`)
}
const summary: (string | number)[][] = []

function requireSinglePackRun(label: string): {
	collector: ReturnType<typeof requiredCollector>
	objectsServed: number
	packBytes: number
	wireBytes: number
} {
	const collector = requiredCollector(collectedRuns(), "fetch", label)
	return {
		collector,
		objectsServed: requiredPositiveCounter(collector, "objectsServed", label),
		packBytes: requiredPositiveCounter(collector, "packBytes", label),
		wireBytes: requiredPositiveCounter(collector, "wireBytes", label),
	}
}

// ── git helpers ─────────────────────────────────────────────────────────────
/** SHA-256 over `<type> <size>\0<content>` for each oid — the object's real bytes
 * as git hands them back, independent of how they were stored or transferred. */
async function digests(dir: string, inv: GitObjectInventory): Promise<Map<Oid, string>> {
	const out = new Map<Oid, string>()
	let batch: string[] = []
	let bytes = 0
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return
		for (const object of await loadGitObjects(dir, batch)) {
			out.set(
				object.oid,
				createHash("sha256")
					.update(`${object.type} ${object.content.length}\0`)
					.update(object.content)
					.digest("hex"),
			)
		}
		batch = []
		bytes = 0
	}
	for (const [oid, meta] of inv) {
		batch.push(oid)
		bytes += meta.size
		if (bytes >= 32_000_000) await flush()
	}
	await flush()
	return out
}

async function refMap(dir: string): Promise<Map<string, string>> {
	return new Map(
		(await typedRefsOf(dir)).map(({ name, oid, type }) => [name, `${oid} ${type}`]),
	)
}

/** Compare two repos object-for-object and ref-for-ref. Returns true when equal. */
async function compareRepos(
	phase: string,
	label: string,
	actualDir: string,
	expectDir: string,
	opts: { refs?: boolean } = {},
): Promise<{ equal: boolean; objects: number }> {
	const [ai, ei] = [
		await gitObjectInventory(actualDir),
		await gitObjectInventory(expectDir),
	]
	const missing = [...ei.keys()].filter((o) => !ai.has(o))
	const extra = [...ai.keys()].filter((o) => !ei.has(o))
	let equal = true
	if (missing.length > 0) {
		equal = false
		fail(
			phase,
			`${label}: ${missing.length} object(s) MISSING from the pggit side`,
			`first: ${missing
				.slice(0, 5)
				.map((o) => `${o} (${ei.get(o)?.type})`)
				.join(", ")}`,
		)
	}
	if (extra.length > 0) {
		equal = false
		fail(
			phase,
			`${label}: ${extra.length} EXTRA object(s) on the pggit side`,
			`first: ${extra
				.slice(0, 5)
				.map((o) => `${o} (${ai.get(o)?.type})`)
				.join(", ")}`,
		)
	}
	const [ad, ed] = [await digests(actualDir, ai), await digests(expectDir, ei)]
	const diverged: Oid[] = []
	for (const [oid, d] of ed) {
		const got = ad.get(oid)
		if (got !== undefined && got !== d) diverged.push(oid)
	}
	if (diverged.length > 0) {
		equal = false
		fail(
			phase,
			`${label}: ${diverged.length} object(s) with DIFFERENT BYTES under the same oid`,
			`first: ${diverged.slice(0, 5).join(", ")}`,
		)
	}
	if (opts.refs !== false) {
		const [ar, er] = [await refMap(actualDir), await refMap(expectDir)]
		const refDiff: string[] = []
		for (const [name, v] of er)
			if (ar.get(name) !== v)
				refDiff.push(`${name}: want ${v} got ${ar.get(name) ?? "<absent>"}`)
		for (const [name, v] of ar) if (!er.has(name)) refDiff.push(`${name}: EXTRA ${v}`)
		if (refDiff.length > 0) {
			equal = false
			fail(
				phase,
				`${label}: ${refDiff.length} ref divergence(s)`,
				refDiff.slice(0, 6).join(" | "),
			)
		}
	}
	const fsck = await attemptGit(["fsck", "--strict"], actualDir)
	if (!fsck.ok) {
		equal = false
		fail(
			phase,
			`${label}: git fsck --strict FAILED (exit ${fsck.code})`,
			fsck.stderr.trim().slice(0, 900),
		)
	}
	return { equal, objects: ei.size }
}

/** The source mirror's inventory, read once (module-scope so every phase sees it). */
let srcInv: GitObjectInventory = new Map()

/**
 * The ORACLE remote: a plain `file://` bare repo that received the SAME push plan
 * the pggit server did. It must be built by replaying the plan, not by cloning the
 * mirror — push policy can exclude refs a mirror clone holds, so a cloned
 * "reference" would charge pggit for git's own policy. Set by `buildOracleRemote`.
 */
let ORACLE = ""

type PushPlan = {
	commands: readonly [readonly string[], ...(readonly string[][])]
	label: "--all then --tags" | "--mirror"
}

async function runPushPlan(remote: string, plan: PushPlan): Promise<GitAttempt> {
	let outcome: GitAttempt | undefined
	for (const args of plan.commands) {
		outcome = await attemptGit(["push", remote, ...args], MIRROR)
		if (!outcome.ok) return outcome
	}
	if (outcome === undefined) throw new Error(`${plan.label}: push plan has no commands`)
	return outcome
}

async function buildOracleRemote(plan: PushPlan): Promise<GitAttempt> {
	ORACLE = join(scratch.mk("oracleremote"), "oracle.git")
	mkdirSync(ORACLE, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main", "--bare", ORACLE])
	const push = await runPushPlan(`file://${ORACLE}`, plan)
	if (!push.ok) return push
	for (const [key, value] of UPLOAD_PACK_CONFIG) {
		await spawnGit(["config", key, value], { cwd: ORACLE })
	}
	return push
}

async function main(): Promise<void> {
	MIRROR = await prepareMirror(scratch, args.source)
	console.log(`# realrepo differential — ${SLUG}  (mirror ${MIRROR})`)
	// The file:// ORACLE must be allowed to answer the same shapes pggit does —
	// otherwise git refuses the filter / exact-OID want and the "reference" is a
	// different request, not a reference. Config only; objects and refs untouched.
	for (const [key, value] of UPLOAD_PACK_CONFIG) {
		await spawnGit(["config", key, value], { cwd: MIRROR })
	}
	srcInv = await gitObjectInventory(MIRROR)
	const commits = Number(
		(await spawnGit(["rev-list", "--count", "--all"], { cwd: MIRROR })).stdout.trim(),
	)
	const srcRefs = await refMap(MIRROR)
	if (!Number.isSafeInteger(commits) || commits <= 0 || srcRefs.size === 0) {
		throw new Error(
			`source prerequisite failed: ${srcInv.size} objects, ${String(commits)} commits, ${srcRefs.size} refs`,
		)
	}
	console.log(
		`  source: ${srcInv.size} objects, ${commits} commits, ${srcRefs.size} refs, ` +
			`${mb([...srcInv.values()].reduce((a, b) => a + b.size, 0))} raw`,
	)

	const db = await createIsolatedSchema(PG_URL)
	try {
		if (PHASES.has("full") || PHASES.has("shapes") || PHASES.has("size")) {
			await phaseFullAndShapes(db)
		}
		if (PHASES.has("orphan")) await phaseOrphan(db)
		if (PHASES.has("replay")) await phaseReplay(db)
	} finally {
		await db.drop()
		scratch.cleanup()
	}

	console.log(`\n## ${SLUG} — differential summary\n`)
	console.log(table(["phase", "measure", "value"], summary))
	console.log(
		`\n${findings.length === 0 ? "VERDICT: clean — every phase matched git." : `VERDICT: ${findings.length} FINDING(S)`}`,
	)
	for (const f of findings) console.log(`  - [${f.phase}] ${f.what}: ${f.detail}`)
	if (findings.length > 0) process.exitCode = 1
}

// ── PHASE 1/3/4: full round-trip, fetch shapes, serve size ──────────────────
async function phaseFullAndShapes(db: IsolatedDb): Promise<void> {
	const repoId = `realrepo/${SLUG}`
	const app = createGitApp(createGitDeps(db.sql), { instrument: true })
	const server = await serveOnPort(app, 0)
	const url = `http://127.0.0.1:${server.port}/${repoId}`
	try {
		// --- push the whole mirror over the real wire ---------------------------
		console.log(`\n## full round-trip`)
		let pushPlan: PushPlan = { commands: [["--mirror"]], label: "--mirror" }
		let oraclePush = await buildOracleRemote(pushPlan)
		if (!oraclePush.ok) {
			console.log(
				`  canonical push --mirror rejected (exit ${oraclePush.code}): ${oraclePush.stderr.trim().split("\n").slice(0, 3).join(" / ")}`,
			)
			pushPlan = { commands: [["--all"], ["--tags"]], label: "--all then --tags" }
			oraclePush = await buildOracleRemote(pushPlan)
			if (!oraclePush.ok) {
				throw new Error(
					`canonical git rejected both full-push fixtures: ${oraclePush.stderr.trim().slice(0, 900)}`,
				)
			}
		}
		const t0 = Date.now()
		const push = await runPushPlan(url, pushPlan)
		if (!push.ok) {
			fail(
				"full",
				`pggit rejected canonical ${pushPlan.label} push plan (exit ${push.code})`,
				push.stderr.trim().slice(0, 900),
			)
			return
		}
		const pushMs = Date.now() - t0
		summary.push(["full", `push (${pushPlan.label})`, secs(pushMs)])
		// The oracle chose and accepted this exact push before pggit was touched, so
		// a pggit rejection cannot silently downgrade the fixture to a smaller shape.
		await assertCanonicalRealRepoStore(db.sql, repoId, ORACLE, { kind: "unencoded" })

		// --- clone BEFORE repack (the un-encoded baseline) ----------------------
		resetCollected()
		const preDir = join(scratch.mk("pre"), "c.git")
		const pre = await attemptGit([
			"-c",
			"protocol.version=2",
			"clone",
			"--mirror",
			"-q",
			url,
			preDir,
		])
		if (!pre.ok) {
			fail("full", "pre-repack mirror clone FAILED", pre.stderr.trim().slice(0, 900))
			return
		}
		const preRun = requireSinglePackRun("pre-repack clone")
		const prePack = preRun.packBytes

		// --- repack ------------------------------------------------------------
		const rt = Date.now()
		const rp = await createRepack(db.sql).repack(repoId)
		const repackMs = Date.now() - rt
		console.log(
			`  repack: ${rp.wholes} wholes + ${rp.deltas} deltas in ${secs(repackMs)}`,
		)
		summary.push([
			"full",
			"repack",
			`${rp.wholes} wholes + ${rp.deltas} deltas in ${secs(repackMs)}`,
		])
		await assertCanonicalRealRepoStore(db.sql, repoId, ORACLE, { kind: "repacked" })

		// a second pass MUST be a no-op (design D4: frozen policy)
		const rp2 = await createRepack(db.sql).repack(repoId)
		if (rp2.wholes !== 0 || rp2.deltas !== 0) {
			fail(
				"full",
				"repack is NOT idempotent — a second pass over an unchanged repo wrote rows",
				`second pass: ${rp2.wholes} wholes + ${rp2.deltas} deltas`,
			)
		}

		// --- the oracle: a plain file:// bare remote ----------------------------
		const refDir = join(scratch.mk("ref"), "ref.git")
		await spawnGit(["clone", "--mirror", "-q", `file://${ORACLE}`, refDir])
		const oracleInventory = await gitObjectInventory(refDir)
		const expectedEncodings = [...oracleInventory.values()].filter(
			(object) => object.size < MAX_INLINE_BYTEA_BYTES,
		).length
		if (rp.wholes + rp.deltas !== expectedEncodings) {
			throw new Error(
				`repack covered ${rp.wholes + rp.deltas}/${expectedEncodings} eligible canonical objects`,
			)
		}

		// --- clone AFTER repack, byte-compare against the oracle ----------------
		resetCollected()
		const postDir = join(scratch.mk("post"), "c.git")
		const ct = Date.now()
		const post = await attemptGit([
			"-c",
			"protocol.version=2",
			"clone",
			"--mirror",
			"-q",
			url,
			postDir,
		])
		const cloneMs = Date.now() - ct
		if (!post.ok) {
			fail("full", "post-repack mirror clone FAILED", post.stderr.trim().slice(0, 900))
			return
		}
		const run = requireSinglePackRun("post-repack clone")
		const postPack = run.packBytes

		const cmp = await compareRepos(
			"full",
			"post-repack mirror clone vs file:// oracle",
			postDir,
			refDir,
		)
		summary.push([
			"full",
			"objects compared",
			`${cmp.objects} (${cmp.equal ? "IDENTICAL" : "DIVERGED"})`,
		])
		summary.push(["full", "refs compared", (await refMap(refDir)).size])

		// the pre-repack clone must be identical too (encoding is derived, D1)
		const cmpPre = await compareRepos(
			"full",
			"pre-repack mirror clone vs file:// oracle",
			preDir,
			refDir,
		)
		for (const [label, evidence, objects] of [
			["pre-repack", preRun, cmpPre.objects],
			["post-repack", run, cmp.objects],
		] as const) {
			if (evidence.objectsServed !== objects) {
				throw new Error(
					`${label} collector served ${evidence.objectsServed}/${objects} canonical objects`,
				)
			}
		}
		summary.push(["full", "pre-repack clone", cmpPre.equal ? "IDENTICAL" : "DIVERGED"])

		// --- PHASE 4: serve-size sanity ----------------------------------------
		if (PHASES.has("size")) {
			if (!cmp.equal || !cmpPre.equal) {
				throw new Error(
					"size phase is not scoreable because a prerequisite clone diverged",
				)
			}
			requiredPositiveCounter(run.collector, "deltasServed", "post-repack clone")
			if (rp.deltas === 0) {
				throw new Error(
					`size fixture did not establish stored deltas (repack=${rp.deltas})`,
				)
			}
			const gcDir = join(scratch.mk("gc"), "gc.git")
			await spawnGit(["clone", "--mirror", "-q", `file://${ORACLE}`, gcDir])
			await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: gcDir })
			const wants = [
				...new Set(
					[...(await refMap(gcDir)).values()].map((value) => value.slice(0, 40)),
				),
			]
			if (wants.length === 0) throw new Error("size oracle has zero wanted ref oids")
			const request = fetchRequest({
				done: true,
				includeTag: true,
				thinPack: true,
				wants,
			})
			resetCollected()
			const [pggitRaw, gitRaw] = await Promise.all([
				postPggitV2Pack(url, request),
				canonicalV2Pack(gcDir, request),
			])
			const rawRun = requireSinglePackRun("raw size request")
			const rawServedDeltas = requiredPositiveCounter(
				rawRun.collector,
				"deltasServed",
				"raw size request",
			)
			const [pggitObjects, gitObjects] = await Promise.all([
				readPack(pggitRaw),
				readPack(gitRaw),
			])
			const pggitOids = pggitObjects.map((object) => object.oid).sort()
			const gitOids = gitObjects.map((object) => object.oid).sort()
			if (JSON.stringify(pggitOids) !== JSON.stringify(gitOids)) {
				throw new Error(
					`raw size request differs from canonical git (${pggitOids.length}/${gitOids.length} objects)`,
				)
			}
			const gitPack = gitRaw.length
			const pggitPack = pggitRaw.length
			const ratio = pggitPack / gitPack
			console.log(
				`  serve size: pggit ${mb(pggitPack)} raw (${rawServedDeltas} deltas; client clone counter ${mb(postPack)}) ` +
					`vs git ${mb(gitPack)} = ${ratio.toFixed(2)}x`,
			)
			summary.push(["size", "pre-repack pack", mb(prePack)])
			summary.push([
				"size",
				"post-repack raw pack",
				`${mb(pggitPack)} (${rawServedDeltas} deltas, ${secs(cloneMs)} client clone)`,
			])
			summary.push(["size", "git gc --aggressive raw pack", mb(gitPack)])
			summary.push([
				"size",
				"**pggit / git ratio**",
				`**${ratio.toFixed(2)}x** (pre-repack was ${(prePack / gitPack).toFixed(2)}x)`,
			])
			if (ratio > 4.0) {
				fail(
					"size",
					`served pack is ${ratio.toFixed(2)}x git's — far worse than the ~2.4x parity the design measured`,
					`pggit ${mb(pggitPack)} vs git ${mb(gitPack)}`,
				)
			}
		}

		// --- PHASE 3: fetch-shape sweep on the repacked state -------------------
		if (PHASES.has("shapes")) {
			console.log(`\n## fetch-shape sweep (repacked state)`)
			const mirrorRefs = await refMap(MIRROR)
			const headRef = [...mirrorRefs.keys()].find((r) => r === "refs/heads/main")
			const branch = headRef
				? "main"
				: ([...mirrorRefs.keys()].find((r) => r.startsWith("refs/heads/")) ?? "").replace(
						"refs/heads/",
						"",
					)
			if (!branch) throw new Error("fetch-shape fixture has no branch ref")

			// (a) single-branch clone
			const sbDir = join(scratch.mk("sb"), "sb.git")
			const sb = await attemptGit([
				"-c",
				"protocol.version=2",
				"clone",
				"--bare",
				"--single-branch",
				"--branch",
				branch,
				"-q",
				url,
				sbDir,
			])
			if (!sb.ok)
				fail("shapes", "single-branch clone FAILED", sb.stderr.trim().slice(0, 700))
			else {
				const sbRefDir = join(scratch.mk("sbref"), "sb.git")
				await spawnGit([
					"clone",
					"--bare",
					"--single-branch",
					"--branch",
					branch,
					"-q",
					`file://${ORACLE}`,
					sbRefDir,
				])
				const c = await compareRepos(
					"shapes",
					`single-branch(${branch})`,
					sbDir,
					sbRefDir,
				)
				summary.push([
					"shapes",
					"single-branch clone",
					`${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"}`,
				])
			}

			// (b) tag-only fetch
			const tags = [...mirrorRefs.keys()].filter((r) => r.startsWith("refs/tags/"))
			if (tags.length === 0) throw new Error("fetch-shape fixture has no tag ref")
			{
				const tagDir = join(scratch.mk("tag"), "t.git")
				mkdirSync(tagDir, { recursive: true })
				await spawnGit(["init", "-q", "--bare", tagDir])
				const picked = tags.slice(0, Math.min(4, tags.length))
				const tf = await attemptGit(
					[
						"-c",
						"protocol.version=2",
						"fetch",
						"-q",
						url,
						...picked.map((t) => `+${t}:${t}`),
					],
					tagDir,
				)
				if (!tf.ok)
					fail("shapes", "tag-only fetch FAILED", tf.stderr.trim().slice(0, 700))
				else {
					const tagRefDir = join(scratch.mk("tagref"), "t.git")
					mkdirSync(tagRefDir, { recursive: true })
					await spawnGit(["init", "-q", "--bare", tagRefDir])
					await spawnGit(
						["fetch", "-q", `file://${ORACLE}`, ...picked.map((t) => `+${t}:${t}`)],
						{ cwd: tagRefDir },
					)
					const c = await compareRepos(
						"shapes",
						`tag-only fetch (${picked.length} tags)`,
						tagDir,
						tagRefDir,
					)
					summary.push([
						"shapes",
						"tag-only fetch",
						`${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"}`,
					])
				}
			}

			// (c) blob:none partial clone
			const pcDir = join(scratch.mk("pc"), "p.git")
			const pc = await attemptGit([
				"-c",
				"protocol.version=2",
				"clone",
				"--bare",
				"--filter=blob:none",
				"-q",
				url,
				pcDir,
			])
			if (!pc.ok)
				fail("shapes", "--filter=blob:none clone FAILED", pc.stderr.trim().slice(0, 700))
			else {
				const pcRefDir = join(scratch.mk("pcref"), "p.git")
				await spawnGit([
					"clone",
					"--bare",
					"--filter=blob:none",
					"-q",
					`file://${ORACLE}`,
					pcRefDir,
				])
				const c = await compareRepos("shapes", "blob:none clone", pcDir, pcRefDir, {
					refs: false,
				})
				if (c.objects >= cmp.objects) {
					throw new Error(
						`blob:none fixture omitted no objects (${c.objects} filtered vs ${cmp.objects} full)`,
					)
				}
				summary.push([
					"shapes",
					"blob:none clone",
					`${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"}`,
				])
				// Lazy promisor backfill: reading a filtered-out blob through the partial
				// clone must fetch it from pggit and hand back the SAME bytes git does.
				// Canonical git must first prove the named lazy-fetch fixture is viable.
				const [partialInventory, partialOracleInventory] = await Promise.all([
					gitObjectInventory(pcDir),
					gitObjectInventory(pcRefDir),
				])
				const someBlob = [...srcInv.entries()].find(
					([oid, metadata]) =>
						metadata.type === "blob" &&
						metadata.size > 1000 &&
						!partialInventory.has(oid) &&
						!partialOracleInventory.has(oid),
				)?.[0]
				if (!someBlob)
					throw new Error(
						"blob:none fixture has no shared omitted blob larger than 1000 bytes",
					)
				const lazy = await attemptGit(["cat-file", "blob", someBlob], pcDir)
				const lazyRef = await attemptGit(["cat-file", "blob", someBlob], pcRefDir)
				if (!lazyRef.ok) {
					throw new Error(
						`canonical lazy promisor fixture failed for ${someBlob}: ${lazyRef.stderr.trim().slice(0, 500)}`,
					)
				}
				if (!lazy.ok) {
					fail(
						"shapes",
						`lazy promisor blob backfill FAILED (exit ${lazy.code})`,
						`${someBlob}: ${lazy.stderr.trim().slice(0, 500)}`,
					)
				} else if (lazy.stdout !== lazyRef.stdout) {
					fail(
						"shapes",
						"lazy promisor blob backfill returned DIFFERENT BYTES than git",
						someBlob,
					)
				}
				summary.push([
					"shapes",
					"lazy promisor blob backfill",
					lazy.ok ? "OK, bytes match git" : `FAILED (exit ${lazy.code})`,
				])
			}

			// (d) exact-OID fetch of historical commits
			const hist = parseRevListObjectOids(
				(await spawnGit(["rev-list", "--first-parent", "HEAD"], { cwd: MIRROR })).stdout,
			)
			const picks = [
				requiredAt(hist, Math.floor(hist.length * 0.25), "quarter-history commit"),
				requiredAt(hist, Math.floor(hist.length * 0.5), "mid-history commit"),
				requiredAt(hist, Math.floor(hist.length * 0.9), "late-history commit"),
			]
			if (new Set(picks).size !== picks.length) {
				throw new Error(
					`exact-OID fixture needs three distinct historical commits, got ${picks.join(", ") || "none"}`,
				)
			}
			let oidOk = 0
			let canonicalRejected = 0
			for (const oid of picks) {
				const d = join(scratch.mk("oid"), "o.git")
				mkdirSync(d, { recursive: true })
				await spawnGit(["init", "-q", "--bare", d])
				const f = await attemptGit(
					["-c", "protocol.version=2", "fetch", "-q", url, oid],
					d,
				)
				if (!f.ok) {
					// A canonical success makes this a pggit finding. A canonical rejection
					// means the named fixture was never established and is not scoreable.
					const cd = join(scratch.mk("oidcanon"), "o.git")
					mkdirSync(cd, { recursive: true })
					await spawnGit(["init", "-q", "--bare", cd])
					const canon = await attemptGit(["fetch", "-q", `file://${ORACLE}`, oid], cd)
					if (canon.ok) {
						fail(
							"shapes",
							`exact-OID fetch ${oid.slice(0, 8)} rejected`,
							`pggit rejected what canonical git serves — ${f.stderr.trim().split("\n").slice(0, 2).join(" / ")}`,
						)
						continue
					}
					canonicalRejected++
					console.log(
						`  exact-OID fetch ${oid.slice(0, 8)} rejected (canonical git rejects it too)`,
					)
					continue
				}
				oidOk++
				const rd = join(scratch.mk("oidref"), "o.git")
				mkdirSync(rd, { recursive: true })
				await spawnGit(["init", "-q", "--bare", rd])
				await spawnGit(["fetch", "-q", `file://${ORACLE}`, oid], { cwd: rd })
				await compareRepos("shapes", `exact-OID fetch ${oid.slice(0, 8)}`, d, rd, {
					refs: false,
				})
			}
			if (canonicalRejected > 0) {
				throw new Error(
					`exact-OID fixture was not established: canonical git rejected ${canonicalRejected}/${picks.length} requests`,
				)
			}
			summary.push([
				"shapes",
				"exact-OID commit fetch",
				`${oidOk} served (of ${picks.length})`,
			])

			// (e) shallow MUST fail loudly, never hang and never silently succeed
			const shDir = join(scratch.mk("shallow"), "s.git")
			const st = Date.now()
			const sh = await attemptGit([
				"-c",
				"protocol.version=2",
				"clone",
				"--bare",
				"--depth=1",
				"-q",
				url,
				shDir,
			])
			const shMs = Date.now() - st
			if (sh.ok) {
				fail(
					"shapes",
					"shallow clone SUCCEEDED — pggit rejects shallow by design",
					`clone --depth=1 exited 0 in ${secs(shMs)}`,
				)
			} else {
				const clean = /shallow|deepen|unsupported|not supported/i.test(sh.stderr)
				const server500 = /500|internal server error/i.test(sh.stderr)
				console.log(
					`  shallow clone rejected in ${secs(shMs)} (exit ${sh.code}): ${sh.stderr.trim().split("\n").slice(0, 3).join(" / ")}`,
				)
				summary.push([
					"shapes",
					"shallow clone",
					`rejected in ${secs(shMs)} (exit ${sh.code})`,
				])
				if (server500)
					fail(
						"shapes",
						"shallow clone produced a 500 internal server error, not a clean protocol rejection",
						sh.stderr.trim().slice(0, 700),
					)
				else if (!clean)
					fail(
						"shapes",
						"shallow clone rejected but the error names no cause",
						sh.stderr.trim().slice(0, 700),
					)
			}

			// (f) GC over the repacked state, then re-clone — the tier's hygiene (D7)
			const g = await createGc(db.sql).gc(repoId, { graceSeconds: 0 })
			console.log(`  gc: ${g.deletedObjects} objects`)
			const afterGcDir = join(scratch.mk("aftergc"), "c.git")
			const ag = await attemptGit([
				"-c",
				"protocol.version=2",
				"clone",
				"--mirror",
				"-q",
				url,
				afterGcDir,
			])
			if (!ag.ok)
				fail("shapes", "mirror clone AFTER gc FAILED", ag.stderr.trim().slice(0, 700))
			else {
				const c = await compareRepos(
					"shapes",
					"mirror clone after gc",
					afterGcDir,
					refDir,
				)
				summary.push([
					"shapes",
					"clone after gc",
					`${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"} (gc reclaimed ${g.deletedObjects} objs)`,
				])
			}
			// repack again after gc, re-clone
			const rp3 = await createRepack(db.sql).repack(repoId)
			const afterRepackDir = join(scratch.mk("aftergcrepack"), "c.git")
			const ar = await attemptGit([
				"-c",
				"protocol.version=2",
				"clone",
				"--mirror",
				"-q",
				url,
				afterRepackDir,
			])
			if (!ar.ok)
				fail(
					"shapes",
					"mirror clone AFTER gc+repack FAILED",
					ar.stderr.trim().slice(0, 700),
				)
			else {
				const c = await compareRepos(
					"shapes",
					"mirror clone after gc+repack",
					afterRepackDir,
					refDir,
				)
				summary.push([
					"shapes",
					"clone after gc+repack",
					`${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"} (repair: ${rp3.wholes}w+${rp3.deltas}d)`,
				])
			}
		}
	} finally {
		await server.close()
	}
}

// ── PHASE: orphan objects → repack → GC → repack, all over the wire ─────────
// receive-pack ingests the pack BEFORE the deny-non-FF policy runs, so a REJECTED
// push leaves its objects in the store, unreachable. That is the only wire-reachable
// way to make garbage on a refs-only-advance server — and it is exactly the state
// the encoding tier's hygiene rules (design D7) exist for. Every step is checked by
// a clone: the orphans must never leak into a served pack, before or after GC.
async function phaseOrphan(db: IsolatedDb): Promise<void> {
	console.log(`\n## orphan / gc hygiene (denied push leaves objects behind)`)
	const repoId = `realrepo/${SLUG}-orphan`
	const server = await serveOnPort(
		createGitApp(createGitDeps(db.sql), { instrument: true }),
		0,
	)
	const url = `http://127.0.0.1:${server.port}/${repoId}`
	try {
		const head = await revParse(MIRROR, "HEAD")
		// A tip that is NOT an ancestor of HEAD — its push will be denied.
		const divergent = await (async (): Promise<string> => {
			for (const [name] of await refMap(MIRROR)) {
				if (name === "HEAD") continue
				const peeled = await attemptGit(["rev-parse", `${name}^{commit}`], MIRROR)
				if (!peeled.ok) continue
				const oid = peeled.stdout.trim()
				if (oid === head) continue
				const anc = await attemptGit(["merge-base", "--is-ancestor", oid, head], MIRROR)
				if (anc.ok) continue
				if (anc.code === 1) return oid
				throw new Error(
					`canonical merge-base failed for ${oid}: ${anc.stderr.trim().slice(0, 500)}`,
				)
			}
			throw new Error(
				"orphan phase requires a divergent commit ref, but the source has none",
			)
		})()

		await spawnGit(["push", url, `${head}:refs/heads/main`], { cwd: MIRROR })
		const r1 = await createRepack(db.sql).repack(repoId)
		if (r1.wholes + r1.deltas === 0) {
			throw new Error("orphan fixture's initial repack encoded no objects")
		}

		// The denied push: refs must NOT move, objects DO land.
		const denied = await attemptGit(
			["push", url, `+${divergent}:refs/heads/main`],
			MIRROR,
		)
		if (denied.ok) {
			fail(
				"orphan",
				"a non-fast-forward force push was ACCEPTED — refs must only advance",
				`${divergent.slice(0, 8)} → refs/heads/main`,
			)
			return
		}
		console.log(
			`  denied push of ${divergent.slice(0, 8)}: ${denied.stderr.trim().split("\n").slice(-2).join(" / ")}`,
		)

		// The oracle: a file:// bare remote carrying ONLY main.
		const oracle = join(scratch.mk("orphanoracle"), "o.git")
		mkdirSync(oracle, { recursive: true })
		await spawnGit(["init", "-q", "--bare", oracle])
		await spawnGit(["push", `file://${oracle}`, `${head}:refs/heads/main`], {
			cwd: MIRROR,
		})
		const oracleClone = join(scratch.mk("orphanoracleclone"), "o.git")
		await spawnGit(["clone", "--mirror", "-q", `file://${oracle}`, oracleClone])

		const check = async (label: string): Promise<boolean> => {
			const d = join(scratch.mk("orphanclone"), "c.git")
			const c = await attemptGit([
				"-c",
				"protocol.version=2",
				"clone",
				"--mirror",
				"-q",
				url,
				d,
			])
			if (!c.ok) {
				fail("orphan", `${label}: mirror clone FAILED`, c.stderr.trim().slice(0, 700))
				return false
			}
			const cmp = await compareRepos("orphan", label, d, oracleClone)
			return cmp.equal
		}

		// 1. repack WITH the orphans present — they may become anchors.
		const r2 = await createRepack(db.sql).repack(repoId)
		if (r2.wholes + r2.deltas === 0) {
			throw new Error("denied push produced no new encoding work for the orphan fixture")
		}
		console.log(
			`  repack after denied push: ${r2.wholes} wholes + ${r2.deltas} deltas (first pass was ${r1.wholes}w+${r1.deltas}d)`,
		)
		const okBefore = await check("clone with orphans present (must not leak)")

		// 2. GC reclaims them — the FK cascades take their encodings inside the same DELETE.
		const g = await createGc(db.sql).gc(repoId, { graceSeconds: 0 })
		console.log(`  gc: ${g.deletedObjects} objects reclaimed`)
		if (g.deletedObjects === 0) {
			fail(
				"orphan",
				"gc reclaimed NOTHING after a denied push ingested objects",
				`deleted ${g.deletedObjects} objects`,
			)
		}
		const okAfterGc = await check("clone after gc")

		// 3. repack repairs whatever GC's sweep left pending.
		const r3 = await createRepack(db.sql).repack(repoId)
		console.log(`  repack after gc (repair): ${r3.wholes} wholes + ${r3.deltas} deltas`)
		const okAfterRepack = await check("clone after gc+repack")

		summary.push([
			"orphan",
			"denied push",
			`REJECTED correctly, ${r2.wholes + r2.deltas} extra encodings written`,
		])
		summary.push([
			"orphan",
			"clone with orphans",
			okBefore ? "IDENTICAL to git" : "DIVERGED",
		])
		summary.push(["orphan", "gc reclaimed", `${g.deletedObjects} objects`])
		summary.push([
			"orphan",
			"clone after gc",
			okAfterGc ? "IDENTICAL to git" : "DIVERGED",
		])
		summary.push([
			"orphan",
			"clone after gc+repack",
			`${okAfterRepack ? "IDENTICAL to git" : "DIVERGED"} (repair ${r3.wholes}w+${r3.deltas}d)`,
		])
	} finally {
		await server.close()
	}
}

// ── PHASE 2: incremental historical replay ──────────────────────────────────
async function phaseReplay(db: IsolatedDb): Promise<void> {
	console.log(`\n## historical replay (every ${STEP}th first-parent commit)`)
	const repoId = `realrepo/${SLUG}-replay`
	const app = createGitApp(createGitDeps(db.sql), { instrument: true })
	const server = await serveOnPort(app, 0)
	const url = `http://127.0.0.1:${server.port}/${repoId}`
	// the oracle: the same sequence into a plain file:// bare remote
	const oracleRemote = join(scratch.mk("oracleremote"), "o.git")
	mkdirSync(oracleRemote, { recursive: true })
	await spawnGit(["init", "-q", "--bare", oracleRemote])
	try {
		const chain = parseRevListObjectOids(
			(
				await spawnGit(["rev-list", "--first-parent", "--reverse", "HEAD"], {
					cwd: MIRROR,
				})
			).stdout,
		)
		const checkpoints: string[] = []
		for (let i = STEP - 1; i < chain.length; i += STEP) {
			checkpoints.push(requiredAt(chain, i, "replay checkpoint"))
		}
		const last = requiredAt(chain, chain.length - 1, "replay head commit")
		if (checkpoints[checkpoints.length - 1] !== last) checkpoints.push(last)
		if (checkpoints.length < 3) {
			throw new Error(
				`replay fixture produced ${checkpoints.length} checkpoints; need at least 3 to cover repacked and skipped rounds`,
			)
		}
		console.log(`  ${chain.length} first-parent commits → ${checkpoints.length} rounds`)

		type TrackingState =
			| { state: "empty" }
			| { state: "ready"; oracle: string; pggit: string }
		let tracking: TrackingState = { state: "empty" }
		const repackedRounds: number[] = []
		const skippedRounds: number[] = []
		let totalRepack = { deltas: 0, wholes: 0 }

		for (let round = 0; round < checkpoints.length; round++) {
			const rev = requiredAt(checkpoints, round, "replay round checkpoint")
			const p = await attemptGit(["push", url, `${rev}:refs/heads/main`], MIRROR)
			if (!p.ok) {
				fail(
					"replay",
					`round ${round}: push of ${rev.slice(0, 8)} FAILED`,
					p.stderr.trim().slice(0, 700),
				)
				return
			}
			await spawnGit(["push", `file://${oracleRemote}`, `${rev}:refs/heads/main`], {
				cwd: MIRROR,
			})

			// mixed states: skip the repack on every 3rd round
			if (round % 3 === 2) {
				skippedRounds.push(round)
			} else {
				const r = await createRepack(db.sql).repack(repoId)
				totalRepack = {
					deltas: totalRepack.deltas + r.deltas,
					wholes: totalRepack.wholes + r.wholes,
				}
				repackedRounds.push(round)
			}

			if (tracking.state === "empty") {
				const pggitTracking = join(scratch.mk("track"), "t.git")
				const c = await attemptGit([
					"-c",
					"protocol.version=2",
					"clone",
					"--bare",
					"-q",
					url,
					pggitTracking,
				])
				if (!c.ok) {
					fail(
						"replay",
						`round ${round}: initial tracking clone FAILED`,
						c.stderr.trim().slice(0, 700),
					)
					return
				}
				const oracleTracking = join(scratch.mk("otrack"), "t.git")
				await spawnGit([
					"clone",
					"--bare",
					"-q",
					`file://${oracleRemote}`,
					oracleTracking,
				])
				tracking = { oracle: oracleTracking, pggit: pggitTracking, state: "ready" }
			} else {
				const f = await attemptGit(
					[
						"-c",
						"protocol.version=2",
						"fetch",
						"-q",
						"origin",
						"+refs/heads/main:refs/heads/main",
					],
					tracking.pggit,
				)
				if (!f.ok) {
					fail(
						"replay",
						`round ${round}: incremental fetch FAILED`,
						f.stderr.trim().slice(0, 700),
					)
					return
				}
				await spawnGit(["fetch", "-q", "origin", "+refs/heads/main:refs/heads/main"], {
					cwd: tracking.oracle,
				})
			}
			if (tracking.state !== "ready") {
				throw new Error(`round ${round}: tracking clients were not established`)
			}

			const tip = await revParse(tracking.pggit, "refs/heads/main")
			if (tip !== rev) {
				fail(
					"replay",
					`round ${round}: tracking clone tip is wrong`,
					`expected ${rev}, got ${tip}`,
				)
			}
			const fsck = await attemptGit(["fsck", "--strict"], tracking.pggit)
			if (!fsck.ok) {
				fail(
					"replay",
					`round ${round}: git fsck --strict FAILED after fetch`,
					fsck.stderr.trim().slice(0, 900),
				)
			}
			await compareRepos(
				"replay",
				`round ${round} (${rev.slice(0, 8)})`,
				tracking.pggit,
				tracking.oracle,
			)
			process.stdout.write(
				`  round ${round} @ ${rev.slice(0, 8)}${round % 3 === 2 ? " (repack skipped)" : ""}\n`,
			)
		}
		if (
			totalRepack.deltas === 0 ||
			repackedRounds.length === 0 ||
			skippedRounds.length === 0
		) {
			throw new Error(
				`replay fixture was vacuous (${totalRepack.deltas} deltas, ${repackedRounds.length} repacked, ${skippedRounds.length} skipped rounds)`,
			)
		}
		if (tracking.state !== "ready") {
			throw new Error("replay produced no tracking client")
		}

		// final: the tracking clone must equal a fresh file:// clone of the same tip
		const finalRef = join(scratch.mk("finalref"), "f.git")
		await spawnGit(["clone", "--bare", "-q", `file://${oracleRemote}`, finalRef])
		const c = await compareRepos(
			"replay",
			"FINAL tracking clone vs file:// oracle",
			tracking.pggit,
			finalRef,
		)
		summary.push([
			"replay",
			"rounds",
			`${checkpoints.length} (${repackedRounds.length} repacked, ${skippedRounds.length} skipped)`,
		])
		summary.push([
			"replay",
			"incremental repack total",
			`${totalRepack.wholes} wholes + ${totalRepack.deltas} deltas`,
		])
		summary.push([
			"replay",
			"FINAL objects compared",
			`${c.objects} (${c.equal ? "IDENTICAL" : "DIVERGED"})`,
		])

		// and a FRESH clone of the replayed repo (not the incrementally-built one)
		const freshDir = join(scratch.mk("fresh"), "f.git")
		const fr = await attemptGit([
			"-c",
			"protocol.version=2",
			"clone",
			"--bare",
			"-q",
			url,
			freshDir,
		])
		if (!fr.ok)
			fail(
				"replay",
				"fresh clone of the replayed repo FAILED",
				fr.stderr.trim().slice(0, 700),
			)
		else {
			const c2 = await compareRepos(
				"replay",
				"FRESH clone of replayed repo vs file:// oracle",
				freshDir,
				finalRef,
			)
			summary.push([
				"replay",
				"FRESH clone objects",
				`${c2.objects} (${c2.equal ? "IDENTICAL" : "DIVERGED"})`,
			])
		}
	} finally {
		await server.close()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})

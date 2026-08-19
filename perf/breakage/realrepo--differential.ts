/**
 * WIRE-LEVEL DIFFERENTIAL on REAL repositories, against real git as the oracle.
 *
 * Black-box only: the pggit surface exercised is the HTTP wire
 * (`serveOnPort(createGitApp(createGitDeps(sql)), 0)` + real `git push` /
 * `git clone` / `git fetch`), plus the two offline verbs `createRepack().repack()`
 * and `createGc().gc()`. Every verdict is a git-observable outcome — object bytes,
 * ref listings, `git fsck --strict`, transfer sizes. NO database assertions.
 *
 * The oracle is a plain `file://` bare remote replaying the same sequence.
 *
 * A perf harness rather than a vitest e2e test because its corpus is a REAL local
 * repository handed in at run time (`--repo=`), which no committed fixture can stand
 * in for — the same reason `perf/delta-corpus.ts` lives here. The serve-size phase
 * additionally scores a MEASURED ratio (`> 4.0x` is a finding), so the file carries
 * both kinds of verdict into the one exit code, as the source script did.
 *
 *   npx tsx perf/breakage/realrepo--differential.ts --repo=/path/to/checkout --slug=<name> \
 *     [--phases=full,shapes,size,replay] [--step=50]
 *
 * Exit 0 = every phase matched git. Non-zero = a divergence, named on stdout.
 */
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createGitApp, createGitDeps } from "@/index"
import { collectedRuns, resetCollected } from "@/instrument"
import { serveOnPort } from "@/server"
import { createGc } from "@/store/gc"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	createScratch,
	DEFAULT_PG_URL,
	flag,
	mb,
	packBytesOnDisk,
	prepareMirror,
	secs,
	tryGit,
} from "./_realrepo-util"

// ── args ────────────────────────────────────────────────────────────────────
const SLUG = flag("slug", "repo")
const PHASES = new Set(flag("phases", "full,shapes,size,replay").split(","))
const STEP = Number(flag("step", "50"))
const PG_URL = flag("pg", DEFAULT_PG_URL)

const scratch = createScratch(`realrepo-${SLUG}`)
/** The private mirror clone of `--repo=`; set by `prepareMirror` in `main`. */
let MIRROR = ""

// ── findings ledger ─────────────────────────────────────────────────────────
type Finding = { phase: string; what: string; detail: string }
const findings: Finding[] = []
const fail = (phase: string, what: string, detail: string): void => {
	findings.push({ detail, phase, what })
	console.log(`\n!! FINDING [${SLUG}/${phase}] ${what}\n   ${detail}\n`)
}
const summary: string[] = []

// ── git helpers ─────────────────────────────────────────────────────────────
type Inventory = Map<string, { type: string; size: number }>
async function inventory(dir: string): Promise<Inventory> {
	const out = await spawnGit(
		[
			"cat-file",
			"--batch-all-objects",
			"--batch-check=%(objectname) %(objecttype) %(objectsize)",
		],
		{ cwd: dir },
	)
	const inv: Inventory = new Map()
	for (const line of out.stdout.split("\n")) {
		const [oid, type, size] = line.split(" ")
		if (!oid || !type || !size) continue
		inv.set(oid, { size: Number(size), type })
	}
	return inv
}

/** SHA-256 over `<type> <size>\0<content>` for each oid — the object's real bytes
 * as git hands them back, independent of how they were stored or transferred. */
async function digests(dir: string, inv: Inventory): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	let batch: string[] = []
	let bytes = 0
	const flush = async (): Promise<void> => {
		if (batch.length === 0) return
		const res = await spawnGit(["cat-file", "--batch"], {
			cwd: dir,
			input: `${batch.join("\n")}\n`,
		})
		const buf = res.stdoutBytes
		let pos = 0
		while (pos < buf.length) {
			const nl = buf.indexOf(0x0a, pos)
			if (nl < 0) break
			const [oid, type, sizeStr] = buf.subarray(pos, nl).toString("latin1").split(" ")
			if (!oid || !type || !sizeStr) throw new Error(`cat-file: bad header in ${dir}`)
			const size = Number(sizeStr)
			const start = nl + 1
			out.set(
				oid,
				createHash("sha256")
					.update(`${type} ${size}\0`)
					.update(buf.subarray(start, start + size))
					.digest("hex"),
			)
			pos = start + size + 1
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
	const out = await spawnGit(
		["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)"],
		{
			cwd: dir,
		},
	)
	const refs = new Map<string, string>()
	for (const line of out.stdout.split("\n")) {
		const [name, oid, type] = line.split(" ")
		if (!name || !oid) continue
		refs.set(name, `${oid} ${type}`)
	}
	return refs
}

/** Compare two repos object-for-object and ref-for-ref. Returns true when equal. */
async function compareRepos(
	phase: string,
	label: string,
	actualDir: string,
	expectDir: string,
	opts: { refs?: boolean } = {},
): Promise<{ equal: boolean; objects: number }> {
	const [ai, ei] = [await inventory(actualDir), await inventory(expectDir)]
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
	const diverged: string[] = []
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
	const fsck = await tryGit(["fsck", "--strict"], actualDir)
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
let srcInv: Inventory = new Map()

/**
 * The ORACLE remote: a plain `file://` bare repo that received the SAME
 * `git push --mirror` the pggit server did. It must be built by replaying the push,
 * not by cloning the mirror — `git push --mirror` does not carry every ref a mirror
 * clone holds (`refs/stash` is excluded), so a cloned "reference" would charge pggit
 * for git's own push policy. Set by `buildOracleRemote`.
 */
let ORACLE = ""

async function buildOracleRemote(pushArgs: string[]): Promise<void> {
	ORACLE = join(scratch.mk("oracleremote"), "oracle.git")
	mkdirSync(ORACLE, { recursive: true })
	await spawnGit(["init", "-q", "--bare", ORACLE])
	await spawnGit(["push", `file://${ORACLE}`, ...pushArgs], { cwd: MIRROR })
	for (const [k, v] of [
		["uploadpack.allowFilter", "true"],
		["uploadpack.allowAnySHA1InWant", "true"],
		["uploadpack.allowReachableSHA1InWant", "true"],
	]) {
		await spawnGit(["config", k as string, v as string], { cwd: ORACLE })
	}
}

async function main(): Promise<void> {
	MIRROR = await prepareMirror(scratch)
	console.log(`# realrepo differential — ${SLUG}  (mirror ${MIRROR})`)
	// The file:// ORACLE must be allowed to answer the same shapes pggit does —
	// otherwise git refuses the filter / exact-OID want and the "reference" is a
	// different request, not a reference. Config only; objects and refs untouched.
	for (const [k, v] of [
		["uploadpack.allowFilter", "true"],
		["uploadpack.allowAnySHA1InWant", "true"],
		["uploadpack.allowReachableSHA1InWant", "true"],
	]) {
		await spawnGit(["config", k as string, v as string], { cwd: MIRROR })
	}
	srcInv = await inventory(MIRROR)
	const commits = (
		await spawnGit(["rev-list", "--count", "--all"], { cwd: MIRROR })
	).stdout.trim()
	const srcRefs = await refMap(MIRROR)
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
	console.log("| phase | measure | value |")
	console.log("|---|---|---|")
	for (const s of summary) console.log(s)
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
		let pushMode = "--mirror"
		const t0 = Date.now()
		let push = await tryGit(["push", url, "--mirror"], MIRROR)
		if (!push.ok) {
			console.log(
				`  push --mirror rejected (exit ${push.code}): ${push.stderr.trim().split("\n").slice(0, 3).join(" / ")}`,
			)
			pushMode = "--all --tags"
			push = await tryGit(["push", url, "--all", "--tags"], MIRROR)
			if (!push.ok) {
				fail("full", "push --all --tags FAILED", push.stderr.trim().slice(0, 900))
				return
			}
		}
		const pushMs = Date.now() - t0
		summary.push(`| full | push (${pushMode}) | ${secs(pushMs)} |`)
		// The oracle receives the IDENTICAL push, so any ref git's own push policy
		// drops is dropped on both sides.
		await buildOracleRemote(pushMode === "--mirror" ? ["--mirror"] : ["--all", "--tags"])

		// --- clone BEFORE repack (the un-encoded baseline) ----------------------
		resetCollected()
		const preDir = join(scratch.mk("pre"), "c.git")
		const pre = await tryGit([
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
		const prePack =
			collectedRuns()
				.find((r) => r.label === "fetch")
				?.counters.get("packBytes") ?? 0

		// --- repack ------------------------------------------------------------
		const rt = Date.now()
		const rp = await createRepack(db.sql).repack(repoId)
		const repackMs = Date.now() - rt
		console.log(
			`  repack: ${rp.wholes} wholes + ${rp.deltas} deltas in ${secs(repackMs)}`,
		)
		summary.push(
			`| full | repack | ${rp.wholes} wholes + ${rp.deltas} deltas in ${secs(repackMs)} |`,
		)

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

		// --- clone AFTER repack, byte-compare against the oracle ----------------
		resetCollected()
		const postDir = join(scratch.mk("post"), "c.git")
		const ct = Date.now()
		const post = await tryGit([
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
		const run = collectedRuns().find((r) => r.label === "fetch")
		const postPack = run?.counters.get("packBytes") ?? 0
		const deltasServed = run?.counters.get("deltasServed") ?? 0

		const cmp = await compareRepos(
			"full",
			"post-repack mirror clone vs file:// oracle",
			postDir,
			refDir,
		)
		summary.push(
			`| full | objects compared | ${cmp.objects} (${cmp.equal ? "IDENTICAL" : "DIVERGED"}) |`,
		)
		summary.push(`| full | refs compared | ${(await refMap(refDir)).size} |`)

		// the pre-repack clone must be identical too (encoding is derived, D1)
		const cmpPre = await compareRepos(
			"full",
			"pre-repack mirror clone vs file:// oracle",
			preDir,
			refDir,
		)
		summary.push(
			`| full | pre-repack clone | ${cmpPre.equal ? "IDENTICAL" : "DIVERGED"} |`,
		)

		// --- PHASE 4: serve-size sanity ----------------------------------------
		if (PHASES.has("size")) {
			const gcDir = join(scratch.mk("gc"), "gc.git")
			await spawnGit(["clone", "--mirror", "-q", `file://${ORACLE}`, gcDir])
			await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: gcDir })
			const gitCloneDir = join(scratch.mk("gcclone"), "g.git")
			await spawnGit(["clone", "--mirror", "-q", `file://${gcDir}`, gitCloneDir])
			const gitPack = packBytesOnDisk(gitCloneDir)
			const pggitPack = packBytesOnDisk(postDir)
			const ratio = pggitPack / Math.max(gitPack, 1)
			console.log(
				`  serve size: pggit ${mb(pggitPack)} (counter ${mb(postPack)}, ${deltasServed} deltas served) ` +
					`vs git ${mb(gitPack)} = ${ratio.toFixed(2)}x`,
			)
			summary.push(`| size | pre-repack pack | ${mb(prePack)} |`)
			summary.push(
				`| size | post-repack pack | ${mb(pggitPack)} (${deltasServed} deltas, ${secs(cloneMs)} clone) |`,
			)
			summary.push(`| size | git gc --aggressive clone | ${mb(gitPack)} |`)
			summary.push(
				`| size | **pggit / git ratio** | **${ratio.toFixed(2)}x** (pre-repack was ${(prePack / Math.max(gitPack, 1)).toFixed(2)}x) |`,
			)
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
			const headRef = [...(await refMap(MIRROR)).keys()].find(
				(r) => r === "refs/heads/main",
			)
			const branch = headRef
				? "main"
				: (
						[...(await refMap(MIRROR)).keys()].find((r) => r.startsWith("refs/heads/")) ??
						""
					).replace("refs/heads/", "")

			// (a) single-branch clone
			const sbDir = join(scratch.mk("sb"), "sb.git")
			const sb = await tryGit([
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
				summary.push(
					`| shapes | single-branch clone | ${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"} |`,
				)
			}

			// (b) tag-only fetch
			const tags = [...(await refMap(MIRROR)).keys()].filter((r) =>
				r.startsWith("refs/tags/"),
			)
			if (tags.length > 0) {
				const tagDir = join(scratch.mk("tag"), "t.git")
				mkdirSync(tagDir, { recursive: true })
				await spawnGit(["init", "-q", "--bare", tagDir])
				const picked = tags.slice(0, Math.min(4, tags.length))
				const tf = await tryGit(
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
					summary.push(
						`| shapes | tag-only fetch | ${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"} |`,
					)
				}
			}

			// (c) blob:none partial clone
			const pcDir = join(scratch.mk("pc"), "p.git")
			const pc = await tryGit([
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
				summary.push(
					`| shapes | blob:none clone | ${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"} |`,
				)
				// Lazy promisor backfill: reading a filtered-out blob through the partial
				// clone must fetch it from pggit and hand back the SAME bytes git does.
				// Compared against the identical operation over the file:// oracle, so a
				// refusal that is git's own (not pggit's) is not scored as a finding.
				const someBlob = [...srcInv.entries()].find(
					([, m]) => m.type === "blob" && m.size > 1000,
				)?.[0]
				if (someBlob) {
					const lazy = await tryGit(["cat-file", "blob", someBlob], pcDir)
					const lazyRef = await tryGit(["cat-file", "blob", someBlob], pcRefDir)
					if (lazyRef.ok !== lazy.ok) {
						fail(
							"shapes",
							`lazy promisor blob backfill DIVERGES from git (pggit ${lazy.ok ? "ok" : `exit ${lazy.code}`}, git ${lazyRef.ok ? "ok" : `exit ${lazyRef.code}`})`,
							`${someBlob}: ${(lazy.ok ? lazyRef : lazy).stderr.trim().slice(0, 500)}`,
						)
					} else if (lazy.ok && lazy.stdout !== lazyRef.stdout) {
						fail(
							"shapes",
							"lazy promisor blob backfill returned DIFFERENT BYTES than git",
							someBlob,
						)
					}
					summary.push(
						`| shapes | lazy promisor blob backfill | ${lazy.ok ? "OK, bytes match git" : `both refused (exit ${lazy.code})`} |`,
					)
				}
			}

			// (d) exact-OID fetch of historical commits
			const hist = (
				await spawnGit(["rev-list", "--first-parent", "HEAD"], { cwd: MIRROR })
			).stdout
				.trim()
				.split("\n")
				.filter(Boolean)
			const picks = [
				hist[Math.floor(hist.length * 0.25)],
				hist[Math.floor(hist.length * 0.5)],
				hist[Math.floor(hist.length * 0.9)],
			].filter((x): x is string => typeof x === "string")
			let oidOk = 0
			let oidRejected = 0
			for (const oid of picks) {
				const d = join(scratch.mk("oid"), "o.git")
				mkdirSync(d, { recursive: true })
				await spawnGit(["init", "-q", "--bare", d])
				const f = await tryGit(["-c", "protocol.version=2", "fetch", "-q", url, oid], d)
				if (!f.ok) {
					// A rejection only counts as legitimate when CANONICAL git rejects
					// the same fetch — otherwise a broken exact-OID router would merely
					// inflate a printed counter while the harness stays green.
					const cd = join(scratch.mk("oidcanon"), "o.git")
					mkdirSync(cd, { recursive: true })
					await spawnGit(["init", "-q", "--bare", cd])
					const canon = await tryGit(["fetch", "-q", `file://${ORACLE}`, oid], cd)
					if (canon.ok) {
						fail(
							"shapes",
							`exact-OID fetch ${oid.slice(0, 8)} rejected`,
							`pggit rejected what canonical git serves — ${f.stderr.trim().split("\n").slice(0, 2).join(" / ")}`,
						)
					}
					oidRejected++
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
			summary.push(
				`| shapes | exact-OID commit fetch | ${oidOk} served / ${oidRejected} rejected (of ${picks.length}) |`,
			)

			// (e) shallow MUST fail loudly, never hang and never silently succeed
			const shDir = join(scratch.mk("shallow"), "s.git")
			const st = Date.now()
			const sh = await tryGit([
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
				summary.push(
					`| shapes | shallow clone | rejected in ${secs(shMs)} (exit ${sh.code}) |`,
				)
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
			const ag = await tryGit([
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
				summary.push(
					`| shapes | clone after gc | ${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"} (gc reclaimed ${g.deletedObjects} objs) |`,
				)
			}
			// repack again after gc, re-clone
			const rp3 = await createRepack(db.sql).repack(repoId)
			const afterRepackDir = join(scratch.mk("aftergcrepack"), "c.git")
			const ar = await tryGit([
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
				summary.push(
					`| shapes | clone after gc+repack | ${c.objects} objs ${c.equal ? "IDENTICAL" : "DIVERGED"} (repair: ${rp3.wholes}w+${rp3.deltas}d) |`,
				)
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
		const head = (await spawnGit(["rev-parse", "HEAD"], { cwd: MIRROR })).stdout.trim()
		// A tip that is NOT an ancestor of HEAD — its push will be denied.
		let divergent: string | null = null
		for (const [name] of await refMap(MIRROR)) {
			if (name === "HEAD") continue
			const oid = (
				await spawnGit(["rev-parse", `${name}^{commit}`], { cwd: MIRROR })
			).stdout.trim()
			if (oid === head) continue
			const anc = await tryGit(["merge-base", "--is-ancestor", oid, head], MIRROR)
			if (!anc.ok) {
				divergent = oid
				break
			}
		}
		if (divergent === null) {
			console.log("  no divergent ref in this repo — orphan phase not applicable")
			summary.push(`| orphan | applicable | NO (no divergent ref) |`)
			return
		}

		await spawnGit(["push", url, `${head}:refs/heads/main`], { cwd: MIRROR })
		const r1 = await createRepack(db.sql).repack(repoId)

		// The denied push: refs must NOT move, objects DO land.
		const denied = await tryGit(["push", url, `+${divergent}:refs/heads/main`], MIRROR)
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
			const c = await tryGit([
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

		summary.push(
			`| orphan | denied push | REJECTED correctly, ${r2.wholes + r2.deltas} extra encodings written |`,
		)
		summary.push(
			`| orphan | clone with orphans | ${okBefore ? "IDENTICAL to git" : "DIVERGED"} |`,
		)
		summary.push(`| orphan | gc reclaimed | ${g.deletedObjects} objects |`)
		summary.push(
			`| orphan | clone after gc | ${okAfterGc ? "IDENTICAL to git" : "DIVERGED"} |`,
		)
		summary.push(
			`| orphan | clone after gc+repack | ${okAfterRepack ? "IDENTICAL to git" : "DIVERGED"} (repair ${r3.wholes}w+${r3.deltas}d) |`,
		)
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
		const chain = (
			await spawnGit(["rev-list", "--first-parent", "--reverse", "HEAD"], { cwd: MIRROR })
		).stdout
			.trim()
			.split("\n")
			.filter(Boolean)
		const checkpoints: string[] = []
		for (let i = STEP - 1; i < chain.length; i += STEP)
			checkpoints.push(chain[i] as string)
		const last = chain[chain.length - 1] as string
		if (checkpoints[checkpoints.length - 1] !== last) checkpoints.push(last)
		console.log(`  ${chain.length} first-parent commits → ${checkpoints.length} rounds`)

		let tracking: string | null = null
		let oracleTracking: string | null = null
		const repackedRounds: number[] = []
		const skippedRounds: number[] = []
		let totalRepack = { deltas: 0, wholes: 0 }

		for (let round = 0; round < checkpoints.length; round++) {
			const rev = checkpoints[round] as string
			const p = await tryGit(["push", url, `${rev}:refs/heads/main`], MIRROR)
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

			if (tracking === null) {
				tracking = join(scratch.mk("track"), "t.git")
				const c = await tryGit([
					"-c",
					"protocol.version=2",
					"clone",
					"--bare",
					"-q",
					url,
					tracking,
				])
				if (!c.ok) {
					fail(
						"replay",
						`round ${round}: initial tracking clone FAILED`,
						c.stderr.trim().slice(0, 700),
					)
					return
				}
				oracleTracking = join(scratch.mk("otrack"), "t.git")
				await spawnGit([
					"clone",
					"--bare",
					"-q",
					`file://${oracleRemote}`,
					oracleTracking,
				])
			} else {
				const f = await tryGit(
					[
						"-c",
						"protocol.version=2",
						"fetch",
						"-q",
						"origin",
						"+refs/heads/main:refs/heads/main",
					],
					tracking,
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
					cwd: oracleTracking as string,
				})
			}

			const tip = (
				await spawnGit(["rev-parse", "refs/heads/main"], { cwd: tracking })
			).stdout.trim()
			if (tip !== rev) {
				fail(
					"replay",
					`round ${round}: tracking clone tip is wrong`,
					`expected ${rev}, got ${tip}`,
				)
			}
			const fsck = await tryGit(["fsck", "--strict"], tracking)
			if (!fsck.ok) {
				fail(
					"replay",
					`round ${round}: git fsck --strict FAILED after fetch`,
					fsck.stderr.trim().slice(0, 900),
				)
			}
			// spot-check the full object set every 4th round and on the last
			if (round % 4 === 0 || round === checkpoints.length - 1) {
				await compareRepos(
					"replay",
					`round ${round} (${rev.slice(0, 8)})`,
					tracking,
					oracleTracking as string,
				)
			}
			process.stdout.write(
				`  round ${round} @ ${rev.slice(0, 8)}${round % 3 === 2 ? " (repack skipped)" : ""}\n`,
			)
		}

		// final: the tracking clone must equal a fresh file:// clone of the same tip
		const finalRef = join(scratch.mk("finalref"), "f.git")
		await spawnGit(["clone", "--bare", "-q", `file://${oracleRemote}`, finalRef])
		const c = await compareRepos(
			"replay",
			"FINAL tracking clone vs file:// oracle",
			tracking as string,
			finalRef,
		)
		summary.push(
			`| replay | rounds | ${checkpoints.length} (${repackedRounds.length} repacked, ${skippedRounds.length} skipped) |`,
		)
		summary.push(
			`| replay | incremental repack total | ${totalRepack.wholes} wholes + ${totalRepack.deltas} deltas |`,
		)
		summary.push(
			`| replay | FINAL objects compared | ${c.objects} (${c.equal ? "IDENTICAL" : "DIVERGED"}) |`,
		)

		// and a FRESH clone of the replayed repo (not the incrementally-built one)
		const freshDir = join(scratch.mk("fresh"), "f.git")
		const fr = await tryGit([
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
			summary.push(
				`| replay | FRESH clone objects | ${c2.objects} (${c2.equal ? "IDENTICAL" : "DIVERGED"}) |`,
			)
		}
	} finally {
		await server.close()
	}
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})

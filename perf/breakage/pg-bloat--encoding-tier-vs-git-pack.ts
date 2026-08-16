/**
 * pg-bloat--encoding-tier-vs-git-pack — does the derived tier cost what a packfile
 * costs?
 *
 * The delta-pack design's premise (D1/D6) is that `git_pack_encoding` holds
 * exactly the bytes a served pack is made of, so the tier should weigh roughly
 * what git's own packfile weighs for the same objects. That is the claim this
 * harness checks, and it checks the whole bill rather than the payload: a row in
 * Postgres is not just its bytes — it carries a 24-byte tuple header, a line
 * pointer, an entry in the primary-key index, and (for values over ~2 kB under
 * `STORAGE EXTERNAL`) a TOAST chunk plus a TOAST index entry. Sixteen leaf
 * partitions each pay their own relation, index, TOAST relation and TOAST index
 * floor on top.
 *
 * It also states the number the design deliberately accepted (D1: "the canonical
 * ~73 MB does not shrink"): the encoding tier is ADDITIVE, so the storage
 * question is not `encoding vs pack` but `git_object + git_edge + encoding` vs
 * `one packfile`.
 *
 * WHAT IT PRINTS
 *   - `git gc --aggressive`'s packfile for the same objects, and the loose-object
 *     total before it.
 *   - the encoding tier: payload bytes (`sum(octet_length(data))`), heap, TOAST,
 *     index, and the per-row Postgres tax.
 *   - the pack pggit actually serves for a full clone, so "the tier is
 *     pack-sized" can be checked against the pack it produces, not against git's.
 *   - the whole-database bill against the packfile.
 *
 * EXIT NON-ZERO when the encoding tier's on-disk total exceeds `TIER_LIMIT`× the
 * pack it exists to emit.
 *
 *   npx tsx perf/breakage/pg-bloat--encoding-tier-vs-git-pack.ts --runs=1200
 *   npx tsx perf/breakage/pg-bloat--encoding-tier-vs-git-pack.ts --repo=/path/to/repo
 */
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"
import {
	COMMITTER,
	DEFAULT_PG_URL,
	duBytes,
	filler,
	flag,
	mb,
	pad,
	padr,
	reachableObjects,
	runDirName,
	scratchRoot,
	sizeOf,
} from "./_pg-bloat-util"

const REPO_ID = "workspace/slate/tier"
/** the tier may weigh this much more than the pack it emits before it is a defect */
const TIER_LIMIT = 2.0

const PG_URL = flag("pg", DEFAULT_PG_URL)
const RUNS = Number(flag("runs", "1200"))
const DOCS = Number(flag("docs", "120"))
const REPO = flag("repo", "")

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
		const m = blob(`# doc ${i}\n\n${filler(`doc-${i}-v0`, 2000)}\n`)
		seeded.push(`M 100644 :${m} docs/planner-updates/doc-${i}.md`)
	}
	let prev = next()
	out.push(
		`commit refs/heads/main\nmark :${prev}\ncommitter ${COMMITTER}\ndata 4\nseed\n${seeded.join("\n")}\n`,
	)
	for (let i = 0; i < RUNS; i++) {
		const dir = runDirName("tier", i)
		const record = blob(
			`{"run":"${dir}","status":"ok","p":"${filler(`rec-${i}`, 1200)}"}\n`,
		)
		const stderr = blob(`${filler(`err-${i}`, 400)}\n`)
		const changes = [
			`M 100644 :${record} .engine/runs/planner-updates/${dir}/record.json`,
			`M 100644 :${stderr} .engine/runs/planner-updates/${dir}/stderr`,
		]
		if (i % 13 === 0) {
			const d = i % DOCS
			const m = blob(`# doc ${d}\n\n${filler(`doc-${d}-v${i}`, 2000)}\n`)
			changes.push(`M 100644 :${m} docs/planner-updates/doc-${d}.md`)
		}
		const cm = next()
		out.push(
			`commit refs/heads/main\nmark :${cm}\ncommitter ${COMMITTER}\ndata 3\nrun\nfrom :${prev}\n${changes.join("\n")}\n`,
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
		if (REPO) {
			// Never operate on the original: mirror-clone first (the design doc's rule).
			await spawnGit(["clone", "-q", "--mirror", REPO, src])
			console.log(`source: mirror clone of ${REPO}`)
		} else {
			await spawnGit(["init", "-q", "-b", "main", src])
			await spawnGit(["fast-import", "--quiet"], { cwd: src, input: buildStream() })
			console.log(
				`source: generated append-only shape — ${RUNS} run-dir commits over ${DOCS} docs`,
			)
		}

		const objects = await reachableObjects(src)
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
		const looseBytes = await duBytes(gcDir)
		await spawnGit(["gc", "--aggressive", "--prune=now", "-q"], { cwd: gcDir })
		const gcBytes = await duBytes(gcDir)
		const sizePack =
			Number(
				(await spawnGit(["count-objects", "-v"], { cwd: gcDir })).stdout.match(
					/size-pack: (\d+)/,
				)?.[1] ?? 0,
			) * 1024
		console.log(
			`git: ${mb(looseBytes)} MB as received → ${mb(gcBytes)} MB after \`gc --aggressive\` ` +
				`(packfile itself ${mb(sizePack)} MB)`,
		)

		// ── the same objects in pggit ───────────────────────────────────────
		const store = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		let batch: typeof objects = []
		let bytes = 0
		const flush = async () => {
			if (batch.length === 0) return
			await store.putPack(
				REPO_ID,
				batch.map((o) => ({ content: o.content, type: o.type })),
			)
			batch = []
			bytes = 0
		}
		for (const o of objects) {
			batch.push(o)
			bytes += o.content.length
			if (bytes >= 16_000_000) await flush()
		}
		await flush()
		for (const line of (await spawnGit(["show-ref", "--heads"], { cwd: src })).stdout
			.trim()
			.split("\n")) {
			const [oid, name] = line.split(" ")
			if (oid && name) await refs.setRef(REPO_ID, name, oid)
		}
		const head = (await spawnGit(["symbolic-ref", "HEAD"], { cwd: src })).stdout.trim()
		await refs.setSymref(REPO_ID, "HEAD", head || "refs/heads/main")

		const beforeRepack = await sizeOf(db.sql, "git_pack_encoding")
		const t0 = Date.now()
		const res = await createRepack(db.sql).repack(REPO_ID)
		const repackMs = Date.now() - t0
		console.log(
			`\nrepack: ${res.wholes} wholes + ${res.deltas} deltas in ${(repackMs / 1000).toFixed(1)}s ` +
				`(tier grew ${mb(beforeRepack.total)} → …)`,
		)

		// ── the pack pggit actually serves ──────────────────────────────────
		const app = createGitApp(createGitDeps(db.sql))
		const server = await serveOnPort(app, 0)
		const dest = scratch.dir("clone")
		await spawnGit([
			"-c",
			"protocol.version=2",
			"clone",
			"-q",
			"--mirror",
			`http://127.0.0.1:${server.port}/${REPO_ID}`,
			dest,
		])
		await server.close()
		const servedPack =
			Number(
				(await spawnGit(["count-objects", "-v"], { cwd: dest })).stdout.match(
					/size-pack: (\d+)/,
				)?.[1] ?? 0,
			) * 1024
		await spawnGit(["fsck", "--strict", "--no-dangling"], { cwd: dest })
		console.log(
			`served: a real \`git clone\` over the wire received ${mb(servedPack)} MB, fsck clean`,
		)

		// ── the bill ────────────────────────────────────────────────────────
		const enc = await sizeOf(db.sql, "git_pack_encoding")
		const obj = await sizeOf(db.sql, "git_object")
		const edge = await sizeOf(db.sql, "git_edge")
		const [payload] = await db.sql<
			{ n: string; oct: string; col: string; big: string; maxo: string }[]
		>`
			select count(*)::text as n, sum(octet_length(data))::text as oct,
				sum(pg_column_size(data))::text as col,
				count(*) filter (where octet_length(data) > 2000)::text as big,
				max(octet_length(data))::text as maxo
			from git_pack_encoding`
		const payloadBytes = Number(payload?.oct ?? 0)
		const rows = Number(payload?.n ?? 0)

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
			`\n${rows} rows · ${payload?.big} of them (${((Number(payload?.big) / rows) * 100).toFixed(1)}%) exceed ~2 kB and ` +
				`go out-of-line under STORAGE EXTERNAL (max ${payload?.maxo} B) — each is one extra\n` +
				`TOAST index probe + chunk read on the serve path that an inline value would not pay.`,
		)
		console.log(
			`\nPostgres tax on the payload: ${mb(enc.total - payloadBytes)} MB over ${mb(payloadBytes)} MB of ` +
				`actual pack bytes = ${((enc.total / payloadBytes - 1) * 100).toFixed(0)}% overhead ` +
				`(${((enc.total - payloadBytes) / rows).toFixed(0)} bytes per object).`,
		)

		console.log(`\n## the whole bill\n`)
		console.log(`${padr("store", 34)} ${pad("MB", 9)} ${pad("× git pack", 11)}`)
		const row = (name: string, v: number) =>
			console.log(
				`${padr(name, 34)} ${pad(mb(v), 9)} ${pad((v / Math.max(sizePack, 1)).toFixed(2), 11)}`,
			)
		row("git packfile (gc --aggressive)", sizePack)
		row("pack pggit serves", servedPack)
		row("git_pack_encoding (the tier)", enc.total)
		row("git_object (canonical, unshrunk)", obj.total)
		row("git_edge (the DAG index)", edge.total)
		row("all three", enc.total + obj.total + edge.total)

		const ratio = enc.total / Math.max(servedPack, 1)
		console.log(
			`\nthe tier weighs ${ratio.toFixed(2)}× the pack it exists to emit ` +
				`(design premise: ~1×).`,
		)
		console.log(
			`the design accepted that git_object does not shrink (D1); the measured consequence is\n` +
				`that a repo whose packfile is ${mb(sizePack)} MB occupies ` +
				`${mb(enc.total + obj.total + edge.total)} MB of Postgres — ` +
				`${((enc.total + obj.total + edge.total) / Math.max(sizePack, 1)).toFixed(1)}× — of which the\n` +
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

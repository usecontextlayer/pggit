/**
 * The hazard the design names but nothing tests: "Base selection is contextual, not
 * intrinsic (a later branch can introduce new same-path pairs), so 'packed once, never
 * revisited' is an ENFORCED policy" (D4). Every existing check pushes one linear
 * history or the whole mirror at once — neither ever hands repack a PARTIAL DAG,
 * freezes anchors over it, and then extends the DAG with a branch whose first-parent
 * lineage interleaves with trees already anchored.
 *
 * This does exactly that, on REAL repository history: push the mirror's refs ONE AT A
 * TIME with a repack between every push, in two different orders, and check both
 * results against a plain `file://` remote that received the identical per-ref
 * sequence. Two orders because a frozen policy that is order-dependent in a way that
 * matters would show up as one order diverging and the other not.
 *
 * It also checks the design's central read-side invariant after the client has indexed the received pack: `git verify-pack -v` prints each delta entry's chain depth, so "depth <= 1, structurally" (D2/D9) is directly falsifiable. This is client-storage evidence, not a raw-wire byte measurement; thin-pack indexing may append external bases.
 *
 * A perf harness rather than a vitest e2e test because its corpus is a REAL local repository selected at run time (`--repo=` or `--mirror=`), which no committed fixture can stand in for — the same reason `perf/delta-corpus.ts` lives here.
 *
 *   npx tsx perf/breakage/realrepo--branch-order.ts --repo=/path/to/checkout --slug=<name>
 *
 * Exit 0 = both orders serve canonical refs and objects, at depth <= 1.
 * Exit 1 = reproduced, with the diverging ref/object or the offending depth named.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { allRefsOf, requiredAt, verifyPackObjectsInRepo } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { attemptGit, spawnGit } from "@/testing/spawn-git"
import { nonemptyStringArg, parseArgs, pgUrlArg, positiveIntegerArg } from "../args"
import { table } from "../table"
import {
	assertCanonicalRealRepoStore,
	createLedger,
	createScratch,
	mirrorSourceFromArgs,
	oidSet,
	prepareMirror,
	repackExactly,
} from "./_realrepo-util"

const args = parseArgs(
	z
		.object({
			"max-depth": positiveIntegerArg.default(1),
			mirror: nonemptyStringArg.optional(),
			pg: pgUrlArg,
			repo: nonemptyStringArg.optional(),
			slug: nonemptyStringArg.default("repo"),
		})
		.strict()
		.transform(({ mirror, repo, ...values }) => ({
			...values,
			source: mirrorSourceFromArgs({ mirror, repo }),
		})),
)
const SLUG = args.slug
const MAX_DEPTH = args["max-depth"]
const PG_URL = args.pg

const scratch = createScratch(`border-${SLUG}`)
const { fail, findings, report } = createLedger(SLUG)
/** The private mirror clone of the selected source; set by `prepareMirror` in `main`. */
let MIRROR = ""

async function refList(dir: string): Promise<string> {
	return (await allRefsOf(dir)).map(({ name, oid }) => `${name} ${oid}`).join("\n")
}

/** Delta chain depths as the CLIENT measures them, from `git verify-pack -v`.
 * Column 6 is the chain depth for a deltified entry; absent for a base entry. */
async function depthHistogram(bareDir: string): Promise<Map<number, number>> {
	const hist = new Map<number, number>()
	for (const pack of await verifyPackObjectsInRepo(bareDir)) {
		for (const object of pack.objects) {
			if (object.kind !== "delta") continue
			hist.set(object.depth, (hist.get(object.depth) ?? 0) + 1)
		}
	}
	return hist
}

async function runOrder(
	db: IsolatedDb,
	port: number,
	label: string,
	refs: string[],
): Promise<
	| { state: "clone-failed" }
	| { state: "push-failed" }
	| { state: "complete"; oids: Set<string> }
> {
	const repoId = `border/${SLUG}-${label}`
	const url = `http://127.0.0.1:${port}/${repoId}`
	const oracle = join(scratch.mk(`oracle-${label}`), "o.git")
	mkdirSync(oracle, { recursive: true })
	await spawnGit(["init", "-q", "-b", "main", "--bare", oracle])

	let totalW = 0
	let totalD = 0
	let accepted = 0
	let postFirstObjects = 0
	for (const ref of refs) {
		const o = await attemptGit(["push", `file://${oracle}`, `+${ref}:${ref}`], MIRROR)
		if (!o.ok) {
			throw new Error(
				`${label}: canonical git rejected fixture ref ${ref}: ${o.stderr.trim().slice(0, 500)}`,
			)
		}
		const p = await attemptGit(["push", url, `+${ref}:${ref}`], MIRROR)
		if (!p.ok) {
			fail(
				`${label}: pggit rejected canonical ref push ${ref} (exit ${p.code})`,
				p.stderr.trim().slice(0, 500),
			)
			return { state: "push-failed" }
		}
		accepted++
		// repack after EVERY ref: anchors freeze over a partial DAG, then the next
		// ref extends it. This is the D4 stress.
		const r = await repackExactly(db.sql, repoId)
		totalW += r.wholes
		totalD += r.deltas
		if (accepted > 1) postFirstObjects += r.wholes + r.deltas
	}
	if (accepted < 2 || postFirstObjects === 0 || totalD === 0) {
		throw new Error(
			`${label}: branch-order fixture exercised ${accepted} accepted refs, ${postFirstObjects} objects introduced after the first, and ${totalD} deltas`,
		)
	}
	await assertCanonicalRealRepoStore(db.sql, repoId, oracle, { kind: "repacked" })
	console.log(
		`  ${label}: ${refs.length} refs pushed one at a time, repack totals ${totalW}w + ${totalD}d`,
	)

	const clone = join(scratch.mk(`clone-${label}`), "c.git")
	const c = await attemptGit([
		"-c",
		"protocol.version=2",
		"clone",
		"--mirror",
		"-q",
		url,
		clone,
	])
	if (!c.ok) {
		fail(
			`${label}: mirror clone after per-ref pushes FAILED`,
			c.stderr.trim().slice(0, 800),
		)
		return { state: "clone-failed" }
	}
	const oracleClone = join(scratch.mk(`oclone-${label}`), "o.git")
	await spawnGit(["clone", "--mirror", "-q", `file://${oracle}`, oracleClone])

	const fsck = await attemptGit(["fsck", "--strict"], clone)
	if (!fsck.ok)
		fail(`${label}: git fsck --strict FAILED`, fsck.stderr.trim().slice(0, 800))

	const [got, want] = [await oidSet(clone), await oidSet(oracleClone)]
	const missing = [...want].filter((o) => !got.has(o))
	const extra = [...got].filter((o) => !want.has(o))
	if (missing.length > 0 || extra.length > 0) {
		fail(
			`${label}: object set diverges from git`,
			`${missing.length} missing, ${extra.length} extra (first missing ${missing[0] ?? "-"})`,
		)
	}
	const [gr, wr] = [await refList(clone), await refList(oracleClone)]
	if (gr !== wr)
		fail(
			`${label}: ref listing diverges from git`,
			`${gr.split("\n").length} vs ${wr.split("\n").length} refs`,
		)

	const hist = await depthHistogram(clone)
	if (hist.size === 0) {
		throw new Error(`${label}: client-indexed clone contains zero delta entries`)
	}
	const depths = [...hist.entries()].sort((a, b) => a[0] - b[0])
	const [maxDepth] = requiredAt(
		depths,
		depths.length - 1,
		`${label}: maximum delta depth`,
	)
	console.log(
		`  ${label}: served delta depths ${depths.map(([d, n]) => `${d}:${n}`).join(" ") || "(none)"}`,
	)
	if (maxDepth > MAX_DEPTH) {
		fail(
			`${label}: served pack contains delta chains DEEPER than the design's structural bound`,
			`max depth ${maxDepth} (bound ${MAX_DEPTH}); histogram ${depths.map(([d, n]) => `depth ${d}: ${n} entries`).join(", ")}`,
		)
	}
	report.push([
		label,
		`${refs.length} refs, one push each + repack`,
		missing.length === 0 && extra.length === 0 && gr === wr
			? "IDENTICAL to git"
			: "DIVERGED",
	])
	report.push([
		label,
		"served delta depth",
		`max ${maxDepth} (${depths.map(([d, n]) => `${d}:${n}`).join(" ") || "no deltas"})`,
	])
	return { oids: got, state: "complete" }
}

async function main(): Promise<void> {
	MIRROR = await prepareMirror(scratch, args.source)
	console.log(`# branch-order stress — ${SLUG}\n  mirror ${MIRROR}`)
	const fixtureRefs = (await allRefsOf(MIRROR)).filter(
		({ name }) =>
			name.startsWith("refs/heads/") ||
			name.startsWith("refs/tags/") ||
			name.startsWith("refs/remotes/"),
	)
	const refs = fixtureRefs.map(({ name }) => name)
	if (refs.length < 2) {
		throw new Error(`branch-order fixture needs at least two refs, got ${refs.length}`)
	}
	const distinctTips = new Set(fixtureRefs.map(({ oid }) => oid))
	if (distinctTips.size < 2) {
		throw new Error(`branch-order fixture needs at least two distinct ref tips`)
	}
	console.log(`  ${refs.length} refs`)

	const db = await createIsolatedSchema(PG_URL)
	const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
	try {
		const forward = await runOrder(db, server.port, "forward", [...refs].sort())
		const reverse = await runOrder(db, server.port, "reverse", [...refs].sort().reverse())
		if (forward.state === "complete" && reverse.state === "complete") {
			const only1 = [...forward.oids].filter((o) => !reverse.oids.has(o))
			const only2 = [...reverse.oids].filter((o) => !forward.oids.has(o))
			if (only1.length > 0 || only2.length > 0) {
				fail(
					"the two push ORDERS produced different served object sets",
					`forward-only ${only1.length}, reverse-only ${only2.length}`,
				)
			}
			report.push([
				"both",
				"forward vs reverse object sets",
				only1.length === 0 && only2.length === 0 ? "identical" : "DIVERGED",
			])
		}
	} finally {
		await server.close()
		await db.drop()
		scratch.cleanup()
	}

	console.log(`\n## ${SLUG} — branch-order stress\n`)
	console.log(table(["order", "what", "verdict"], report))
	console.log(
		`\n${findings.length === 0 ? "VERDICT: clean — both orders matched git, depth bound held." : `VERDICT: ${findings.length} FINDING(S)`}`,
	)
	for (const f of findings) console.log(`  - ${f}`)
	if (findings.length > 0) process.exitCode = 1
}

main().catch((err) => {
	console.error(err)
	process.exitCode = 2
})

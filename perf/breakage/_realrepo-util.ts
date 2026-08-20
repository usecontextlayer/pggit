/**
 * Shared plumbing for the `realrepo--*` breakage harnesses.
 *
 * These drive REAL repository history (this checkout, `trove`, `web`, a customer
 * mirror) through the pggit wire, so the one thing they must never do is touch the
 * repository they are pointed at: they `git push` from it, `git config` it, and `git
 * gc` the oracles built from it. `prepareMirror` is the single door — every harness
 * resolves `--repo=` / `--mirror=` through it and works on the private clone it
 * returns, so a source checkout stays byte-for-byte pristine.
 *
 * Everything here is shared boundary work: strict arguments, scratch ownership, raw-pack indexing, exact stored-tier coverage, canonical object/ref readers, and a findings ledger. Measurements and thresholds remain in the harness that owns them.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Sql } from "postgres"
import { MAX_INLINE_BYTEA_BYTES } from "@/database/bytea"
import { createRepack } from "@/store/repack"
import {
	allObjectOids,
	parseVerifyPackObjects,
	type VerifyPackObject,
} from "@/testing/git-fixtures"
import { sidebandDemux } from "@/testing/pkt-oracle"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"
import { spawnUploadPack } from "@/testing/upload-pack-oracle"

export { flag, positiveIntegerFlag, positiveNumberFlag } from "../args"

import { flag } from "../args"

/** The shared docker-compose Postgres every perf harness defaults to. */
export const DEFAULT_PG_URL = "postgres://postgres:postgres@localhost:6489/postgres"

export const kb = (n: number): string => `${(n / 1000).toFixed(0)} KB`
export const mb = (n: number): string => `${(n / 1_000_000).toFixed(2)} MB`
export const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export type Scratch = {
	/** A fresh temp directory, remembered so `cleanup()` can remove it. */
	mk: (tag: string) => string
	cleanup: () => void
}

export function createScratch(prefix: string): Scratch {
	const dirs: string[] = []
	return {
		cleanup: () => {
			for (const d of dirs) rmSync(d, { force: true, recursive: true })
		},
		mk: (tag: string) => {
			const d = mkdtempSync(join(tmpdir(), `${prefix}-${tag}-`))
			dirs.push(d)
			return d
		},
	}
}

/**
 * Resolve `--repo=<path>` (or `--mirror=<bare.git>`) into a PRIVATE bare mirror in
 * scratch, and hand back that path.
 *
 * Never work on the caller's repository: these harnesses push from it, write
 * `uploadpack.*` config into it, and `git gc` what they build out of it — and a
 * customer mirror or a live checkout must stay byte-for-byte pristine. A MIRROR
 * clone (not a directory copy) takes every ref and object and no working tree — so
 * pointing this at a dev checkout does not copy its node_modules — and
 * `--no-hardlinks` keeps the clone's object files physically its own, so nothing
 * here can reach back into the source's store.
 */
export async function prepareMirror(scratch: Scratch): Promise<string> {
	const repo = flag("repo", "")
	const mirror = flag("mirror", "")
	if ((repo === "") === (mirror === "")) {
		throw new Error("exactly one of --repo=<path> or --mirror=<bare.git> is required")
	}
	const source = repo || mirror
	const work = join(scratch.mk("mirror"), "source.git")
	await spawnGit(["clone", "--mirror", "--no-hardlinks", "-q", source, work])
	return work
}

export type GitOutcome = { ok: boolean; code: number; stdout: string; stderr: string }

/** `spawnGit`, but a non-zero exit is an OUTCOME to compare against the oracle's,
 * not a throw — "pggit rejected what git accepted" is the finding these harnesses
 * exist to catch, and it is only visible if both sides report their exit code. */
export async function tryGit(
	args: string[],
	cwd?: string,
	input?: string,
): Promise<GitOutcome> {
	try {
		const r = await spawnGit(args, { cwd, input })
		return { code: 0, ok: true, stderr: r.stderr, stdout: r.stdout }
	} catch (err) {
		if (err instanceof GitCommandError) {
			return { code: err.code, ok: false, stderr: err.stderr, stdout: err.stdout }
		}
		throw err
	}
}

function requireV2Pack(response: Buffer, source: string): Buffer {
	const { band1, band3 } = sidebandDemux(response)
	if (band3.length > 0) {
		throw new Error(`${source} returned sideband error: ${band3.toString("utf8").trim()}`)
	}
	if (band1.length < 12) {
		throw new Error(`${source} returned no complete band-1 pack (${band1.length} bytes)`)
	}
	const magic = band1.subarray(0, 4).toString("ascii")
	if (magic !== "PACK") {
		throw new Error(`${source} returned unexpected band-1 magic ${JSON.stringify(magic)}`)
	}
	const objectCount = band1.readUInt32BE(8)
	if (objectCount === 0) throw new Error(`${source} returned an empty pack`)
	return band1
}

/** POST one v2 request to pggit and return the exact PACK bytes from sideband 1. */
export async function postPggitV2Pack(repoUrl: string, request: Buffer): Promise<Buffer> {
	const response = await fetch(`${repoUrl.replace(/\/$/, "")}/git-upload-pack`, {
		body: request,
		headers: {
			"Content-Type": "application/x-git-upload-pack-request",
			"Git-Protocol": "version=2",
		},
		method: "POST",
	})
	if (!response.ok) {
		throw new Error(
			`pggit upload-pack returned HTTP ${response.status}: ${await response.text()}`,
		)
	}
	const contentType = response.headers.get("content-type")
	if (contentType !== "application/x-git-upload-pack-result") {
		throw new Error(
			`pggit upload-pack returned content-type ${JSON.stringify(contentType)}`,
		)
	}
	return requireV2Pack(Buffer.from(await response.arrayBuffer()), "pggit upload-pack")
}

/** Feed one v2 request to canonical upload-pack and return its exact sideband-1 PACK. */
export async function canonicalV2Pack(dir: string, request: Buffer): Promise<Buffer> {
	return requireV2Pack(await spawnUploadPack(dir, request), "canonical git upload-pack")
}

/** Canonically index one raw response pack and return its transmitted entries. */
export async function indexRawPack(
	dir: string,
	pack: Buffer,
	fixThin: boolean,
): Promise<{ appendedBases: number; entries: VerifyPackObject[] }> {
	if (pack.length < 12 || pack.subarray(0, 4).toString("ascii") !== "PACK") {
		throw new Error(`raw pack has no complete PACK header (${pack.length} bytes)`)
	}
	const headerCount = pack.readUInt32BE(8)
	if (headerCount === 0) throw new Error("raw pack declares zero transmitted objects")
	const indexed = await spawnGit(
		["index-pack", "--stdin", ...(fixThin ? ["--fix-thin"] : [])],
		{ cwd: dir, input: pack },
	)
	const receipt = indexed.stdout.trim()
	const receiptMatch = receipt.match(/^pack\t([0-9a-f]{40})$/)
	const packHash = receiptMatch?.[1]
	if (packHash === undefined) {
		throw new Error(
			`git index-pack returned unexpected pack hash ${JSON.stringify(indexed.stdout)}`,
		)
	}
	const indexPath = (
		await spawnGit(
			[
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				`objects/pack/pack-${packHash}.idx`,
			],
			{ cwd: dir },
		)
	).stdout.trim()
	if (indexPath.length === 0)
		throw new Error(`git-path returned no index for pack ${packHash}`)
	const verified = await spawnGit(["verify-pack", "-v", indexPath], { cwd: dir })
	const objects = parseVerifyPackObjects(verified.stdout).sort(
		(a, b) => a.offset - b.offset,
	)
	if (objects.length < headerCount) {
		throw new Error(
			`verify-pack described ${objects.length} objects for raw pack header count ${headerCount}`,
		)
	}
	return {
		appendedBases: objects.length - headerCount,
		entries: objects.slice(0, headerCount),
	}
}

/** Canonically index one raw response pack and return only the OIDs that crossed the wire. */
export async function rawPackObjectOids(
	dir: string,
	pack: Buffer,
	fixThin: boolean,
): Promise<{ appendedBases: number; oids: string[] }> {
	const indexed = await indexRawPack(dir, pack, fixThin)
	return {
		appendedBases: indexed.appendedBases,
		oids: indexed.entries.map((object) => object.oid).sort(),
	}
}

export type EncodingCoverage = {
	eligible: number
	encoded: number
	ineligible: number
}

/** Exact stored-tier coverage for one repository. */
export async function encodingCoverage(
	sql: Sql,
	repo: string,
): Promise<EncodingCoverage> {
	const rows = await sql<EncodingCoverage[]>`
		select
			(select count(*)::int from git_object o
				where o.repo_id = r.id and o.size < ${MAX_INLINE_BYTEA_BYTES}) as eligible,
			(select count(*)::int from git_pack_encoding e
				where e.repo_id = r.id) as encoded,
			(select count(*)::int from git_pack_encoding e
				join git_object o on o.repo_id = e.repo_id and o.oid = e.oid
				where e.repo_id = r.id and o.size >= ${MAX_INLINE_BYTEA_BYTES}) as ineligible
		from repos r where r.name = ${repo}`
	if (rows.length !== 1) {
		throw new Error(`${repo}: expected one repository coverage row, got ${rows.length}`)
	}
	const coverage = rows[0] as EncodingCoverage
	if (
		!Number.isSafeInteger(coverage.eligible) ||
		!Number.isSafeInteger(coverage.encoded) ||
		!Number.isSafeInteger(coverage.ineligible) ||
		coverage.eligible <= 0 ||
		coverage.encoded < 0 ||
		coverage.encoded > coverage.eligible ||
		coverage.ineligible !== 0
	) {
		throw new Error(`${repo}: invalid encoding coverage ${JSON.stringify(coverage)}`)
	}
	return coverage
}

/** Run one ordinary repack and require its receipt to close the exact eligible tier gap. */
export async function repackExactly(
	sql: Sql,
	repo: string,
): Promise<{ wholes: number; deltas: number; coverage: EncodingCoverage }> {
	const before = await encodingCoverage(sql, repo)
	const receipt = await createRepack(sql).repack(repo)
	const written = receipt.wholes + receipt.deltas
	const pending = before.eligible - before.encoded
	if (written !== pending) {
		throw new Error(
			`${repo}: repack wrote ${written}/${pending} pending eligible objects`,
		)
	}
	const coverage = await encodingCoverage(sql, repo)
	if (coverage.encoded !== coverage.eligible) {
		throw new Error(
			`${repo}: repack left coverage ${coverage.encoded}/${coverage.eligible}`,
		)
	}
	return { ...receipt, coverage }
}

export type Ledger = {
	findings: string[]
	report: string[]
	fail: (what: string, detail: string) => void
}

/** Findings are collected, printed as they happen, and re-printed at the end; the
 * harness exits non-zero when the ledger is non-empty. */
export function createLedger(slug: string): Ledger {
	const findings: string[] = []
	const report: string[] = []
	return {
		fail: (what: string, detail: string): void => {
			findings.push(`${what}: ${detail}`)
			console.log(`\n!! FINDING [${slug}] ${what}\n   ${detail}\n`)
		},
		findings,
		report,
	}
}

/** Every object git can name in a repo — the set a clone must reproduce exactly. */
export async function oidSet(dir: string): Promise<Set<string>> {
	return new Set(await allObjectOids(dir))
}

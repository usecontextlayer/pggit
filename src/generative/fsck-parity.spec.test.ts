/**
 * §8.4 generative — INGEST VALIDATION vs canonical `git fsck --strict`.
 *
 * `validateObject` / `deriveCommitRow` / `deriveTagRow` are pggit's fsck: the one
 * boundary where a pushed object's bytes become queryable state. Every strictness
 * rule they carry was written by READING git's source one hand-picked case at a
 * time, and the suite that claims parity with `git fsck` drives three fixed
 * fixtures. This property drives the boundary itself: it manufactures raw object
 * bytes (trees with hostile modes and names, commits and tags with missing and
 * duplicated headers), stores each one in a scratch repo with `git hash-object
 * --literally` — the only way to get a malformed object INTO git — and reads
 * canonical `git fsck --strict`'s verdict on the same bytes.
 *
 * THE CONTRACT IS TWO-SIDED, and neither side is "identical verdicts":
 *
 *   1. git ERRORS   ⇒ pggit rejects, unless git's message class is RECORDED below.
 *   2. git does NOT ⇒ pggit accepts, unless pggit's error code is RECORDED below.
 *
 * (git's third band — `warning in …`, which `--strict` does not promote — counts as
 * "does not error": rule 2 covers it, so pggit refusing a merely-warned object is a
 * divergence that has to be recorded like any other.)
 *
 * The recorded sets are the point. pggit is deliberately not fsck: it is STRICTER
 * where its derived state cannot survive git's tolerance (a noncanonical tree mode
 * would make the walks type a subtree as a blob; D16 requires UTF-8 paths because
 * the `repo_file` projection is `text`), and LOOSER where a malformed object is
 * merely useless rather than dangerous (an unsorted tree, an authorless commit).
 * Both lists are MEASURED — every entry was produced by running git, not by reading
 * it — and a divergence outside them fails the property. That is the honest
 * statement of the boundary, and it is what makes a new divergence (in either
 * direction, from a pggit change or a git upgrade) fail loudly instead of being
 * nobody's business.
 *
 * Anti-vacuity: each property floors both agreement directions AND requires every
 * recorded class to be realized BY A DIVERGENT CANDIDATE, so a recorded entry
 * cannot rot into a permanently-unexercised excuse.
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * HERMETIC: no Postgres, no server — one scratch repo + one `git fsck` per candidate.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { deriveCommitRow, deriveTagRow, validateObject } from "@/object/derive"
import { GitFormatError } from "@/object/format-error"
import type { GitObjectType } from "@/object/object"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

const NUL = Buffer.from([0])
const PINNED = { numRuns: 80, seed: 424_242 } as const

/** git's verdict on ONE object: did it ERROR, and which message classes did it
 * report? `classes` are git's own fsck message ids where it emits one (`hasDot`,
 * `treeNotSorted`, …) and the normalized message text where it does not (the
 * parser-level `object could not be parsed` family). */
type GitVerdict = { classes: string[]; errored: boolean; out: string }

/** Normalize the free-form half of an fsck line so a class is stable across runs:
 * object ids and the scratch repo's object paths are the only varying parts. */
function normalizeMessage(text: string): string {
	return text.replace(/\b[0-9a-f]{40}\b/g, "<oid>").replace(/\S*\/\S*/g, "<path>")
}

/**
 * Parse `git fsck --strict`'s report into a verdict. Every line is either
 * classified or fails the parse — an unrecognized line means git's report format
 * moved and the classification below went blind, which must never launder into a
 * "no error" verdict (the same discipline as the strict parsers in `git-fixtures`).
 */
function parseFsck(out: string): GitVerdict {
	const classes = new Set<string>()
	let errored = false
	for (const line of out.split("\n").filter((l) => l.length > 0)) {
		// Informational: unreachable objects (everything here is unreachable — the
		// scratch repo has no refs) and the matching "no refs" notice.
		if (/^dangling \w+ [0-9a-f]{40}$/.test(line)) continue
		if (line === "notice: No default references") continue
		if (line.startsWith("Checking ")) continue

		const attributed = /^(error|warning) in \w+ [0-9a-f]{40}: (.*)$/.exec(line)
		const bare = /^(error|warning): (.*)$/.exec(line)
		const match = attributed ?? bare
		if (!match) throw new Error(`unexpected git fsck line: ${line}`)
		const band = match[1] as string
		const rest = match[2] as string
		if (band !== "error") continue
		// An attributed line usually names its fsck message id (`hasDot: contains
		// '.'`); a few (`broken links`) carry only prose.
		const msgId = attributed ? /^([a-zA-Z]+): /.exec(rest)?.[1] : undefined
		classes.add(msgId ?? normalizeMessage(rest))
		errored = true
	}
	return { classes: [...classes].sort(), errored, out }
}

/** pggit's verdict on the same bytes: the `GitFormatError` code it rejects with,
 * or `null` when the object passes the whole ingest-boundary check. */
function pggitVerdict(type: GitObjectType, content: Buffer): string | null {
	try {
		validateObject(type, content)
		if (type === "commit") deriveCommitRow(content)
		if (type === "tag") deriveTagRow(content)
		return null
	} catch (e) {
		if (e instanceof GitFormatError) return e.code
		throw e
	}
}

type Prerequisite = { content: Buffer; type: GitObjectType }

/** `--literally` is what lets git store a malformed object at all. */
async function writeObject(
	dir: string,
	type: GitObjectType,
	content: Buffer,
): Promise<string> {
	const out = await spawnGit(
		["hash-object", "-w", "-t", type, "--literally", "--stdin"],
		{
			cwd: dir,
			input: content,
		},
	)
	return out.stdout.trim()
}

/** A repo holding exactly the canonical objects a candidate will reference (its
 * blob, its root tree, its parent commit), with the oids git assigned them. */
type Fixture = { dir: string; oids: string[] }

async function createFixture(prerequisites: Prerequisite[]): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "pggit-fsck-fixture-"))
	await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
	const oids: string[] = []
	for (const p of prerequisites) oids.push(await writeObject(dir, p.type, p.content))
	return { dir, oids }
}

/**
 * Canonical git's verdict on ONE candidate: a private copy of the fixture repo,
 * the candidate written into it, and `git fsck --strict` over the result. The copy
 * is what keeps every reported error about exactly one candidate — the fixture's
 * own objects are canonical, so nothing else in the repo can be faulty.
 */
async function gitVerdict(
	fixture: Fixture,
	type: GitObjectType,
	content: Buffer,
): Promise<GitVerdict> {
	const dir = mkdtempSync(join(tmpdir(), "pggit-fsck-parity-"))
	try {
		cpSync(fixture.dir, dir, { recursive: true })
		await writeObject(dir, type, content)
		const fsck = await spawnGit(["fsck", "--strict"], { cwd: dir }).catch(
			(e: unknown) => {
				if (e instanceof GitCommandError) return e
				throw e
			},
		)
		return parseFsck(`${fsck.stdout}${fsck.stderr}`)
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

/** The two recorded divergence directions, keyed by what each side says:
 * `underRejected` are git ERROR classes pggit knowingly does not check;
 * `overRejected` are pggit error codes raised on objects git does not error on. */
type Recorded = { overRejected: Set<string>; underRejected: Set<string> }

/** Per-property tallies: the two agreement directions plus the classes/codes each
 * DIVERGENT candidate realized (agreements do not count toward realization — a
 * recorded exception has to be justified by a candidate that actually used it). */
type Stats = {
	agreeAccept: number
	agreeReject: number
	overCodes: Map<string, number>
	underClasses: Map<string, number>
}

function newStats(): Stats {
	return {
		agreeAccept: 0,
		agreeReject: 0,
		overCodes: new Map(),
		underClasses: new Map(),
	}
}

function tally(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1)
}

/** The whole contract, applied to one candidate. */
function judge(
	git: GitVerdict,
	pggit: string | null,
	recorded: Recorded,
	stats: Stats,
	shown: string,
): void {
	if (git.errored && pggit !== null) {
		stats.agreeReject++
		return
	}
	if (!git.errored && pggit === null) {
		stats.agreeAccept++
		return
	}
	if (git.errored) {
		for (const c of git.classes) {
			tally(stats.underClasses, c)
			expect(
				recorded.underRejected.has(c),
				`git fsck --strict errors "${c}" but pggit ACCEPTED these bytes — an unrecorded divergence.\n${git.out}\nobject: ${shown}`,
			).toBe(true)
		}
		return
	}
	tally(stats.overCodes, pggit as string)
	expect(
		recorded.overRejected.has(pggit as string),
		`pggit rejected with "${pggit}" but git fsck --strict reported no error on these bytes — an unrecorded divergence.\n${git.out}\nobject: ${shown}`,
	).toBe(true)
}

/** Both agreement directions and every recorded exception must be realized by the
 * pinned corpus, or the agreement above proves nothing. */
function expectCorpusCovers(label: string, stats: Stats, recorded: Recorded): void {
	const render = (counts: Map<string, number>): string =>
		[...counts.entries()]
			.sort()
			.map(([c, n]) => `${c}=${n}`)
			.join(" ")
	console.log(
		`[${label}] agree(accept)=${stats.agreeAccept} agree(reject)=${stats.agreeReject}\n` +
			`[${label}] git errors, pggit accepts: ${render(stats.underClasses)}\n` +
			`[${label}] pggit rejects, git does not: ${render(stats.overCodes)}`,
	)
	expect(stats.agreeAccept, "no candidate was accepted by both").toBeGreaterThan(0)
	expect(stats.agreeReject, "no candidate was rejected by both").toBeGreaterThan(0)
	for (const c of recorded.underRejected) {
		expect(stats.underClasses.has(c), `recorded git class "${c}" never diverged`).toBe(
			true,
		)
	}
	for (const c of recorded.overRejected) {
		expect(stats.overCodes.has(c), `recorded pggit code "${c}" never diverged`).toBe(true)
	}
}

const BLOB = Buffer.from("hello\n")
const EMPTY_TREE = Buffer.alloc(0)
const IDENT = "pggit oracle <oracle@pggit.test> 1700000000 +0000"

// ---------------------------------------------------------------- trees

/** Modes: git's canonical set, the two zero-padded spellings its own writers never
 * emit, and one outright bogus mode. Names as RAW BYTES — a NUL and a non-UTF-8
 * name cannot survive a JS string round-trip, and both are exactly the cases that
 * matter. Each pool is weighted so the corpus reaches clean trees too. */
const CANONICAL_MODES = ["100644", "100755", "120000", "160000", "40000"] as const
const NONCANONICAL_MODES = ["040000", "0100644", "777"] as const

const TREE_NAMES = {
	alpha: Buffer.from("alpha"),
	beta: Buffer.from("beta"),
	dot: Buffer.from("."),
	dotdot: Buffer.from(".."),
	dotgit: Buffer.from(".git"),
	empty: Buffer.alloc(0),
	gamma: Buffer.from("gamma"),
	nonUtf8: Buffer.from([0xff, 0xfe]),
	nul: Buffer.concat([Buffer.from("wi"), NUL, Buffer.from("th")]),
	slash: Buffer.from("a/b"),
} as const

type TreeName = keyof typeof TREE_NAMES
const ORDINARY_NAMES = ["alpha", "beta", "gamma"] as const satisfies readonly TreeName[]
const HOSTILE_NAMES = [
	"empty",
	"dot",
	"dotdot",
	"dotgit",
	"slash",
	"nul",
	"nonUtf8",
] as const satisfies readonly TreeName[]

type TreeEntrySpec = { mode: string; name: TreeName }
type TreeSpec = {
	duplicateFirst: boolean
	entries: TreeEntrySpec[]
	order: "canonical" | "reversed"
}

const treeArb: fc.Arbitrary<TreeSpec> = fc.record({
	duplicateFirst: fc.oneof(
		{ arbitrary: fc.constant(false), weight: 3 },
		{ arbitrary: fc.constant(true), weight: 1 },
	),
	entries: fc.array(
		fc.record({
			mode: fc.oneof(
				{ arbitrary: fc.constantFrom(...CANONICAL_MODES), weight: 3 },
				{ arbitrary: fc.constantFrom(...NONCANONICAL_MODES), weight: 2 },
			),
			name: fc.oneof(
				{ arbitrary: fc.constantFrom(...ORDINARY_NAMES), weight: 3 },
				{ arbitrary: fc.constantFrom(...HOSTILE_NAMES), weight: 2 },
			),
		}),
		{ maxLength: 3, minLength: 1 },
	),
	// Entry ORDER is always imposed, never left to the draw: a "reversed" tree of
	// two or more distinct names is guaranteed to be out of canonical order, so the
	// `treeNotSorted` shape is reached deterministically instead of by accident.
	order: fc.oneof(
		{ arbitrary: fc.constant<"canonical">("canonical"), weight: 2 },
		{ arbitrary: fc.constant<"reversed">("reversed"), weight: 1 },
	),
})

function treeBytes(spec: TreeSpec, blobOid: string, treeOid: string): Buffer {
	const entries = spec.duplicateFirst
		? [...spec.entries, spec.entries[0] as TreeEntrySpec]
		: spec.entries
	const rendered = entries.map((e) => {
		const isDir = e.mode === "40000" || e.mode === "040000"
		const name = TREE_NAMES[e.name]
		return {
			// git's canonical order compares a subtree's name as if it ended in "/".
			key: isDir ? Buffer.concat([name, Buffer.from("/")]) : name,
			mode: e.mode,
			name,
			oid: isDir ? treeOid : blobOid,
		}
	})
	const direction = spec.order === "canonical" ? 1 : -1
	rendered.sort((a, b) => direction * Buffer.compare(a.key, b.key))
	return Buffer.concat(
		rendered.map((e) =>
			Buffer.concat([
				Buffer.from(`${e.mode} `, "latin1"),
				e.name,
				NUL,
				Buffer.from(e.oid, "hex"),
			]),
		),
	)
}

// ---------------------------------------------------------------- commits

type CommitSpec = {
	authors: number
	committers: number
	ident: "badDate" | "noEmail" | "ok"
	parents: ("absent" | "notHex" | "present")[]
	trees: number
}

/** `constantFrom` with repeats is the weighting: the valid count is the common
 * case, so the corpus reaches clean commits as well as malformed ones. */
const headerCountArb = fc.constantFrom(1, 1, 1, 0, 2)

const commitArb: fc.Arbitrary<CommitSpec> = fc.record({
	// `author` is the header pggit never reads, so its malformed counts are the ones
	// that produce divergences — weighted up so the corpus realizes them.
	authors: fc.constantFrom(1, 1, 0, 0, 2, 2),
	committers: headerCountArb,
	ident: fc.constantFrom("ok", "ok", "ok", "badDate", "noEmail"),
	parents: fc.array(fc.constantFrom("present", "present", "absent", "notHex"), {
		maxLength: 2,
	}),
	trees: headerCountArb,
})

const IDENTS = {
	badDate: "pggit oracle <oracle@pggit.test> notanumber +0000",
	noEmail: "pggit oracle 1700000000 +0000",
	ok: IDENT,
} as const

function commitBytes(spec: CommitSpec, treeOid: string, parentOid: string): Buffer {
	const lines: string[] = []
	for (let i = 0; i < spec.trees; i++) lines.push(`tree ${treeOid}`)
	for (const p of spec.parents) {
		if (p === "present") lines.push(`parent ${parentOid}`)
		else if (p === "absent") lines.push(`parent ${"1".repeat(40)}`)
		else lines.push("parent not-an-object-id")
	}
	for (let i = 0; i < spec.authors; i++) lines.push(`author ${IDENT}`)
	for (let i = 0; i < spec.committers; i++) lines.push(`committer ${IDENTS[spec.ident]}`)
	return Buffer.from(`${lines.join("\n")}\n\nmessage\n`, "latin1")
}

// ---------------------------------------------------------------- tags

type TagSpec = {
	objects: number
	taggers: number
	tags: number
	typeValue: "bogus" | "matching"
	types: number
}

const tagArb: fc.Arbitrary<TagSpec> = fc.record({
	objects: headerCountArb,
	taggers: fc.constantFrom(1, 1, 1, 0),
	tags: headerCountArb,
	types: headerCountArb,
	typeValue: fc.constantFrom("matching", "matching", "matching", "bogus"),
})

function tagBytes(spec: TagSpec, targetOid: string): Buffer {
	const lines: string[] = []
	for (let i = 0; i < spec.objects; i++) lines.push(`object ${targetOid}`)
	for (let i = 0; i < spec.types; i++) {
		lines.push(`type ${spec.typeValue === "matching" ? "blob" : "bogus"}`)
	}
	for (let i = 0; i < spec.tags; i++) lines.push(`tag v${i + 1}`)
	for (let i = 0; i < spec.taggers; i++) lines.push(`tagger ${IDENT}`)
	return Buffer.from(`${lines.join("\n")}\n\ntag message\n`, "latin1")
}

// ---------------------------------------------------------------- properties

describe("§8.4 generative — ingest validation vs `git fsck --strict`", () => {
	it("agrees on trees, diverging only where pggit's derived state demands it", async () => {
		// MEASURED on git 2.55. git errors, pggit accepts: every one is a tree whose
		// entries are individually well-formed, so pggit stores it faithfully and the
		// PROJECTION is what suffers — the recorded ledger row "malformed tree names
		// and duplicates silently collapse in the projection".
		const underRejected = new Set([
			"badTree",
			"broken links",
			"duplicateEntries",
			"empty filename in tree entry",
			"fullPathname",
			"hasDot",
			"hasDotdot",
			"hasDotgit",
			"treeNotSorted",
		])
		// git does not error, pggit rejects. Both are deliberate: the mode whitelist
		// because the walks type entries by RAW mode (git only WARNS on a bad mode,
		// and `--strict` does not promote that one), D16 because the `repo_file`
		// projection is `text` and a lossy decode collapses two byte-distinct names.
		const overRejected = new Set(["malformed-tree-mode", "non-utf8-path"])
		const recorded = { overRejected, underRejected }
		const stats = newStats()
		const fixture = await createFixture([
			{ content: BLOB, type: "blob" },
			{ content: EMPTY_TREE, type: "tree" },
		])
		const [blobOid, treeOid] = fixture.oids as [string, string]

		try {
			await fc.assert(
				fc.asyncProperty(treeArb, async (spec) => {
					const content = treeBytes(spec, blobOid, treeOid)
					const git = await gitVerdict(fixture, "tree", content)
					judge(
						git,
						pggitVerdict("tree", content),
						recorded,
						stats,
						content.toString("hex"),
					)
				}),
				PINNED,
			)
		} finally {
			rmSync(fixture.dir, { force: true, recursive: true })
		}
		expectCorpusCovers("fsck-parity tree", stats, recorded)
	}, 300_000)

	it("agrees on commits, diverging only on headers pggit does not derive from", async () => {
		// MEASURED: git errors on identity headers pggit never reads. pggit derives
		// tree/parents/committer-time only, so an authorless or email-less commit is
		// structurally broken to git and harmless to the derived rows.
		const underRejected = new Set(["missingAuthor", "missingEmail", "multipleAuthors"])
		const recorded = { overRejected: new Set<string>(), underRejected }
		const stats = newStats()
		const parent = Buffer.from(
			`tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor ${IDENT}\ncommitter ${IDENT}\n\nparent\n`,
			"latin1",
		)

		const fixture = await createFixture([
			{ content: EMPTY_TREE, type: "tree" },
			{ content: parent, type: "commit" },
		])
		const [treeOid, parentOid] = fixture.oids as [string, string]

		try {
			await fc.assert(
				fc.asyncProperty(commitArb, async (spec) => {
					const content = commitBytes(spec, treeOid, parentOid)
					const git = await gitVerdict(fixture, "commit", content)
					judge(
						git,
						pggitVerdict("commit", content),
						recorded,
						stats,
						content.toString("latin1"),
					)
				}),
				PINNED,
			)
		} finally {
			rmSync(fixture.dir, { force: true, recursive: true })
		}
		expectCorpusCovers("fsck-parity commit", stats, recorded)
	}, 300_000)

	it("agrees on annotated tags, diverging only on headers pggit does not derive from", async () => {
		// MEASURED: git's tag parser refuses the whole object with one generic
		// message whatever the structural fault is, so this single class covers every
		// tag pggit accepts and git does not. Because it is that coarse, the property
		// ALSO asserts (below) that a divergent tag still carries exactly the headers
		// pggit claims to check — otherwise a regression that stopped checking them
		// would hide inside this class.
		const underRejected = new Set(["<oid>: object could not be parsed: <path>"])
		const recorded = { overRejected: new Set<string>(), underRejected }
		const stats = newStats()

		const fixture = await createFixture([{ content: BLOB, type: "blob" }])
		const [blobOid] = fixture.oids as [string]

		try {
			await fc.assert(
				fc.asyncProperty(tagArb, async (spec) => {
					const content = tagBytes(spec, blobOid)
					const git = await gitVerdict(fixture, "tag", content)
					const pggit = pggitVerdict("tag", content)
					if (git.errored && pggit === null) {
						const shape = `objects=${spec.objects} types=${spec.types}`
						expect(spec.objects, `pggit accepted a tag git refused, ${shape}`).toBe(1)
						expect(
							spec.types,
							`pggit accepted a tag git refused, ${shape}`,
						).toBeGreaterThan(0)
					}
					judge(git, pggit, recorded, stats, content.toString("latin1"))
				}),
				PINNED,
			)
		} finally {
			rmSync(fixture.dir, { force: true, recursive: true })
		}
		expectCorpusCovers("fsck-parity tag", stats, recorded)
	}, 300_000)
})

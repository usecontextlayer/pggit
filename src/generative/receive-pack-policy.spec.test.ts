/**
 * §8.4 generative kernel differential — RECEIVE-PACK POLICY against canonical git.
 *
 * fast-check draws a BATCH of push commands (1-5, `--atomic` on or off) over an
 * identically-seeded pair of remotes: a plain `file://` BARE REPO driven by real
 * `git receive-pack`, and pggit over HTTP. The SAME `git push --porcelain` argv runs
 * against both, and the property compares what the client was told per destination
 * ref plus the ref set each remote is left holding.
 *
 * The batch draws from: create, fast-forward, forced non-fast-forward, delete of an
 * existing ref, delete of an absent ref, a blob/tree/tag-object tip under
 * `refs/heads/` (git rejects) and under `refs/tags/` (git accepts), a funny refname,
 * and a directory/file conflict against an existing ref.
 *
 * TWO DELIBERATE DIVERGENCES, modelled rather than compared (design: "refs only
 * advance", `docs/2026-08-17-derived-state-spine-design.md`; the policy itself is on
 * `handleReceivePack`): pggit denies EVERY deletion and every non-fast-forward
 * update, where canonical git applies both. For those two command kinds the property
 * requires (a) the control ACCEPTED it — so the divergence is a live difference and
 * not a shared refusal that would make the model vacuous — and (b) pggit `ng`'d it
 * with the documented reason class. Everything else must match canonical git exactly.
 *
 * WHAT THE ATOMIC HALF COMPARES, AND WHY IT IS NARROWER: with `--atomic` the
 * contract is all-or-nothing, and that is what is compared — every ref ok, or every
 * ref rejected with the ref set untouched. The per-ref REASONS are not compared under
 * a failed atomic batch because canonical git stops at its FIRST failure and
 * attributes "atomic push failure" to every later command, even one that is
 * independently invalid, while pggit evaluates all commands and reports each real
 * reason. That is an artifact of git's single-transaction implementation order (a
 * per-command check fires before a lock-time D/F check regardless of command order),
 * not a wire contract. Non-atomic batches get the full per-ref reason comparison.
 *
 * WHAT THE CLIENT REFUSES BEFORE THE WIRE: `git push` parses a destination refname
 * with `check_refname_format(..., ALLOW_ONELEVEL)` and dies `fatal: invalid refspec`
 * without contacting either remote, so `..`, `.lock`, control bytes, `@{`, `\`,
 * space, a trailing `/` and friends CANNOT reach a server through a real client. The
 * generator still draws them (`clientRefused`) and the property pins the observable
 * that remains: both remotes fail identically and NEITHER moves a ref. The names that
 * do reach a server are the one-level ones (`refs/heads`, `refs/tags`, `refs/x`) —
 * accepted by the client, rejected by receive-pack as `funny refname`. The predicate
 * itself is exhaustively fuzzed against `git check-ref-format` in `refname.spec`.
 *
 * SPEC-SUITE (executable spec, on the default gate — `pnpm run check`, pinned seed).
 * A failure is a real receive-pack policy divergence, not a test to weaken.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { type GitServer, serveOnPort } from "@/server"
import { createObjectStore } from "@/store/object-store"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

/** Max commands per batch. Also the size of the seeded `pre<i>` / `dfbase<i>` pools:
 * a command's destination is keyed by its POSITION in the batch, so two commands can
 * never collide on one ref and every D/F conflict in the corpus is deliberate. */
const MAX_BATCH = 5

/** Ref names one-level below `refs/`: `check_refname_format` with ALLOW_ONELEVEL (the
 * client's rule) accepts them, receive-pack without it (the server's rule) does not —
 * the only funny names a real `git push` will actually transmit. */
const FUNNY_TRANSMITTED = ["refs/heads", "refs/tags", "refs/one", "refs/zz"] as const

/** Names `git push` refuses to even parse: `..`, a `.lock` component, a leading dot,
 * space, backslash, `@{`, control byte, empty component, trailing `/` or `.`, and the
 * `~^?*[` punctuation set. */
const FUNNY_CLIENT_REFUSED = [
	"refs/heads/a..b",
	"refs/heads/x.lock",
	"refs/heads/.hidden",
	"refs/heads/a b",
	"refs/heads/a\\b",
	"refs/heads/a@{b",
	"refs/heads/a\u0001b",
	"refs/heads//empty",
	"refs/heads/trailing/",
	"refs/heads/trailing.",
	"refs/heads/a~b",
	"refs/heads/a^b",
	"refs/heads/a?b",
	"refs/heads/a*b",
	"refs/heads/a[b",
] as const

type Draw =
	| { k: "create" }
	| { k: "fastForward" }
	| { k: "forceNonFF" }
	| { k: "deleteExisting" }
	| { k: "deleteMissing" }
	| { k: "typedTip"; obj: "blob" | "tag" | "tree"; ns: "heads" | "tags" }
	| { k: "funnyTransmitted"; name: string }
	| { k: "clientRefused"; name: string }
	| { k: "dfExisting" }

type Kind = Draw["k"]

/** The two command kinds pggit denies as policy where canonical git applies them. */
const DIVERGENT: Record<Kind, string | null> = {
	clientRefused: null,
	create: null,
	deleteExisting: "deletion-denied",
	deleteMissing: "deletion-denied",
	dfExisting: null,
	fastForward: null,
	forceNonFF: "non-ff",
	funnyTransmitted: null,
	typedTip: null,
}

/** NOTE for anyone editing this arbitrary: an `fc.record`'s KEY ORDER decides the
 * order its sub-arbitraries consume the seeded RNG, so reordering keys reshuffles the
 * pinned corpus (the census below moves, the run count does not). Biome sorts object
 * keys, so leave them alphabetical — a hand-written non-alphabetical order silently
 * becomes a different corpus at the next `format.fix`. */
const drawArb: fc.Arbitrary<Draw> = fc.oneof(
	{ arbitrary: fc.constant<Draw>({ k: "create" }), weight: 3 },
	{ arbitrary: fc.constant<Draw>({ k: "fastForward" }), weight: 3 },
	{ arbitrary: fc.constant<Draw>({ k: "forceNonFF" }), weight: 3 },
	{ arbitrary: fc.constant<Draw>({ k: "deleteExisting" }), weight: 2 },
	{ arbitrary: fc.constant<Draw>({ k: "deleteMissing" }), weight: 2 },
	{
		arbitrary: fc.record({
			k: fc.constant<"typedTip">("typedTip"),
			ns: fc.constantFrom<"heads" | "tags">("heads", "tags"),
			obj: fc.constantFrom<"blob" | "tag" | "tree">("blob", "tree", "tag"),
		}),
		weight: 3,
	},
	{
		arbitrary: fc.record({
			k: fc.constant<"funnyTransmitted">("funnyTransmitted"),
			name: fc.constantFrom(...FUNNY_TRANSMITTED),
		}),
		weight: 2,
	},
	{
		arbitrary: fc.record({
			k: fc.constant<"clientRefused">("clientRefused"),
			name: fc.constantFrom(...FUNNY_CLIENT_REFUSED),
		}),
		weight: 1,
	},
	{ arbitrary: fc.constant<Draw>({ k: "dfExisting" }), weight: 2 },
)

const batchArb = fc.record({
	atomic: fc.boolean(),
	draws: fc.array(drawArb, { maxLength: MAX_BATCH, minLength: 1 }),
})

/** The oids the batch pushes. `c` fast-forwards `b`; `x` diverges from it. */
type Fixture = {
	dir: string
	b: string
	c: string
	x: string
	blob: string
	tree: string
	tag: string
}

/** One materialized push command: exactly the argv token, its destination ref, the
 * value that lands if the command is applied (null = a deletion), and the corpus keys
 * this command realizes (a `typedTip` proves nothing about the branch-tip rule unless
 * the corpus reached BOTH namespaces with all three object types). */
type Command = {
	census: string[]
	dest: string
	kind: Kind
	newOid: string | null
	refspec: string
}

function materialize(draw: Draw, i: number, fx: Fixture): Command {
	switch (draw.k) {
		case "create":
			return {
				census: [draw.k],
				dest: `refs/heads/created${i}`,
				kind: draw.k,
				newOid: fx.c,
				refspec: `${fx.c}:refs/heads/created${i}`,
			}
		case "fastForward":
			return {
				census: [draw.k],
				dest: `refs/heads/pre${i}`,
				kind: draw.k,
				newOid: fx.c,
				refspec: `${fx.c}:refs/heads/pre${i}`,
			}
		case "forceNonFF":
			return {
				census: [draw.k],
				dest: `refs/heads/pre${i}`,
				kind: draw.k,
				newOid: fx.x,
				// `+` — without it the CLIENT refuses locally and the server never judges.
				refspec: `+${fx.x}:refs/heads/pre${i}`,
			}
		case "deleteExisting":
			return {
				census: [draw.k],
				dest: `refs/heads/pre${i}`,
				kind: draw.k,
				newOid: null,
				refspec: `:refs/heads/pre${i}`,
			}
		case "deleteMissing":
			return {
				census: [draw.k],
				dest: `refs/heads/ghost${i}`,
				kind: draw.k,
				newOid: null,
				refspec: `:refs/heads/ghost${i}`,
			}
		case "typedTip": {
			const oid = draw.obj === "blob" ? fx.blob : draw.obj === "tree" ? fx.tree : fx.tag
			return {
				census: [`typedTip:${draw.ns}`, `tipObject:${draw.obj}`],
				dest: `refs/${draw.ns}/typed${i}`,
				kind: draw.k,
				newOid: oid,
				refspec: `${oid}:refs/${draw.ns}/typed${i}`,
			}
		}
		case "funnyTransmitted":
		case "clientRefused":
			return {
				census: [draw.k],
				dest: draw.name,
				kind: draw.k,
				newOid: fx.c,
				refspec: `${fx.c}:${draw.name}`,
			}
		case "dfExisting":
			return {
				census: [draw.k],
				dest: `refs/heads/dfbase${i}/sub`,
				kind: draw.k,
				newOid: fx.c,
				refspec: `${fx.c}:refs/heads/dfbase${i}/sub`,
			}
	}
}

/** `git push --porcelain` per-ref verdict, reduced to what is contractual. */
type Verdict = { klass: string; ok: boolean }

/**
 * The rejection REASON, as a class. The two remotes word the same policy differently
 * ("refname conflict" vs "funny refname (directory/file conflict)"), so the wording is
 * normalized and only the class is compared. An unrecognized reason becomes its own
 * class, so a new refusal reason fails the differential instead of collapsing into a
 * neighbour.
 */
function reasonClass(summary: string): string {
	// D/F first: pggit words it as a funny-refname SUBCASE, so the generic funny test
	// below would otherwise swallow it.
	if (/directory\/file conflict|refname conflict|cannot lock ref/.test(summary)) {
		return "df-conflict"
	}
	if (/non-fast-forward/.test(summary)) return "non-ff"
	if (/deletion denied/.test(summary)) return "deletion-denied"
	if (/invalid new value/.test(summary)) return "invalid-new-value"
	if (/funny refname/.test(summary)) return "funny-refname"
	if (/missing necessary objects/.test(summary)) return "missing-objects"
	if (/atomic/.test(summary)) return "atomic"
	if (/stale info|fetch first/.test(summary)) return "stale"
	return `unclassified(${summary})`
}

const PORCELAIN_FLAGS = new Set([" ", "+", "-", "*", "=", "!"])

/**
 * Parse the `--porcelain` status table: `<flag>\t<from>:<to>\t<summary>`, bracketed by
 * a `To <url>` header and a `Done` trailer. Keyed by DESTINATION ref — the line order
 * is the client's ref-list order, not the order the commands were sent.
 */
function parsePorcelain(stdout: string): Map<string, Verdict> {
	const verdicts = new Map<string, Verdict>()
	for (const line of stdout.split("\n")) {
		if (!line.includes("\t")) continue
		const parts = line.split("\t")
		if (parts.length !== 3) {
			throw new Error(`unexpected porcelain line: ${JSON.stringify(line)}`)
		}
		const [flag, refspec, summary] = parts as [string, string, string]
		if (!PORCELAIN_FLAGS.has(flag)) {
			throw new Error(`unexpected porcelain flag in ${JSON.stringify(line)}`)
		}
		const colon = refspec.indexOf(":")
		const dest = colon < 0 ? "" : refspec.slice(colon + 1)
		if (dest === "") throw new Error(`unexpected porcelain refspec: ${refspec}`)
		verdicts.set(dest, {
			klass: flag === "!" ? reasonClass(summary) : "ok",
			ok: flag !== "!",
		})
	}
	return verdicts
}

type PushRun = { clientRefused: boolean; code: number; stderr: string; stdout: string }

/** Run the identical push argv against one remote. A non-zero exit is an OUTCOME here
 * (a rejected ref exits 1), so `GitCommandError` is unwrapped rather than thrown; any
 * other failure (git missing, killed by signal) still fails the property loudly. */
async function pushBatch(
	cwd: string,
	url: string,
	commands: Command[],
	atomic: boolean,
): Promise<PushRun> {
	const args = ["push", "--porcelain", ...(atomic ? ["--atomic"] : []), url]
	const run = await spawnGit([...args, ...commands.map((c) => c.refspec)], { cwd }).catch(
		(e) => {
			if (e instanceof GitCommandError) {
				return { code: e.code, stderr: e.stderr, stdout: e.stdout }
			}
			throw e
		},
	)
	return {
		clientRefused: /fatal: invalid refspec/.test(run.stderr),
		code: run.code,
		stderr: run.stderr,
		stdout: run.stdout,
	}
}

/** Every ref in a real repo (NOT just heads+tags — a server that wrongly created
 * `refs/one` must be visible), as sorted `<name> <oid>` lines. */
async function controlRefs(bare: string): Promise<string[]> {
	const out = await spawnGit(["for-each-ref", "--format=%(refname) %(objectname)"], {
		cwd: bare,
	})
	return out.stdout.trim().split("\n").filter(Boolean).sort()
}

async function pggitRefs(refs: RefStore, repoId: string): Promise<string[]> {
	return (await refs.listRefs(repoId)).map((r) => `${r.name} ${r.oid}`).sort()
}

/** The ref set a remote holds after applying exactly the commands flagged `ok`. */
function applyCommands(
	baseline: string[],
	commands: Command[],
	ok: (c: Command) => boolean,
): string[] {
	const state = new Map(
		baseline.map((line) => {
			const space = line.indexOf(" ")
			return [line.slice(0, space), line.slice(space + 1)] as const
		}),
	)
	for (const c of commands) {
		if (!ok(c)) continue
		if (c.newOid === null) state.delete(c.dest)
		else state.set(c.dest, c.newOid)
	}
	return [...state].map(([name, oid]) => `${name} ${oid}`).sort()
}

describe("§8.4 generative — receive-pack policy vs canonical git", () => {
	let db: IsolatedDb
	let refs: RefStore
	let server: GitServer
	let fx: Fixture

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		refs = createRefStore(db.sql)
		server = await serveOnPort(
			createGitApp({ objects: createObjectStore(db.sql), refs }),
			0,
		)
		const dir = mkdtempSync(join(tmpdir(), "pggit-rppolicy-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
		const commit = async (content: string, message: string): Promise<string> => {
			writeFileSync(join(dir, "a.txt"), content)
			await spawnGit(["add", "a.txt"], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", message], { cwd: dir })
			return (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
		}
		const a = await commit("A\n", "A")
		const b = await commit("B\n", "B")
		const c = await commit("C\n", "C")
		// A sibling off A: not an ancestor of B, so `+x:<ref at b>` is a real
		// non-fast-forward that canonical git force-applies and pggit must deny.
		await spawnGit(["checkout", "-q", a], { cwd: dir })
		const x = await commit("X\n", "X")
		await spawnGit(["checkout", "-q", "main"], { cwd: dir })
		await spawnGit(["tag", "-a", "-m", "annotated", "atag", b], { cwd: dir })
		fx = {
			b,
			blob: (await spawnGit(["rev-parse", `${b}:a.txt`], { cwd: dir })).stdout.trim(),
			c,
			dir,
			tag: (await spawnGit(["rev-parse", "atag"], { cwd: dir })).stdout.trim(),
			tree: (await spawnGit(["rev-parse", `${b}^{tree}`], { cwd: dir })).stdout.trim(),
			x,
		}
	}, 180_000)

	afterAll(async () => {
		await server?.close()
		await db?.drop()
		if (fx?.dir) rmSync(fx.dir, { force: true, recursive: true })
	})

	/** `refs/heads/pre<i>` (the fast-forward / force / delete targets) and
	 * `refs/heads/dfbase<i>` (the D/F conflict's existing side), all at `b`. */
	function seedRefspecs(): string[] {
		return Array.from({ length: MAX_BATCH }, (_, i) => [
			`${fx.b}:refs/heads/pre${i}`,
			`${fx.b}:refs/heads/dfbase${i}`,
		]).flat()
	}

	it("matches canonical git per ref, modulo the deny-delete + deny-non-FF policy", async () => {
		let run = 0
		const census = new Map<string, number>()
		const bump = (key: string): void => {
			census.set(key, (census.get(key) ?? 0) + 1)
		}

		await fc.assert(
			fc.asyncProperty(batchArb, async ({ atomic, draws }) => {
				// One destination per command position, so a repeated funny name (the only
				// pool shared across positions) cannot send two commands for one ref —
				// which git rejects client-side and would say nothing about the server.
				const seen = new Set<string>()
				const commands: Command[] = []
				for (const [i, draw] of draws.entries()) {
					const command = materialize(draw, i, fx)
					if (seen.has(command.dest)) continue
					seen.add(command.dest)
					commands.push(command)
				}

				const bare = mkdtempSync(join(tmpdir(), "pggit-rppolicy-ctl-"))
				const repoId = `policy/batch${run++}`
				try {
					await spawnGit(["init", "-q", "--bare", bare])
					const controlUrl = `file://${bare}`
					const pggitUrl = `http://127.0.0.1:${server.port}/${repoId}`

					// Identical seed on both remotes — the precondition the whole comparison
					// rests on, established rather than assumed.
					await spawnGit(["push", "-q", controlUrl, ...seedRefspecs()], { cwd: fx.dir })
					await spawnGit(["push", "-q", pggitUrl, ...seedRefspecs()], { cwd: fx.dir })
					const baseline = await controlRefs(bare)
					expect(await pggitRefs(refs, repoId), "seeded remotes disagree").toEqual(
						baseline,
					)

					const control = await pushBatch(fx.dir, controlUrl, commands, atomic)
					const pggit = await pushBatch(fx.dir, pggitUrl, commands, atomic)
					for (const c of commands) for (const key of c.census) bump(key)
					bump(atomic ? "atomic" : "non-atomic")

					const afterControl = await controlRefs(bare)
					const afterPggit = await pggitRefs(refs, repoId)

					if (control.clientRefused) {
						// The client dies at refspec-parse time: neither remote is contacted, so
						// the only observable is that both die identically and nothing moved.
						bump("client-refused-batch")
						expect(pggit.clientRefused, pggit.stderr).toBe(true)
						expect(pggit.code).toBe(control.code)
						expect(pggit.stderr).toBe(control.stderr)
						expect(afterControl).toEqual(baseline)
						expect(afterPggit).toEqual(baseline)
						return
					}

					const controlVerdicts = parsePorcelain(control.stdout)
					const pggitVerdicts = parsePorcelain(pggit.stdout)
					const label = (c: Command): string =>
						`${c.kind} ${c.dest} [${atomic ? "atomic" : "non-atomic"}]`

					if (atomic) {
						// The `--atomic` contract is all-or-nothing; the per-ref reasons under a
						// failed batch are git's transaction ORDER, not a contract (see header).
						const verdicts = commands.map((c) => {
							const v = controlVerdicts.get(c.dest)
							expect(v, `control reported nothing for ${label(c)}`).toBeDefined()
							return v as Verdict
						})
						const controlAllOk = verdicts.every((v) => v.ok)
						expect(
							controlAllOk || verdicts.every((v) => !v.ok),
							"canonical git applied an atomic batch PARTIALLY",
						).toBe(true)
						const pggitRejectsAll =
							!controlAllOk || commands.some((c) => DIVERGENT[c.kind] !== null)
						for (const c of commands) {
							const v = pggitVerdicts.get(c.dest)
							expect(v, `pggit reported nothing for ${label(c)}`).toBeDefined()
							expect(v?.ok, label(c)).toBe(!pggitRejectsAll)
							// pggit reports every rejected command's OWN reason (git only reports
							// the first failure's), so the documented policy denial is still pinned
							// per ref here — that half is pggit's contract, not git's ordering.
							const denied = DIVERGENT[c.kind]
							if (denied !== null) expect(v?.klass, label(c)).toBe(denied)
						}
						expect(afterControl).toEqual(
							applyCommands(baseline, commands, () => controlAllOk),
						)
						expect(afterPggit).toEqual(
							applyCommands(baseline, commands, () => !pggitRejectsAll),
						)
						return
					}

					const expected = new Map<string, Verdict>()
					for (const c of commands) {
						const canonical = controlVerdicts.get(c.dest)
						expect(canonical, `control reported nothing for ${label(c)}`).toBeDefined()
						const denied = DIVERGENT[c.kind]
						if (denied === null) {
							expected.set(c.dest, canonical as Verdict)
							continue
						}
						// The divergence must be LIVE: canonical git applied this command. A
						// shared refusal would make the encoded policy vacuous.
						expect(canonical?.ok, `canonical git did not apply ${label(c)}`).toBe(true)
						expected.set(c.dest, { klass: denied, ok: false })
					}
					for (const c of commands) {
						expect(pggitVerdicts.get(c.dest), label(c)).toEqual(expected.get(c.dest))
					}
					expect(afterControl).toEqual(
						applyCommands(
							baseline,
							commands,
							(c) => controlVerdicts.get(c.dest)?.ok === true,
						),
					)
					expect(afterPggit).toEqual(
						applyCommands(baseline, commands, (c) => expected.get(c.dest)?.ok === true),
					)
				} finally {
					rmSync(bare, { force: true, recursive: true })
				}
			}),
			{ numRuns: 35, seed: 424_242 },
		)

		// Corpus floors: the agreement above is vacuous for any command kind the pinned
		// corpus never realized, and silently so.
		console.log(
			`[receive-pack policy corpus] ${[...census]
				.sort()
				.map(([k, n]) => `${k}=${n}`)
				.join(" ")}`,
		)
		for (const kind of [
			"atomic",
			"clientRefused",
			"create",
			"deleteExisting",
			"deleteMissing",
			"dfExisting",
			"fastForward",
			"forceNonFF",
			"funnyTransmitted",
			"non-atomic",
			"tipObject:blob",
			"tipObject:tag",
			"tipObject:tree",
			"typedTip:heads",
			"typedTip:tags",
		]) {
			expect(census.get(kind) ?? 0, `corpus never realized ${kind}`).toBeGreaterThan(0)
		}
	}, 600_000)

	/**
	 * OPEN DIVERGENCE (found by this differential, 2026-08-19 — NOT a sanctioned one).
	 *
	 * Two NEW directory/file-conflicting refs in ONE batch: canonical git keeps the
	 * DEEPEST name and `ng`s every shorter one, independent of the order the client
	 * sent them (measured on git 2.55 for `[a, a/b]`, `[a/b, a]`, and
	 * `[a, a/b, a/b/c]` — the deepest survived in all three). pggit's D/F pass walks
	 * commands in wire order and lets the FIRST eligible one occupy the name, so it
	 * keeps the SHORTER name for `[a, a/b]` — the opposite ref lands, and the client
	 * is told the opposite two things. `handleReceivePack`'s comment claims this pass
	 * runs "in git's sequential lock order", so the intent is to match; the behaviour
	 * does not.
	 *
	 * The D/F case where the conflicting side ALREADY EXISTS is not affected and both
	 * sides agree — that one is fuzzed by the property above (`dfExisting`).
	 *
	 * This test pins BOTH observed behaviours so the divergence is measured rather
	 * than remembered. When pggit is changed to match canonical git, this test must
	 * be rewritten to assert agreement (and the `dfPairNew` shape folded into the
	 * generator above, where the position-keyed destinations currently keep it out).
	 */
	it("OPEN DIVERGENCE: two new D/F-conflicting refs in one batch — git keeps the deepest, pggit keeps the first", async () => {
		const bare = mkdtempSync(join(tmpdir(), "pggit-rppolicy-df-"))
		const repoId = "policy/df-pair"
		try {
			await spawnGit(["init", "-q", "--bare", bare])
			const controlUrl = `file://${bare}`
			const pggitUrl = `http://127.0.0.1:${server.port}/${repoId}`
			await spawnGit(["push", "-q", controlUrl, `${fx.b}:refs/heads/base`], {
				cwd: fx.dir,
			})
			await spawnGit(["push", "-q", pggitUrl, `${fx.b}:refs/heads/base`], { cwd: fx.dir })

			const pair = (name: string): Command => ({
				census: [],
				dest: name,
				kind: "create",
				newOid: fx.c,
				refspec: `${fx.c}:${name}`,
			})
			const commands = [pair("refs/heads/pair"), pair("refs/heads/pair/sub")]
			const control = await pushBatch(fx.dir, controlUrl, commands, false)
			const pggit = await pushBatch(fx.dir, pggitUrl, commands, false)
			const canonical = parsePorcelain(control.stdout)
			const observed = parsePorcelain(pggit.stdout)

			// Canonical git: the deeper name wins even though it was sent SECOND.
			expect(canonical.get("refs/heads/pair/sub")).toEqual({ klass: "ok", ok: true })
			expect(canonical.get("refs/heads/pair")).toEqual({
				klass: "df-conflict",
				ok: false,
			})
			expect(await controlRefs(bare)).toEqual(
				[`refs/heads/base ${fx.b}`, `refs/heads/pair/sub ${fx.c}`].sort(),
			)

			// pggit: the first command in wire order wins instead.
			expect(observed.get("refs/heads/pair")).toEqual({ klass: "ok", ok: true })
			expect(observed.get("refs/heads/pair/sub")).toEqual({
				klass: "df-conflict",
				ok: false,
			})
			expect(await pggitRefs(refs, repoId)).toEqual(
				[`refs/heads/base ${fx.b}`, `refs/heads/pair ${fx.c}`].sort(),
			)
		} finally {
			rmSync(bare, { force: true, recursive: true })
		}
	}, 180_000)
})

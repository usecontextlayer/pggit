import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { buildFileList } from "@/repo-view/build-file-list"
import { syncRefSnapshot } from "@/repo-view/rebuild"
import { createRepoFileProjection } from "@/repo-view/repo-file-projection"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { loadAllObjects, parseLsTree } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { GitCommandError, spawnGit } from "@/testing/spawn-git"

/**
 * Spine S3's differential gate: over ANY sequence of pushes, the diff-driven
 * projection is row-for-row identical to a from-scratch rebuild of the same tip
 * — `repo_file` under `applyRefAdvance` ≡ `buildFileList(tip)` — and
 * `repo_file_head` always names the tip it reflects. The mutation pool
 * deliberately covers the diff's edge classes: nested adds/removes, content
 * changes, mode flips, and file↔directory swaps at one path.
 */

const REF = "refs/heads/main"

type Op =
	| { kind: "set"; path: string; content: string }
	| { kind: "del"; path: string }
	| { kind: "chmod"; path: string }
	| { kind: "swap"; path: string }

const PATHS = [
	"a.txt",
	"b.txt",
	"dir/inner.txt",
	"dir/sub/deep.txt",
	"dir/sub/other.txt",
	"wide/one.txt",
	"wide/two.txt",
	"swapper",
]

const opArb: fc.Arbitrary<Op> = fc.oneof(
	fc
		.record({ content: fc.string({ maxLength: 12 }), path: fc.constantFrom(...PATHS) })
		.map((r) => ({ content: `${r.content}\n`, kind: "set" as const, path: r.path })),
	fc.constantFrom(...PATHS).map((path) => ({ kind: "del" as const, path })),
	fc.constantFrom(...PATHS).map((path) => ({ kind: "chmod" as const, path })),
	fc.constant({ kind: "swap" as const, path: "swapper" }),
)

describe("repo_file incremental ≡ full rebuild (spine S3 differential)", () => {
	let db: IsolatedDb
	let objects: ObjectStore

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
	}, 600_000)

	afterAll(async () => {
		await db?.drop()
	})

	/** repo_file rows for the branch, canonical text, sorted. */
	async function projectedRows(repo: string): Promise<string[]> {
		const rows = await db.sql<{ line: string }[]>`
			select f.path || ' ' || f.mode || ' ' || encode(f.blob_oid, 'hex') as line
			from repo_file f join repos r on r.id = f.repo_id
			where r.name = ${repo} and f.ref_name = ${REF}`
		return rows.map((r) => r.line).sort()
	}

	async function projectedHead(repo: string): Promise<string | null> {
		const [row] = await db.sql<{ oid: string }[]>`
			select encode(h.commit_oid, 'hex') as oid
			from repo_file_head h join repos r on r.id = h.repo_id
			where r.name = ${repo} and h.ref_name = ${REF}`
		return row?.oid ?? null
	}

	/** Canonical git's file rows at one revision, in the projection's text form. */
	async function gitFileRows(dir: string, rev: string): Promise<string[]> {
		return parseLsTree((await spawnGit(["ls-tree", "-r", rev], { cwd: dir })).stdout)
			.map((e) => `${e.path} ${e.mode} ${e.oid}`)
			.sort()
	}

	/** Apply ops in a workdir; commit; return the new tip (null if nothing changed). */
	async function applyAndCommit(
		dir: string,
		ops: Op[],
		n: number,
	): Promise<string | null> {
		for (const op of ops) {
			const full = join(dir, op.path)
			if (op.kind === "set") {
				rmSync(full, { force: true, recursive: true })
				mkdirSync(dirname(full), { recursive: true })
				writeFileSync(full, op.content)
			} else if (op.kind === "del") {
				rmSync(full, { force: true, recursive: true })
			} else if (op.kind === "chmod") {
				// The one PROVEN no-op: the generator can chmod a path that is not in the
				// index (never created, or already deleted), which git refuses with
				// `Unable to process path <p>`. Every other git failure — and every fs
				// failure above — fails the property, rather than silently erasing the
				// mode-flip dimension from every generated push.
				try {
					await spawnGit(["update-index", "--chmod=+x", op.path], { cwd: dir })
				} catch (e) {
					const knownNoop =
						e instanceof GitCommandError &&
						e.stderr.includes(`Unable to process path ${op.path}`)
					if (!knownNoop) throw e
				}
			} else {
				// file↔directory swap at one fixed path.
				rmSync(full, { force: true, recursive: true })
				mkdirSync(full, { recursive: true })
				writeFileSync(join(full, "nested.txt"), `swap-${n}\n`)
			}
		}
		await spawnGit(["add", "-A"], { cwd: dir })
		try {
			await spawnGit(["commit", "-q", "-m", `p${n}`], { cwd: dir })
		} catch (e) {
			// Only a PROVEN nothing-to-commit is a legitimate skip — a systemic
			// commit failure must fail the property, not silently drop every
			// generated transition.
			const status = await spawnGit(["status", "--porcelain"], { cwd: dir })
			const nothingToCommit =
				e instanceof GitCommandError &&
				(e.stdout + e.stderr).includes("nothing to commit") &&
				status.stdout.trim() === ""
			if (!nothingToCommit) throw e
			return null
		}
		return (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
	}

	/** Ingest the repo's objects and advance the projection to `tip`. */
	async function pushAndProject(repo: string, dir: string, tip: string): Promise<void> {
		await objects.putPack(repo, await loadAllObjects(dir))
		await syncRefSnapshot(
			{ objects, snapshots: createRepoFileProjection(db.sql) },
			repo,
			REF,
			tip,
		)
	}

	it("row-for-row identical to a from-scratch rebuild after every push", async () => {
		let run = 0
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(opArb, { maxLength: 4, minLength: 1 }), {
					maxLength: 6,
					minLength: 2,
				}),
				async (pushes) => {
					const repo = `diff/${run++}`
					const dir = mkdtempSync(join(tmpdir(), "pggit-projdiff-"))
					try {
						await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
						writeFileSync(join(dir, "seed.txt"), "seed\n")
						await spawnGit(["add", "-A"], { cwd: dir })
						await spawnGit(["commit", "-q", "-m", "seed"], { cwd: dir })
						let tip = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
						await pushAndProject(repo, dir, tip)
						// The seed projection is asserted too, so no candidate is ever
						// vacuous even when every generated push has nothing to commit.
						expect(await projectedRows(repo)).toEqual(await gitFileRows(dir, tip))
						expect(await projectedHead(repo)).toBe(tip)

						for (const [n, ops] of pushes.entries()) {
							const next = await applyAndCommit(dir, ops, n)
							if (next === null) continue
							tip = next
							await pushAndProject(repo, dir, tip)

							// The oracle: real git's own file list at the same tip. Anchoring the
							// row set to `git ls-tree -r` (rather than to a second pggit walk)
							// is what makes a decoder defect SHARED by both projection paths
							// visible here.
							const lsTree = await gitFileRows(dir, tip)
							const rows = await projectedRows(repo)
							expect(rows).toEqual(lsTree)

							// The secondary property this file is named for: the diff-driven
							// projection equals a from-scratch rebuild of the same tip.
							const read = async (oid: string) => {
								const obj = await objects.getObject(repo, oid)
								if (!obj) throw new Error(`missing ${oid}`)
								return obj
							}
							const full = (await buildFileList(read, tip)).files
								.map((f) => `${f.path} ${f.mode} ${f.blobOid}`)
								.sort()
							expect(rows).toEqual(full)
							expect(await projectedHead(repo)).toBe(tip)
						}
					} finally {
						rmSync(dir, { force: true, recursive: true })
					}
				},
			),
			// Pinned seed (424_242) for a deterministic gate, matching the sibling
			// specs — this property spawns real git and seeds Postgres per candidate,
			// so an unpinned failure is both nondeterministic and expensive to replay.
			{ numRuns: 6, seed: 424_242 },
		)
	}, 600_000)

	it("an older oid arriving late is SKIPPED — the projection never moves backwards", async () => {
		const repo = "diff/monotonic"
		const dir = mkdtempSync(join(tmpdir(), "pggit-projmono-"))
		try {
			await spawnGit(["init", "-q", "-b", "main"], { cwd: dir })
			writeFileSync(join(dir, "f.txt"), "one\n")
			await spawnGit(["add", "-A"], { cwd: dir })
			await spawnGit(["commit", "-q", "-m", "c1"], { cwd: dir })
			const older = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()
			writeFileSync(join(dir, "f.txt"), "two\n")
			await spawnGit(["commit", "-q", "-am", "c2"], { cwd: dir })
			const newer = (await spawnGit(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim()

			await pushAndProject(repo, dir, newer)
			const rowsAtNewer = await projectedRows(repo)

			// The stale worker's write arrives after the newer projection landed.
			const outcome = await createRepoFileProjection(db.sql).applyRefAdvance(
				repo,
				REF,
				older,
				{
					diffFrom: () => {
						throw new Error("must not diff: older oid is not a forward move")
					},
					fullList: () => {
						throw new Error("must not rebuild: rebuilding backwards is the race")
					},
				},
			)
			expect(outcome).toBe("skipped")
			expect(await projectedRows(repo)).toEqual(rowsAtNewer)
			expect(await projectedHead(repo)).toBe(newer)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

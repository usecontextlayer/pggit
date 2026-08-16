/**
 * FINDING — `createRepack(sql).repack(repo)` throws, permanently and
 * unrecoverably, on any repo whose phase-2 sweep gathers more than 65,534
 * objects into one read batch.
 *
 * Root cause (black-box visible in the exception): repack's phase-2 coverage
 * sweep batches ONLY by bytes —
 *
 *     for (const p of [...pendingByOid.values()]) {
 *       sweep.push(p); sweepBytes += p.size
 *       if (sweepBytes >= READ_BATCH_BYTES) await flushSweep()   // 16 MB
 *     }
 *
 * — and then reads that batch with `oid in ${pg(list)}`, porsager's value-list
 * expansion: ONE bind parameter per oid. The wire protocol caps a statement at
 * 65,534 parameters. So any repo whose objects average under ~244 bytes crosses
 * the ceiling before it crosses 16 MB. Every other batched read in this codebase
 * caps by COUNT (reachability LOOKUP_BATCH=1000, buildPack PACK_BATCH=1000, gc
 * LIVE_LOAD_BATCH=10000, repack's own WRITE_BATCH=1000); phase 2 is the outlier.
 *
 * Consequences, all git-observable:
 *  - The encoding tier is NEVER built for such a repo — every clone forever takes
 *    the undeltified raw path, i.e. exactly the production symptom this whole
 *    change exists to remove.
 *  - It does not self-heal: phase 2 throws BEFORE it emits anything, so retrying
 *    reproduces the identical failure with the identical pending set. Verified
 *    below by calling repack three times.
 *  - Wired into W1's `drainRepo`, this throws inside the background drain on the
 *    first pass over such a repo.
 *
 * Converted from `breakage/lifecycle--repack-bind-parameter-ceiling.ts` at full
 * scale — the 64,000-blob trial sits just UNDER the ceiling (the control) and the
 * 70,000-blob trial just over it (the reproduction); shrinking either destroys
 * the finding, because the bug lives exactly at that boundary. The source exits 1
 * when repack throws, so the assertion here states the correct outcome: repack
 * completes on both, three times over.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { serveOnPort } from "@/server"
import { createRepack } from "@/store/repack"
import { createIsolatedSchema } from "@/testing/pg"
import { PINNED_IDENTITY, spawnGit } from "@/testing/spawn-git"

const REPO = "workspace/slate/many-small-objects"
/** Matches `PINNED_DATE` (@1700000000 +0000) in fast-import's own `when` grammar. */
const WHEN = "1700000000 +0000"
const COMMITTER = `${PINNED_IDENTITY.name} <${PINNED_IDENTITY.email}> ${WHEN}`
/** Blob counts either side of the 65,534 bind-parameter ceiling. */
const TRIALS = [64_000, 70_000]
/** Repack calls per trial: a transient failure would converge, this one does not. */
const ATTEMPTS = 3

/** One commit laying down `n` tiny files across 256 subdirectories. */
function stream(n: number): string {
	const out: string[] = []
	const changes: string[] = []
	let mark = 0
	for (let i = 0; i < n; i++) {
		const m = ++mark
		const content = `f${i}\n`
		out.push(`blob\nmark :${m}\ndata ${content.length}\n${content}\n`)
		changes.push(`M 100644 :${m} d${i % 256}/f${i}.txt`)
	}
	out.push(
		`commit refs/heads/main\nmark :${++mark}\ncommitter ${COMMITTER}\ndata 4\nseed\n${changes.join("\n")}\n`,
	)
	return out.join("")
}

type Outcome = {
	blobs: number
	/** What the repo actually holds, measured with git, not with SQL. */
	objects: number
	bytes: number
	/** One entry per repack attempt: the thrown message, or null for success. */
	errors: (string | null)[]
}

describe("lifecycle breakage — repack bind-parameter ceiling", () => {
	let root = ""
	const outcomes: Outcome[] = []

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pggit-breakage-bindcap-"))
		const baseUrl = inject("pgBaseUrl")

		for (const blobs of TRIALS) {
			const src = join(root, `src-${blobs}`)
			await spawnGit(["init", "-q", "-b", "main", src])
			await spawnGit(["fast-import", "--quiet"], { cwd: src, input: stream(blobs) })

			const listing = (
				await spawnGit(["cat-file", "--batch-all-objects", "--batch-check"], { cwd: src })
			).stdout
				.trim()
				.split("\n")
				.filter(Boolean)
			// Raw bytes stay well under repack's 16 MB READ_BATCH_BYTES, so the whole
			// inventory lands in ONE phase-2 batch — which is the point.
			const bytes = listing.reduce((n, l) => n + Number(l.split(" ")[2] ?? 0), 0)

			const db = await createIsolatedSchema(baseUrl)
			const errors: (string | null)[] = []
			try {
				const server = await serveOnPort(createGitApp(createGitDeps(db.sql)), 0)
				const url = `http://127.0.0.1:${server.port}/${REPO}`
				await spawnGit(["push", "-q", url, "refs/heads/main:refs/heads/main"], {
					cwd: src,
				})
				const repack = createRepack(db.sql)
				for (let i = 0; i < ATTEMPTS; i++) {
					try {
						await repack.repack(REPO)
						errors.push(null)
					} catch (err) {
						errors.push((err as Error).message.slice(0, 120))
					}
				}
				await server.close()
			} finally {
				await db.drop()
				rmSync(src, { force: true, recursive: true })
			}
			outcomes.push({ blobs, bytes, errors, objects: listing.length })
		}
	}, 1_800_000)

	afterAll(() => {
		if (root) rmSync(root, { force: true, recursive: true })
	})

	it("repacks a repo whose one-batch inventory crosses the 65,534-oid ceiling", () => {
		expect(
			outcomes.flatMap((o) =>
				o.errors
					.map((err, attempt) =>
						err === null
							? null
							: `${o.objects} objects / ${o.bytes} raw bytes (${o.blobs} blobs), attempt ${attempt + 1}: ${err}`,
					)
					.filter((line): line is string => line !== null),
			),
		).toEqual([])
	})
})

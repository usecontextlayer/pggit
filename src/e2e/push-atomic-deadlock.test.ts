/**
 * a11 concurrency — two concurrent `--atomic` pushes that update the SAME two
 * refs in OPPOSITE order race for the per-ref row locks. Postgres detects the
 * lock cycle and aborts one transaction with a deadlock error (SQLSTATE 40P01).
 *
 * BUG: `applyRefUpdates` (atomic path) only catches its own `AtomicAbort`; a
 * Postgres deadlock re-throws, escapes `handleReceivePack`, and the app's
 * `onError` turns it into HTTP 500 "internal server error". Canonical git never
 * answers a push with a server error because of a lock conflict — the losing
 * push must get a clean in-band rejection (the atomic batch failed, every ref
 * `ng`), status 200, exactly like any other lost CAS. A deadlock is a
 * concurrency outcome the server must absorb and report, not leak as a 500.
 *
 * This drives the real wire (two concurrent git-receive-pack POSTs) and asserts
 * the observable contract: BOTH responses are HTTP 200 git-report-status bodies
 * (never a 500 / "internal server error"), exactly one batch commits whole, the
 * loser applies nothing, and the final ref state is one consistent batch.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createGitApp } from "@/index"
import { encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ZERO = "0".repeat(40)

/** Atomic receive-pack body: update r1 and r2 (caps incl. `atomic` on line 1). */
function atomicBody(
	r1: { old: string; new: string },
	r2: { old: string; new: string },
	pack: Buffer,
): Buffer {
	return Buffer.concat([
		encodePktLine(
			Buffer.from(`${r1.old} ${r1.new} refs/heads/r1\0report-status atomic\n`, "utf8"),
		),
		encodePktLine(Buffer.from(`${r2.old} ${r2.new} refs/heads/r2\n`, "utf8")),
		Buffer.from("0000"),
		pack,
	])
}

async function postReceivePack(
	app: ReturnType<typeof createGitApp>,
	repo: string,
	body: Buffer,
): Promise<{ status: number; text: string }> {
	const res = await app.request(`/${repo}/git-receive-pack`, {
		body: new Uint8Array(body),
		method: "POST",
	})
	return {
		status: res.status,
		text: Buffer.from(await res.arrayBuffer()).toString("utf8"),
	}
}

describe("a11 — concurrent atomic pushes that deadlock must not 500", () => {
	let db: IsolatedDb
	let app: ReturnType<typeof createGitApp>
	let src: string
	let base: string
	const tips = { a1: "", a2: "", b1: "", b2: "" }
	let packA: Buffer
	let packB: Buffer

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		const objects = createObjectStore(db.sql)
		const refs = createRefStore(db.sql)
		app = createGitApp({ objects, refs })

		// Build four divergent tips off a common base; pack {a1,a2} and {b1,b2}.
		src = mkdtempSync(join(tmpdir(), "a11-deadlock-src-"))
		await spawnGit(["init", "-q", "-b", "main"], { cwd: src })
		writeFileSync(join(src, "a.txt"), "base\n")
		await spawnGit(["add", "."], { cwd: src })
		await spawnGit(["commit", "-q", "-m", "base"], { cwd: src })
		base = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()

		for (const k of ["a1", "a2", "b1", "b2"] as const) {
			await spawnGit(["reset", "-q", "--hard", base], { cwd: src })
			writeFileSync(join(src, "a.txt"), `${k}\n`)
			await spawnGit(["add", "."], { cwd: src })
			await spawnGit(["commit", "-q", "-m", k], { cwd: src })
			tips[k] = (await spawnGit(["rev-parse", "HEAD"], { cwd: src })).stdout.trim()
		}
		packA = (
			await spawnGit(["pack-objects", "--stdout", "--revs"], {
				cwd: src,
				input: `${tips.a1}\n${tips.a2}\n`,
			})
		).stdoutBytes
		packB = (
			await spawnGit(["pack-objects", "--stdout", "--revs"], {
				cwd: src,
				input: `${tips.b1}\n${tips.b2}\n`,
			})
		).stdoutBytes
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("absorbs the deadlock: both responses are 200 report-status, never 500", async () => {
		// One repo per attempt; loop to make the lock cycle near-certain to fire.
		let saw500 = false
		let torn = ""
		for (let attempt = 0; attempt < 8; attempt++) {
			const repo = `dl${attempt}`
			// Seed r1=r2=base via a plain push so both updates are real CAS updates.
			await postReceivePack(
				app,
				repo,
				Buffer.concat([
					encodePktLine(
						Buffer.from(`${ZERO} ${base} refs/heads/r1\0report-status\n`, "utf8"),
					),
					Buffer.from("0000"),
					(
						await spawnGit(["pack-objects", "--stdout", "--revs"], {
							cwd: src,
							input: `${base}\n`,
						})
					).stdoutBytes,
				]),
			)
			await postReceivePack(
				app,
				repo,
				Buffer.concat([
					encodePktLine(
						Buffer.from(`${ZERO} ${base} refs/heads/r2\0report-status\n`, "utf8"),
					),
					Buffer.from("0000"),
					(
						await spawnGit(["pack-objects", "--stdout", "--revs"], {
							cwd: src,
							input: `${base}\n`,
						})
					).stdoutBytes,
				]),
			)

			// Batch A locks r1 then r2; batch B locks r2 then r1 — opposite order.
			const bodyA = atomicBody(
				{ new: tips.a1, old: base },
				{ new: tips.a2, old: base },
				packA,
			)
			const bodyB = Buffer.concat([
				encodePktLine(
					Buffer.from(`${base} ${tips.b2} refs/heads/r2\0report-status atomic\n`, "utf8"),
				),
				encodePktLine(Buffer.from(`${base} ${tips.b1} refs/heads/r1\n`, "utf8")),
				Buffer.from("0000"),
				packB,
			])

			const [resA, resB] = await Promise.all([
				postReceivePack(app, repo, bodyA),
				postReceivePack(app, repo, bodyB),
			])

			for (const r of [resA, resB]) {
				if (r.status === 500 || r.text.includes("internal server error")) saw500 = true
			}

			// State must reflect exactly one whole batch (or, if both serialized
			// cleanly, the later winner) — never a torn mix of a1+b2 etc.
			const refs = createRefStore(db.sql)
			const stored = Object.fromEntries(
				(await refs.listRefs(repo)).map((r) => [r.name, r.oid]),
			)
			const r1 = stored["refs/heads/r1"]
			const r2 = stored["refs/heads/r2"]
			const aWhole = r1 === tips.a1 && r2 === tips.a2
			const bWhole = r1 === tips.b1 && r2 === tips.b2
			if (!aWhole && !bWhole) torn = `attempt ${attempt}: r1=${r1} r2=${r2}`
		}

		// The atomicity invariant must hold regardless (rolled-back victim).
		expect(torn).toBe("")
		// The bug: a deadlock victim is reported as HTTP 500 instead of a clean
		// in-band atomic rejection. Canonical git never 500s on a lock conflict.
		expect(saw500).toBe(false)
	})
})

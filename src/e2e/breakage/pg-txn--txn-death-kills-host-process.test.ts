/**
 * BREAKAGE (pg-txn) — a backend death inside `pg.begin` kills the host process.
 * Converted from `breakage/pg-txn--txn-death-kills-host-process.ts`; its rationale
 * verbatim:
 *
 * FINDING: a Postgres backend that dies while ANY `pg.begin` transaction is open
 * kills the ENTIRE host process with an UNCATCHABLE TypeError — not a rejected
 * promise, not a 500, a hard exit.
 *
 *   TypeError: Cannot read properties of null (reading 'write')
 *     at Immediate.nextWrite (postgres/src/connection.js:255)
 *
 * `postgres@3.4.9` defers small wire writes with `setImmediate(nextWrite)` and
 * nulls `socket` when a connection closes. When a connection dies mid-transaction
 * the driver still queues the transaction's `ROLLBACK` — a sub-1KB write, hence
 * deferred — and by the time that `setImmediate` fires the socket is null.
 * Because it fires from a `setImmediate`, no `try/catch`, no `.catch()`, and no
 * `pg.begin` rollback handler can see it; only a global `uncaughtException`
 * handler, which pggit does not install.
 *
 * THIS IS EVERY WRITE PATH IN pggit. `pg.begin` is how `object-store.insertObjects`
 * (the object⟺derived-rows invariant), `gc.loadLive`, `repack.flush`, and
 * `repo-file-projection.applyRefAdvance` all commit. The controls below show
 * the scope precisely:
 *
 *   kill during a plain query (no transaction) ················ survives
 *   kill during `pg.begin` + `select pg_sleep` ················ PROCESS DIES
 *   kill during the COPY stream statement ····················· survives
 *   kill during the ingest's `insert into git_object …` ······· PROCESS DIES
 *
 * (The COPY-stream case survives only because the server answers it with a FATAL
 * 57P01 before the client notices the socket, so no client-side rollback is
 * queued — a timing accident, not a safe path.)
 *
 * Why it matters here: pggit is mounted INSIDE a host process (ContextLayer's
 * platform composition mounts `createGitApp`). A backend termination during any
 * push, GC pass, or repack — an Azure Postgres failover or maintenance restart
 * ("terminating connection due to administrator command"), an
 * `idle_session_timeout`, a connection-limit reap, an OOM-killed backend — takes
 * the host down, not just the request.
 *
 * FAULT INJECTED: `pg_terminate_backend` against ONLY the pid read from the
 * child's own connection (`select pg_backend_pid()` on a max:1 pool), fired when
 * `pg_stat_activity` shows that pid inside the targeted statement.
 *
 * The fault runs in a CHILD process with NO exception handler, so the evidence is
 * the child's exit status. That indirection is load-bearing and survives the
 * conversion: the crash fires from a `setImmediate`, so nothing in THIS process
 * (no try/catch, no vitest hook) could ever observe it as an assertion — only an
 * exit code can. The child program is emitted next to the harness under
 * `perf/breakage/` (outside `tsconfig.json`'s `include`, so a stray copy can never
 * break `tsc`) and removed in `afterAll`.
 *
 * The source script exited non-zero when a child died. The patched driver's live
 * contract is that a killed backend fails the request, never the host, so all four
 * modes below must remain green.
 */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createAppendOnlyRepo } from "@/testing/append-only-repo"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

const ITERS = 4
const RUNS = 900

/**
 * Where the kill lands. The child owns the `pg_stat_activity.query` needle each
 * mode watches for (`plain-query`/`txn-sleep` → "select pg_sleep", `copy-stream`
 * → "copy ", `object-insert` → "insert into git_object").
 */
const MODES = ["plain-query", "txn-sleep", "copy-stream", "object-insert"] as const

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/**
 * The child program: connect on a max:1 pool, read its OWN backend pid, terminate
 * that one pid the moment it enters the target statement, then exit cleanly. NO
 * `uncaughtException` handler — a non-zero exit IS the finding.
 */
const CHILD_SOURCE = `/** Emitted at runtime by src/e2e/breakage/pg-txn--txn-death-kills-host-process.test.ts. */
import { readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import postgres from "postgres"
import { z } from "zod"
import { createObjectStore } from "@/store/object-store"

const FAULT_POINTS = {
	"copy-stream": "copy ",
	"object-insert": "insert into git_object",
	"plain-query": "select pg_sleep",
	"txn-sleep": "select pg_sleep",
} as const

const env = z.object({
	BK_MODE: z.enum(["plain-query", "txn-sleep", "copy-stream", "object-insert"]),
	BK_PACK: z.string().min(1),
	BK_PG: z.string().min(1),
	BK_REPO: z.string().min(1),
	BK_SCHEMA: z.string().min(1),
}).parse(process.env)
const PG = env.BK_PG
const schema = env.BK_SCHEMA
const mode = env.BK_MODE
const packPath = env.BK_PACK
const repo = env.BK_REPO
const needle = FAULT_POINTS[mode]

const sql = postgres(PG, { connection: { search_path: schema }, max: 1, onnotice: () => {} })
const [p] = await sql\`select pg_backend_pid() as pid\`
const pid = p.pid
process.stdout.write("CHILD pid=" + pid + " mode=" + mode + "\\n")

const admin = postgres(PG, { connection: { search_path: schema }, max: 1, onnotice: () => {} })
// Watch ONLY our own pid; terminate it the moment it enters the target statement.
const killer = (async () => {
	const t0 = Date.now()
	while (Date.now() - t0 < 60000) {
		const [a] = await admin\`select query as q from pg_stat_activity where pid = \${pid}\`
		if (a && typeof a.q === "string" && a.q.toLowerCase().startsWith(needle)) {
			await admin\`select pg_terminate_backend(\${pid})\`
			process.stdout.write("CHILD killed own backend at " + (Date.now() - t0) + "ms\\n")
			return
		}
		await sleep(2)
	}
	process.stdout.write("CHILD never saw the fault point\\n")
})()

let caught = "none"
try {
	if (mode === "plain-query") {
		await sql\`select pg_sleep(4)\`
	} else if (mode === "txn-sleep") {
		// CONTROL: a pg.begin transaction with NO copy at all.
		await sql.begin(async (tx) => {
			await tx\`select pg_sleep(4)\`
		})
	} else {
		await createObjectStore(sql).ingestPack(repo, readFileSync(packPath))
	}
} catch (e) {
	caught = (e.code ? e.code + " " : "") + e.message
}
process.stdout.write("CHILD settled: " + caught.slice(0, 120) + "\\n")
await killer.catch(() => {})
await sleep(600) // let any deferred setImmediate fire before we exit
await sql.end({ timeout: 2 }).catch(() => {})
await admin.end({ timeout: 2 }).catch(() => {})
process.stdout.write("CHILD exiting cleanly\\n")
`

type Outcome =
	| { kind: "exited"; code: number; tail: string }
	| { kind: "signaled"; signal: NodeJS.Signals; tail: string }

function runChild(childPath: string, env: Record<string, string>): Promise<Outcome> {
	return new Promise((resolve, reject) => {
		const child = spawn("npx", ["tsx", childPath], {
			cwd: REPO_ROOT,
			env: { ...process.env, ...env },
		})
		let out = ""
		child.stdout.on("data", (d) => {
			out += d
		})
		child.stderr.on("data", (d) => {
			out += d
		})
		child.on("error", reject)
		child.on("close", (code, signal) => {
			const tail = out
				.split("\n")
				.filter((line) => line.trim())
				.slice(-8)
				.join(" | ")
			if (code !== null && signal === null) {
				resolve({ code, kind: "exited", tail })
				return
			}
			if (code === null && signal !== null) {
				resolve({ kind: "signaled", signal, tail })
				return
			}
			reject(
				new Error(
					`child closed with invalid code/signal state: code=${code}, signal=${signal}`,
				),
			)
		})
	})
}

type Mode = (typeof MODES)[number]
type ModeResult = { mode: Mode; crashes: number; firstTail: string }

describe("breakage/pg-txn — a killed backend must not kill the host process", () => {
	let db: IsolatedDb
	let src = ""
	let root = ""
	let childPath = ""
	const results: ModeResult[] = []

	beforeAll(async () => {
		const baseUrl = inject("pgBaseUrl")
		db = await createIsolatedSchema(baseUrl)
		root = mkdtempSync(join(tmpdir(), "pggit-copykill-"))
		src = await createAppendOnlyRepo({ runs: RUNS })

		const pack = (
			await spawnGit(["pack-objects", "--revs", "--stdout", "-q"], {
				cwd: src,
				input: "refs/heads/main\n",
			})
		).stdoutBytes
		const packPath = join(root, "push.pack")
		writeFileSync(packPath, pack)

		childPath = join(
			REPO_ROOT,
			"perf",
			"breakage",
			`_pg-txn-death-child-${randomUUID()}.ts`,
		)
		writeFileSync(childPath, CHILD_SOURCE)

		for (const mode of MODES) {
			let crashes = 0
			let firstTail = ""
			for (let i = 0; i < ITERS; i++) {
				const r = await runChild(childPath, {
					BK_MODE: mode,
					BK_PACK: packPath,
					BK_PG: baseUrl,
					BK_REPO: `txn/copykill-${mode}-${i}`,
					BK_SCHEMA: db.schema,
				})
				const crashed = r.kind === "signaled" || r.code !== 0
				if (crashed) {
					crashes++
					if (!firstTail) {
						const status = r.kind === "exited" ? `exit=${r.code}` : `signal=${r.signal}`
						firstTail = `${status} — ${r.tail}`
					}
				}
			}
			results.push({ crashes, firstTail, mode })
		}
	}, 1_800_000)

	afterAll(async () => {
		if (childPath) rmSync(childPath, { force: true })
		await db?.drop()
		if (root) rmSync(root, { force: true, recursive: true })
		if (src) rmSync(src, { force: true, recursive: true })
	})

	it("ran every fault mode", () => {
		expect(results.map((r) => r.mode)).toEqual([...MODES])
	})

	// CONTROL — a kill outside any transaction is a plain rejected query.
	it('survives a kill during a plain query ("select pg_sleep…", no transaction)', () => {
		const r = results.find((x) => x.mode === "plain-query")
		expect(
			r?.crashes,
			`${r?.crashes}/${ITERS} host processes DIED: ${r?.firstTail}`,
		).toBe(0)
	})

	it('survives a kill inside `pg.begin` ("select pg_sleep…" in a transaction)', () => {
		const r = results.find((x) => x.mode === "txn-sleep")
		expect(
			r?.crashes,
			`${r?.crashes}/${ITERS} host processes DIED: ${r?.firstTail}`,
		).toBe(0)
	})

	// CONTROL — survives only because the server answers with a FATAL 57P01 before
	// the client notices the socket, so no client-side rollback is queued.
	it('survives a kill during the COPY stream ("copy …")', () => {
		const r = results.find((x) => x.mode === "copy-stream")
		expect(
			r?.crashes,
			`${r?.crashes}/${ITERS} host processes DIED: ${r?.firstTail}`,
		).toBe(0)
	})

	it('survives a kill during the ingest\'s "insert into git_object …"', () => {
		const r = results.find((x) => x.mode === "object-insert")
		expect(
			r?.crashes,
			`${r?.crashes}/${ITERS} host processes DIED: ${r?.firstTail}`,
		).toBe(0)
	})
})

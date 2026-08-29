import { Hono } from "hono"
import postgres from "postgres"
import { describe, expect, inject, it } from "vitest"
import { createGitApp, createGitDeps } from "@/index"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { pktLineUnpack } from "@/testing/pkt-oracle"

// A client that is never queried by /health, so no real Postgres is needed.
const pg = postgres("postgres://unused:1/none")
const app = createGitApp({
	objects: createObjectStore(pg),
	refs: createRefStore(pg),
})

const A = "a".repeat(40)

/** The persistence grammar's slash-delimited repoId (<kind>/<owner>/<ws>/<user>). */
const SLASHED_REPO = "claude/slate/ws/user"

/** A minimal v2 `ls-refs` request: command + delim + flush (no args → every ref). */
const LS_REFS_REQUEST = Buffer.concat([
	encodePktLine(Buffer.from("command=ls-refs\n")),
	encodePkt({ type: "delim" }),
	encodePkt({ type: "flush" }),
])

/**
 * An app over a real isolated schema in which EXACTLY `SLASHED_REPO` holds
 * `refs/heads/main`. Routing assertions read the far side of the boundary: a
 * repoId parse that drops a segment, or keeps a mount prefix, resolves a
 * different (empty) repo whose ls-refs answer is a bare flush.
 */
async function backedApp(): Promise<{ backed: Hono; db: IsolatedDb }> {
	const db = await createIsolatedSchema(inject("pgBaseUrl"))
	const deps = createGitDeps(db.sql)
	await deps.refs.setRef(SLASHED_REPO, "refs/heads/main", A)
	return { backed: createGitApp(deps), db }
}

/** POST an ls-refs body to `path` on `target` and render the response as text. */
async function lsRefs(
	target: Hono,
	path: string,
): Promise<{ status: number; body: string }> {
	const res = await target.request(path, {
		body: new Uint8Array(LS_REFS_REQUEST),
		headers: { "git-protocol": "version=2" },
		method: "POST",
	})
	return { body: pktLineUnpack(Buffer.from(await res.arrayBuffer())), status: res.status }
}

/** POST a raw body to a git service route. */
function post(path: string, body: Buffer, headers: Record<string, string> = {}) {
	return app.request(path, { body: new Uint8Array(body), headers, method: "POST" })
}

describe("createGitApp", () => {
	it("serves 200 ok on /health", async () => {
		const res = await app.request("/health")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	it("rejects info/refs for an unsupported service", async () => {
		const res = await app.request("/repo1/info/refs?service=git-upload-archive")
		expect(res.status).toBe(403)
	})

	// The first byte-exchange of every clone/fetch: a strict client contract. git
	// refuses the connection if the Content-Type or the `# service` framing is wrong.
	it("serves the upload-pack info/refs advert with the smart-HTTP preamble + Content-Type", async () => {
		// A v2 fetch client negotiates the protocol with this header; the server
		// serves the v2 advert only when it is present (a v0 client is refused — see
		// the boundary-error suite below).
		const res = await app.request("/repo1/info/refs?service=git-upload-pack", {
			headers: { "git-protocol": "version=2" },
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("Content-Type")).toBe(
			"application/x-git-upload-pack-advertisement",
		)
		expect(res.headers.get("Cache-Control")).toBe("no-cache")
		const unpacked = pktLineUnpack(Buffer.from(await res.arrayBuffer()))
		expect(unpacked.startsWith("# service=git-upload-pack\n0000\nversion 2\n")).toBe(true)
		expect(unpacked).toContain("ls-refs=unborn\n")
		expect(unpacked.endsWith("object-format=sha1\n0000\n")).toBe(true)
	})

	// The persistence three-repo grammar uses slash-delimited repoIds
	// (<kind>/<owner>/<ws>[/<user>]). Routing must treat the repoId as the opaque
	// slash-containing string the store already keys on — not a single segment.
	// Driven through ls-refs, whose answer depends on WHICH repo was resolved: a
	// parser that kept only the first segment answers for an empty repo instead.
	it("routes a slash-containing repoId to the repo that holds the ref", async () => {
		const { backed, db } = await backedApp()
		try {
			expect(await lsRefs(backed, `/${SLASHED_REPO}/git-upload-pack`)).toEqual({
				body: `${A} refs/heads/main\n0000\n`,
				status: 200,
			})
			// The negative half: a sibling repoId under the same first segment is a
			// DIFFERENT repo, so it answers a bare flush.
			expect(await lsRefs(backed, "/claude/slate/ws/other/git-upload-pack")).toEqual({
				body: "0000\n",
				status: 200,
			})
		} finally {
			await db.drop()
		}
	})
})

// A malformed/unsupported request must surface as a clean 4xx with a readable
// message — not a 500 stacktrace.
describe("createGitApp — server-boundary error responses", () => {
	it("400s a receive-pack body with a malformed command line", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from(`${A} refs/heads/main`)), // 2-token (malformed)
			encodePkt({ type: "flush" }),
		])
		const res = await post("/repo1/git-receive-pack", body)
		expect(res.status).toBe(400)
		expect(await res.text()).toMatch(/malformed command/)
	})

	it("400s an upload-pack body with an unsupported command", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=frobnicate\n")),
			encodePkt({ type: "delim" }),
			encodePkt({ type: "flush" }),
		])
		const res = await post("/repo1/git-upload-pack", body)
		expect(res.status).toBe(400)
		expect(await res.text()).toMatch(/unsupported command/)
	})

	// Fetch is protocol-v2 only (the charter). A client that did not negotiate v2
	// (no `Git-Protocol: version=2`) cannot parse the v2 advert and would clone an
	// empty repo, so the advert is refused with a clean 4xx rather than served.
	it("400s an upload-pack info/refs request that did not negotiate protocol v2", async () => {
		const res = await app.request("/repo1/info/refs?service=git-upload-pack")
		expect(res.status).toBe(400)
	})

	it("400s a request body in an unsupported Content-Encoding", async () => {
		const res = await post("/repo1/git-upload-pack", Buffer.from("whatever"), {
			"content-encoding": "br",
		})
		expect(res.status).toBe(400)
		expect(await res.text()).toMatch(/Content-Encoding/)
	})

	// The log line is contract, not decoration — it is the only place a refusal's
	// reason survives (`createGitApp`'s onError carries why). So it must name the
	// method, the WHOLE request path (slash-delimited repoIds are paths, not
	// segments), and the same reason the body carries — read off the response here
	// rather than restated, so a reworded message can never leave log and body
	// disagreeing while this still passes. Exactly one record, so those three facts
	// are known to be ONE greppable line and a refusal is not also dumping the 500
	// branch's error object.
	it("logs a refused request server-side with its method, path and reason", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from(`${A} refs/heads/main`)), // 2-token (malformed)
			encodePkt({ type: "flush" }),
		])
		const path = `/${SLASHED_REPO}/git-receive-pack`

		const logged: string[] = []
		const realError = console.error.bind(console)
		console.error = (...args: unknown[]) => {
			logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "))
		}
		const res = await Promise.resolve(post(path, body)).finally(() => {
			console.error = realError
		})

		expect(res.status).toBe(400)
		const reason = await res.text()
		expect(logged).toHaveLength(1)
		const line = logged.join("\n")
		expect(line).toContain("POST")
		expect(line).toContain(path)
		expect(line).toContain(reason)
	})

	// An INTERNAL failure (here: the unused DB connection fails on a real query
	// during the want-walk) is NOT a GitProtocolError, so it must map to a clean
	// 500 with a generic body — never a 400 and never a leaked stack.
	it("500s on an internal backend error, not 400", async () => {
		const body = Buffer.concat([
			encodePktLine(Buffer.from("command=fetch\n")),
			encodePkt({ type: "delim" }),
			encodePktLine(Buffer.from(`want ${A}\n`)),
			encodePktLine(Buffer.from("done\n")),
			encodePkt({ type: "flush" }),
		])
		const res = await post("/repo1/git-upload-pack", body)
		expect(res.status).toBe(500)
		expect(await res.text()).toBe("internal server error")
	})
})

// The mount contract: a host MUST embed this app with `app.mount` (which strips
// the mount prefix) — NOT `app.route` (which leaves it in c.req.path and corrupts
// the parsed repoId). Pinned here because it's silent + easy to get wrong: the
// leaked prefix would resolve the repoId `git/claude/slate/ws/user`, a different
// (empty) repo, which only a repoId-dependent response can distinguish.
describe("mounted under a host prefix", () => {
	it("parses the repoId mount-relative when embedded with app.mount", async () => {
		const { backed, db } = await backedApp()
		try {
			const host = new Hono()
			host.mount("/git", backed.fetch)
			expect(await lsRefs(host, `/git/${SLASHED_REPO}/git-upload-pack`)).toEqual({
				body: `${A} refs/heads/main\n0000\n`,
				status: 200,
			})
		} finally {
			await db.drop()
		}
	})
})

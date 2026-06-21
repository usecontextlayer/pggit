import postgres from "postgres"
import { describe, expect, it } from "vitest"
import { type Database, initKysely } from "@/database"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { encodePkt, encodePktLine } from "@/pkt-line"
import { createRefStore } from "@/refs-store"

// A client that is never queried by /health, so no real Postgres is needed.
const db = initKysely<Database>(postgres("postgres://unused:1/none"))
const app = createGitApp({
	objects: createObjectStore(db),
	refs: createRefStore(db),
})

const A = "a".repeat(40)

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
})

// A malformed/unsupported request must surface as a clean 4xx with a readable
// message — not a 500 stacktrace (CLAUDE.md: validate at the boundary, fail loud).
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

	it("400s a request body in an unsupported Content-Encoding", async () => {
		const res = await post("/repo1/git-upload-pack", Buffer.from("whatever"), {
			"content-encoding": "br",
		})
		expect(res.status).toBe(400)
		expect(await res.text()).toMatch(/Content-Encoding/)
	})
})

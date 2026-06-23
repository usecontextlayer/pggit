import postgres from "postgres"
import { describe, expect, it } from "vitest"
import { createGitApp } from "@/index"
import { encodePkt, encodePktLine } from "@/protocol/pkt-line"
import { createObjectStore } from "@/store/object-store"
import { createRefStore } from "@/store/refs-store"
import { pktLineUnpack } from "@/testing/pkt-oracle"

// A client that is never queried by /health, so no real Postgres is needed.
const pg = postgres("postgres://unused:1/none")
const app = createGitApp({
	objects: createObjectStore(pg),
	refs: createRefStore(pg),
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

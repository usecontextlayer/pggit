import postgres from "postgres"
import { describe, expect, it } from "vitest"
import { type Database, initKysely } from "@/database"
import { createGitApp } from "@/index"
import { createObjectStore } from "@/object-store"
import { createRefStore } from "@/refs-store"

// A client that is never queried by /health, so no real Postgres is needed.
const db = initKysely<Database>(postgres("postgres://unused:1/none"))
const app = createGitApp({
	objects: createObjectStore(db),
	refs: createRefStore(db),
})

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

import { describe, expect, it } from "vitest"
import { createGitApp } from "@/index"

describe("createGitApp", () => {
	it("serves 200 ok on /health", async () => {
		const app = createGitApp()
		const res = await app.request("/health")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})
})

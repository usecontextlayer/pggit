import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRefStore } from "@/refs-store"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"

const A = "a".repeat(40)
const B = "b".repeat(40)

describe("ref store", () => {
	let container: StartedPostgreSqlContainer

	beforeAll(async () => {
		container = await startPostgres()
	}, 180_000)

	afterAll(async () => {
		await container?.stop()
	})

	it("stores, lists, updates direct refs and a HEAD symref", async () => {
		const db = await createIsolatedSchema(container.getConnectionUri())
		try {
			const refs = createRefStore(db.db)

			await refs.setRef("r1", "refs/heads/master", A)
			await refs.setRef("r1", "refs/tags/v1", B)
			await refs.setSymref("r1", "HEAD", "refs/heads/master")

			// listRefs returns direct refs only (not HEAD), sorted by name
			expect(await refs.listRefs("r1")).toEqual([
				{ name: "refs/heads/master", oid: A },
				{ name: "refs/tags/v1", oid: B },
			])
			expect(await refs.getSymref("r1", "HEAD")).toBe("refs/heads/master")

			// repo isolation
			expect(await refs.listRefs("r2")).toEqual([])
			expect(await refs.getSymref("r2", "HEAD")).toBeNull()

			// update overwrites the target
			await refs.setRef("r1", "refs/heads/master", B)
			const master = (await refs.listRefs("r1")).find(
				(r) => r.name === "refs/heads/master",
			)
			expect(master?.oid).toBe(B)
		} finally {
			await db.drop()
		}
	})
})

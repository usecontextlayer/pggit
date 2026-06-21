import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { computeOid } from "@/object"
import { createObjectStore } from "@/object-store"
import type { PackInputObject } from "@/pack/write-pack"
import { createIsolatedSchema, startPostgres } from "@/testing/pg"

describe("object store", () => {
	let container: StartedPostgreSqlContainer

	beforeAll(async () => {
		container = await startPostgres()
	}, 180_000)

	afterAll(async () => {
		await container?.stop()
	})

	it("round-trips objects through Postgres (put pack, get by oid)", async () => {
		const db = await createIsolatedSchema(container.getConnectionUri())
		try {
			const store = createObjectStore(db.sql)
			await store.migrate()

			const objects: PackInputObject[] = [
				{ content: Buffer.from("hello\n"), type: "blob" },
				{ content: Buffer.from([0, 1, 2, 255, 254]), type: "blob" },
				{ content: Buffer.from("commit body\n"), type: "commit" },
			]
			await store.putPack("repo1", objects)

			for (const obj of objects) {
				const oid = computeOid(obj.type, obj.content)
				expect(await store.hasObject("repo1", oid)).toBe(true)
				expect(await store.getObject("repo1", oid)).toEqual({
					content: obj.content,
					type: obj.type,
				})
			}

			const someOid = computeOid("blob", Buffer.from("hello\n"))
			// unknown oid
			expect(await store.hasObject("repo1", "0".repeat(40))).toBe(false)
			expect(await store.getObject("repo1", "0".repeat(40))).toBeNull()
			// repo isolation: repo2 cannot see repo1's objects
			expect(await store.hasObject("repo2", someOid)).toBe(false)
		} finally {
			await db.drop()
		}
	})
})

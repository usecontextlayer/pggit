/**
 * §5.1 — a push larger than Postgres' bind-parameter ceiling must still land every
 * object. A single multi-row INSERT binds one parameter per column per row, and the
 * wire protocol caps a statement at 65535 parameters; `git_object` has 5 columns,
 * so an un-chunked insert dies at ~13,107 objects. Real initial pushes of a large
 * repo exceed that. The observable contract: after ingesting N objects, all N are
 * present — independent of how the store batches the write (no assertion on chunk
 * size, only on the end state).
 */
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"

describe("M2 — large push exceeding the bind-parameter ceiling", () => {
	let container: StartedPostgreSqlContainer
	let db: IsolatedDb
	let objects: ObjectStore

	beforeAll(async () => {
		container = await startPostgres()
		db = await createIsolatedSchema(container.getConnectionUri())
		objects = createObjectStore(db.sql)
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
		await container?.stop()
	})

	it("stores every object in a push of 15,000 (> 65535/5 columns) objects", async () => {
		const N = 15_000 // 15000 * 5 columns = 75000 params > the 65535 wire limit
		const blobs = Array.from({ length: N }, (_, i) => ({
			content: Buffer.from(`blob ${i}\n`),
			type: "blob" as const,
		}))

		const { oids } = await objects.putPack("big", blobs)
		expect(oids.length).toBe(N)

		// Every object is actually retrievable — the push was not silently truncated.
		const present = await objects.commonHaves("big", oids)
		expect(present.length).toBe(N)
	}, 60_000)
})

import { describe, expect, inject, it } from "vitest"
import { createIsolatedSchema } from "@/testing/pg"

describe("postgres test fixture", () => {
	it("provides an isolated schema with a working porsager client", async () => {
		const db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			await db.sql`create table item (id int primary key, name text)`
			await db.sql`insert into item ${db.sql({ id: 1, name: "hello" })}`
			const [row] = await db.sql<{ name: string }[]>`select name from item where id = 1`
			if (row === undefined) throw new Error("inserted item is missing")
			expect(row.name).toBe("hello")
		} finally {
			await db.drop()
		}
	})

	it("isolates schemas from one another", async () => {
		const a = await createIsolatedSchema(inject("pgBaseUrl"))
		const b = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			await a.sql`create table item (id int primary key)`
			// `b` has a different search_path ⇒ must not see `a`'s table.
			await expect(b.sql`select * from item`).rejects.toThrow()
		} finally {
			await a.drop()
			await b.drop()
		}
	})
})

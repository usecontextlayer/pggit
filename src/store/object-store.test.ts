import { describe, expect, inject, it } from "vitest"
import { computeOid } from "@/object/object"
import { type PackInputObject, writePack } from "@/pack/write-pack"
import { createObjectStore } from "@/store/object-store"
import { createIsolatedSchema } from "@/testing/pg"

describe("object store", () => {
	it("round-trips objects through Postgres (put pack, get by oid)", async () => {
		const db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			const store = createObjectStore(db.sql)

			const objects: PackInputObject[] = [
				{ content: Buffer.from("hello\n"), type: "blob" },
				{ content: Buffer.from([0, 1, 2, 255, 254]), type: "blob" },
				// A well-formed commit: putPack now derives + validates edges, so a
				// non-blob's content must parse (not be opaque bytes).
				{
					content: Buffer.from(
						`tree ${"0".repeat(40)}\nauthor a <a> 0 +0000\ncommitter a <a> 0 +0000\n\nbody\n`,
						"latin1",
					),
					type: "commit",
				},
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

	// Re-ingest runs on every incremental push (overlapping objects). If the objects
	// insert ever regressed from onConflict-doNothing to an error, every second push
	// would 500 — so pin the idempotency at the unit level.
	it("putPack is idempotent — re-storing the same objects neither errors nor changes the set", async () => {
		const db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			const store = createObjectStore(db.sql)
			const objects: PackInputObject[] = [
				{ content: Buffer.from("dup-a\n"), type: "blob" },
				{ content: Buffer.from("dup-b\n"), type: "blob" },
			]
			const first = await store.putPack("repo", objects)
			const second = await store.putPack("repo", objects) // same objects again
			expect(second.oids.sort()).toEqual(first.oids.sort())
			for (const oid of first.oids) {
				expect(await store.hasObject("repo", oid)).toBe(true)
			}
		} finally {
			await db.drop()
		}
	})

	it("ingesting two overlapping packs yields the union, each object present", async () => {
		const db = await createIsolatedSchema(inject("pgBaseUrl"))
		try {
			const store = createObjectStore(db.sql)
			const a = { content: Buffer.from("only-a\n"), type: "blob" as const }
			const shared = { content: Buffer.from("shared\n"), type: "blob" as const }
			const c = { content: Buffer.from("only-c\n"), type: "blob" as const }
			await store.ingestPack("repo", writePack([a, shared]))
			await store.ingestPack("repo", writePack([shared, c])) // `shared` overlaps
			for (const obj of [a, shared, c]) {
				expect(await store.hasObject("repo", computeOid(obj.type, obj.content))).toBe(
					true,
				)
			}
		} finally {
			await db.drop()
		}
	})
})

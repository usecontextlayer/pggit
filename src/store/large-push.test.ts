/**
 * §5.1 — a push larger than Postgres' bind-parameter ceiling must still land every
 * object. A single multi-row INSERT binds one parameter per column per row, and the
 * wire protocol caps a statement at 65535 parameters; `git_object` has 5 columns,
 * so an un-chunked insert dies at ~13,107 objects. Real initial pushes of a large
 * repo exceed that. The observable contract: after ingesting N objects, all N are
 * present — independent of how the store batches the write (no assertion on chunk
 * size, only on the end state).
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createObjectStore, type ObjectStore } from "@/store/object-store"
import { allObjectOids } from "@/testing/git-fixtures"
import { createIsolatedSchema, type IsolatedDb } from "@/testing/pg"
import { spawnGit } from "@/testing/spawn-git"

async function gitBlobOids(contents: readonly Buffer[]): Promise<string[]> {
	const dir = mkdtempSync(join(tmpdir(), "pggit-large-push-oracle-"))
	try {
		await spawnGit(["init", "-q"], { cwd: dir })
		const stream: Buffer[] = []
		for (const [i, content] of contents.entries()) {
			stream.push(Buffer.from(`blob\nmark :${i + 1}\ndata ${content.length}\n`))
			stream.push(content, Buffer.from("\n"))
		}
		await spawnGit(["fast-import", "--quiet"], { cwd: dir, input: Buffer.concat(stream) })
		return await allObjectOids(dir)
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

describe("M2 — large push exceeding the bind-parameter ceiling", () => {
	let db: IsolatedDb
	let objects: ObjectStore

	beforeAll(async () => {
		db = await createIsolatedSchema(inject("pgBaseUrl"))
		objects = createObjectStore(db.sql)
	}, 180_000)

	afterAll(async () => {
		await db?.drop()
	})

	it("stores every object in a push of 15,000 (> 65535/5 columns) objects", async () => {
		const N = 15_000 // 15000 * 5 columns = 75000 params > the 65535 wire limit
		const blobs = Array.from({ length: N }, (_, i) => ({
			content: Buffer.from(`blob ${i}\n`),
			type: "blob" as const,
		}))
		const expected = await gitBlobOids(blobs.map((blob) => blob.content))

		const { oids } = await objects.putPack("big", blobs)
		expect(oids.sort()).toEqual(expected)

		// Every expected object is actually present, with no extra rows: a receipt of
		// the requested length must not be able to hide a truncated or duplicated write.
		expect((await objects.commonHaves("big", expected)).sort()).toEqual(expected)
		const rows = await db.sql<{ n: number }[]>`
			select count(*)::int as n
			from git_object o join repos r on r.id = o.repo_id
			where r.name = 'big'
		`
		expect(rows).toEqual([{ n: N }])
	}, 60_000)
})

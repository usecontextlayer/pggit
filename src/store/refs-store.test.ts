import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRefStore, type RefStore } from "@/store/refs-store"
import { createIsolatedSchema, type IsolatedDb, startPostgres } from "@/testing/pg"

const A = "a".repeat(40)
const B = "b".repeat(40)
const C = "c".repeat(40)
const ZERO = "0".repeat(40)

let container: StartedPostgreSqlContainer

beforeAll(async () => {
	container = await startPostgres()
}, 180_000)

afterAll(async () => {
	await container?.stop()
})

/** A fresh isolated ref store on its own schema. */
async function freshStore(): Promise<{ refs: RefStore; db: IsolatedDb }> {
	const db = await createIsolatedSchema(container.getConnectionUri())
	return { db, refs: createRefStore(db.sql) }
}

/** The oid stored for `name`, or undefined — the observable per-ref state. */
function oidOf(
	refs: RefStore,
	repoId: string,
	name: string,
): Promise<string | undefined> {
	return refs.listRefs(repoId).then((rs) => rs.find((r) => r.name === name)?.oid)
}

describe("ref store — seeding + listing", () => {
	it("stores, lists, updates direct refs and a HEAD symref", async () => {
		const { refs, db } = await freshStore()
		try {
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
			expect(await oidOf(refs, "r1", "refs/heads/master")).toBe(B)
		} finally {
			await db.drop()
		}
	})
})

// applyRefUpdates is the CAS surface push depends on and the part a perf refactor
// is most likely to reshape (e.g. folding CAS into one SQL statement). These pin
// its semantics by the OBSERVABLE post-state (which refs exist with which oid via
// listRefs) — NOT the boolean[] return shape (that return→report-status mapping is
// covered at the wire layer in m2-atomic). A behavior-preserving rewrite of the
// return type leaves these green.
describe("ref store — applyRefUpdates (CAS / atomic)", () => {
	it("non-atomic: applies independent commands, rejecting only the stale CAS", async () => {
		const { refs, db } = await freshStore()
		try {
			// create main=A (zero old-oid is the create sentinel)
			await refs.applyRefUpdates(
				"r",
				[{ newOid: A, oldOid: ZERO, ref: "refs/heads/main" }],
				false,
			)

			// batch: a valid create + an update whose advertised old-oid (C) is stale
			// (main is actually A). Non-atomic ⇒ the create lands, the stale one does not.
			await refs.applyRefUpdates(
				"r",
				[
					{ newOid: B, oldOid: ZERO, ref: "refs/heads/feature" },
					{ newOid: B, oldOid: C, ref: "refs/heads/main" },
				],
				false,
			)

			expect(await refs.listRefs("r")).toEqual([
				{ name: "refs/heads/feature", oid: B },
				{ name: "refs/heads/main", oid: A }, // unchanged — stale CAS rejected
			])
		} finally {
			await db.drop()
		}
	})

	it("atomic: rolls the whole batch back when any CAS is stale", async () => {
		const { refs, db } = await freshStore()
		try {
			await refs.applyRefUpdates(
				"r",
				[{ newOid: A, oldOid: ZERO, ref: "refs/heads/main" }],
				false,
			)

			// One valid create + one stale update, atomically ⇒ NEITHER applies.
			await refs.applyRefUpdates(
				"r",
				[
					{ newOid: B, oldOid: ZERO, ref: "refs/heads/feature" },
					{ newOid: B, oldOid: C, ref: "refs/heads/main" },
				],
				true,
			)

			// feature was never created; main is untouched.
			expect(await refs.listRefs("r")).toEqual([{ name: "refs/heads/main", oid: A }])
		} finally {
			await db.drop()
		}
	})

	it("atomic: applies every command when all CAS pass", async () => {
		const { refs, db } = await freshStore()
		try {
			await refs.applyRefUpdates(
				"r",
				[
					{ newOid: A, oldOid: ZERO, ref: "refs/heads/main" },
					{ newOid: B, oldOid: ZERO, ref: "refs/heads/dev" },
				],
				true,
			)
			expect(await refs.listRefs("r")).toEqual([
				{ name: "refs/heads/dev", oid: B },
				{ name: "refs/heads/main", oid: A },
			])
		} finally {
			await db.drop()
		}
	})

	it("delete (zero new-oid) removes the ref under CAS; a stale delete is rejected", async () => {
		const { refs, db } = await freshStore()
		try {
			await refs.applyRefUpdates(
				"r",
				[{ newOid: A, oldOid: ZERO, ref: "refs/heads/main" }],
				false,
			)

			// stale delete (wrong old-oid C) ⇒ rejected, ref stays.
			await refs.applyRefUpdates(
				"r",
				[{ newOid: ZERO, oldOid: C, ref: "refs/heads/main" }],
				false,
			)
			expect(await oidOf(refs, "r", "refs/heads/main")).toBe(A)

			// correct delete (old-oid A) ⇒ removed.
			await refs.applyRefUpdates(
				"r",
				[{ newOid: ZERO, oldOid: A, ref: "refs/heads/main" }],
				false,
			)
			expect(await refs.listRefs("r")).toEqual([])
		} finally {
			await db.drop()
		}
	})
})

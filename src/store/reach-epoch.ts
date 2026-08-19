import type { Kysely } from "kysely"
import { sql } from "kysely"
import type { ReservedSql } from "postgres"
import { RoaringBitmap32 } from "roaring-wasm"
import type { Database } from "@/database"
import type { ReposId } from "@/database/models/public/Repos"

/**
 * The reachability epoch — pggit's analog of git's `.bitmap`.
 * A repo carries at most ONE live epoch: `oids`, the SORTED concatenation of
 * every live oid (20 bytes each, bit *i* ⇔ `oids[i*20..]`), plus one
 * CRoaring-portable bitmap per ref tip over that ordering. Produced by the GC
 * pass (`gc.ts` orchestrates; the walk is `originClosure`), consumed by the
 * no-have serve fast path (`routeServeSet`) and by GC's own next pass.
 *
 * Bit positions are POSITIONAL against the sorted array — building them in
 * walk order instead of sorted order is the silent-corruption class here, so
 * every position in the system is read against one canonically-built array
 * (`concatSortedOids`), via `positionOf` and the slice readers here. Hex string order equals
 * byte order (hex is a per-byte monotone encoding), so JS string sorts and
 * Buffer comparisons agree everywhere.
 *
 * This module is the epoch's DATA layer: table IO + position/serialization
 * math. It deliberately imports nothing from `reachability.ts` so the serve
 * fast path there can import it without a cycle.
 */

/** One repo's live epoch, as stored. `tips`/`bitmaps` are keyed by hex oid;
 * bitmap bytes stay serialized until a consumer needs the positions. */
export type Epoch = {
	epoch: number
	tips: string[]
	oids: Buffer
	bitmaps: Map<string, Uint8Array>
}

/** The three states a two-statement epoch read can observe. `incomplete` is a
 * deliberate concurrency outcome: replacement may commit between the epoch
 * row read and its epoch-pinned bitmap read, making the second query return
 * fewer bitmaps. Consumers must walk/rebuild; they must never infer readiness
 * again from `Map` membership. */
export type EpochLoad =
	| { state: "absent" }
	| { state: "ready"; epoch: Epoch }
	| { state: "incomplete"; epoch: Epoch }

/** What one GC pass decided about the epoch — `GcResult` surfaces it so rewind
 * rebuilds and quiet-drain skips are observable without log-scraping.
 * `unchanged` = tips identical, nothing
 * written; `advanced` = steady-state delta over the prior epoch; `rebuilt` =
 * full walk (first epoch, or the loud rewind/deletion fallback); `cleared` =
 * no epoch is stored anymore — the repo has no refs, or the walk reported
 * MISSING objects and a bitmap would mask the incomplete closure (a `cleared`
 * on a repo WITH refs is that anomaly, visible in the drain summary). */
export type EpochOutcome = "unchanged" | "advanced" | "rebuilt" | "cleared"

const OID_BYTES = 20

/** Read a repo's live epoch and name whether it is absent, ready, or caught
 * mid-replacement with an incomplete bitmap set. */
export async function loadEpoch(db: Kysely<Database>, id: ReposId): Promise<EpochLoad> {
	const [row] = (
		await sql<{ epoch: string; tips: Buffer; oids: Buffer }>`
			select epoch::text as epoch, tips, oids from git_reach_epoch
			where repo_id = ${id}::bigint
		`.execute(db)
	).rows
	if (!row) return { state: "absent" }
	// The bitmap read is PINNED to the epoch the first statement saw: a GC pass
	// can replace the epoch between the two reads, and E's array combined with
	// E+1's bitmaps would serve substituted objects. Pinned, a mid-replacement
	// read simply comes back short and the serve-side missing-bitmap guard
	// falls back to the walk.
	const bits = await sql<{ tip: string; bits: Buffer }>`
		select encode(tip_oid, 'hex') as tip, bits from git_reach_bitmap
		where repo_id = ${id}::bigint and epoch = ${row.epoch}::bigint
	`.execute(db)
	const bitmaps = new Map<string, Uint8Array>()
	for (const b of bits.rows) bitmaps.set(b.tip, b.bits)
	const epoch = {
		bitmaps,
		epoch: Number(row.epoch),
		oids: row.oids,
		tips: splitOids(row.tips),
	}
	return {
		epoch,
		state: epoch.tips.every((tip) => bitmaps.has(tip)) ? "ready" : "incomplete",
	}
}

/** Replace the repo's epoch atomically: the old row's deletion CASCADEs every
 * old-epoch bitmap away, so a bitmap can never be read against a different
 * epoch's array. Runs on the GC pass's reserved connection, AFTER the sweep
 * (the epoch's tips were carried in JS from the walk snapshot; a walk that
 * reported missing objects never reaches this — see gc.ts). */
export async function writeEpoch(
	conn: ReservedSql,
	id: ReposId,
	payload: Epoch,
): Promise<void> {
	try {
		await conn`begin`
		await conn.unsafe(`delete from git_reach_epoch where repo_id = $1::bigint`, [
			String(id),
		])
		await conn.unsafe(
			`insert into git_reach_epoch (repo_id, epoch, tips, oids) values ($1::bigint, $2::bigint, $3, $4)`,
			[String(id), String(payload.epoch), concatSortedOids(payload.tips), payload.oids],
		)
		for (const [tip, bits] of payload.bitmaps) {
			await conn.unsafe(
				`insert into git_reach_bitmap (repo_id, epoch, tip_oid, bits) values ($1::bigint, $2::bigint, $3, $4)`,
				[String(id), String(payload.epoch), Buffer.from(tip, "hex"), Buffer.from(bits)],
			)
		}
		await conn`commit`
	} catch (err) {
		// Same discipline as gc.ts's walk: never hand the pool an open aborted
		// transaction; the write's own error must propagate, never this cleanup's.
		await conn`rollback`.catch(() => {})
		throw err
	}
}

/** Delete the repo's epoch (the no-refs case — an empty epoch is not stored). */
export async function deleteEpoch(conn: ReservedSql, id: ReposId): Promise<void> {
	await conn.unsafe(`delete from git_reach_epoch where repo_id = $1::bigint`, [
		String(id),
	])
}

/** Concatenate hex oids in canonical (sorted, deduplicated) byte order — the
 * ONE place the positional ordering is defined. */
export function concatSortedOids(hexes: Iterable<string>): Buffer {
	const sorted = [...new Set(hexes)].sort()
	const out = Buffer.allocUnsafe(sorted.length * OID_BYTES)
	sorted.forEach((h, i) => {
		out.write(h, i * OID_BYTES, "hex")
	})
	return out
}

/** The hex oids of a concatenated array, in position order. */
export function splitOids(oids: Buffer): string[] {
	const out: string[] = []
	for (let i = 0; i < oids.length; i += OID_BYTES) {
		out.push(oidAtPosition(oids, i / OID_BYTES))
	}
	return out
}

/** Read the hex OID at one epoch bit position. */
export function oidAtPosition(oids: Buffer, position: number): string {
	return oids.toString("hex", position * OID_BYTES, (position + 1) * OID_BYTES)
}

/** Binary-search a hex oid's bit position in a concatenated sorted array;
 * -1 when absent. */
export function positionOf(oids: Buffer, hex: string): number {
	const needle = Buffer.from(hex, "hex")
	let lo = 0
	let hi = oids.length / OID_BYTES - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const cmp = needle.compare(oids, mid * OID_BYTES, (mid + 1) * OID_BYTES)
		if (cmp === 0) return mid
		if (cmp < 0) hi = mid - 1
		else lo = mid + 1
	}
	return -1
}

/** Serialize a set of bit positions as a CRoaring-portable bitmap. */
export function bitmapFromPositions(positions: Iterable<number>): Uint8Array {
	const bm = new RoaringBitmap32()
	try {
		for (const p of positions) bm.add(p)
		bm.optimize()
		return bm.serialize("portable")
	} finally {
		bm.dispose()
	}
}

/** The hex oids named by the UNION of the given bitmaps, over one epoch's
 * array — the no-have serve path's whole read. */
export function oidsOfUnion(bitmaps: Iterable<Uint8Array>, oids: Buffer): string[] {
	const acc = new RoaringBitmap32()
	try {
		for (const bytes of bitmaps) {
			const bm = RoaringBitmap32.deserialize(bytes, "portable")
			try {
				acc.orInPlace(bm)
			} finally {
				bm.dispose()
			}
		}
		const out: string[] = []
		for (const p of acc.toUint32Array()) {
			out.push(oidAtPosition(oids, p))
		}
		return out
	} finally {
		acc.dispose()
	}
}

/** Whether position `pos` is set in any of the given bitmaps. */
export function unionHas(bitmaps: Iterable<Uint8Array>, pos: number): boolean {
	for (const bytes of bitmaps) {
		const bm = RoaringBitmap32.deserialize(bytes, "portable")
		try {
			if (bm.has(pos)) return true
		} finally {
			bm.dispose()
		}
	}
	return false
}

/** Re-express a stored bitmap's positions against a NEW epoch array (the
 * steady-state remap: refs-only-advance keeps every old oid, so each old
 * position maps by oid identity), optionally dropping specific oids (a tag
 * tip's chain, when its PEELED commit is what the consumer holds). */
export function remapPositions(
	bits: Uint8Array,
	oldOids: Buffer,
	newOids: Buffer,
	dropHexes?: ReadonlySet<string>,
): number[] {
	const bm = RoaringBitmap32.deserialize(bits, "portable")
	try {
		const out: number[] = []
		for (const p of bm.toUint32Array()) {
			const hex = oidAtPosition(oldOids, p)
			if (dropHexes?.has(hex)) continue
			const np = positionOf(newOids, hex)
			if (np === -1) {
				throw new Error(
					`pggit reach-epoch: oid ${hex} of the prior epoch is absent from the new array — the steady-state precondition (refs only advanced) was violated after it was checked`,
				)
			}
			out.push(np)
		}
		return out
	} finally {
		bm.dispose()
	}
}

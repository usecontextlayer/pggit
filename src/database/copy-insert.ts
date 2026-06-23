import type { TransactionSql } from "postgres"

/**
 * Bulk binary insert via `COPY … FROM STDIN (FORMAT binary)` into a staging temp
 * table, then `INSERT … SELECT … ON CONFLICT DO NOTHING`. This is the one bulk-row
 * insert path for the ingest spine, and it exists because a multi-row `INSERT`
 * cannot carry git's data correctly:
 *
 *  - The porsager driver serializes a `bytea` parameter as the text `'\x'+hex`,
 *    DOUBLING the byte length; a blob over ~256MiB therefore overruns V8's max
 *    string length and the insert throws. COPY binary streams the bytea as RAW
 *    bytes — content never lands on the JS string heap, so blob size is bounded
 *    only by Postgres (`bytea` ~1GB), not by the string cap.
 *  - The wire protocol caps a statement at 65534 bind parameters (≈13k object rows
 *    at 5 columns); COPY binds none, so any row count goes in a single statement —
 *    no chunking, whatever the column count.
 *
 * The staging hop keeps ingest idempotent (a re-sent object skips on the primary
 * key), exactly as the prior `onConflict().doNothing()` did. Caller runs it on a
 * transaction-scoped `Sql` so the staging COPY and the final insert commit
 * together; the temp table drops on commit.
 */

/** One COPY field, tagged with the destination column's Postgres type so it
 * encodes to the correct binary wire form. */
export type CopyValue =
	| { t: "int2"; v: number }
	| { t: "int4"; v: number }
	| { t: "int8"; v: number | bigint | string }
	| { t: "bytea"; v: Buffer }
	| { t: "text"; v: string }

// PGCOPY binary signature + the two zero header words (flags, header extension).
const HEADER = Buffer.concat([
	Buffer.from([0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00]),
	Buffer.alloc(8),
])
// File trailer: a -1 field count.
const TRAILER = (() => {
	const b = Buffer.alloc(2)
	b.writeInt16BE(-1)
	return b
})()

function encodeValue(field: CopyValue): Buffer {
	switch (field.t) {
		case "int2": {
			const b = Buffer.alloc(2)
			b.writeInt16BE(field.v)
			return b
		}
		case "int4": {
			const b = Buffer.alloc(4)
			b.writeInt32BE(field.v)
			return b
		}
		case "int8": {
			const b = Buffer.alloc(8)
			b.writeBigInt64BE(BigInt(field.v))
			return b
		}
		case "bytea":
			return field.v
		case "text":
			return Buffer.from(field.v, "utf8")
	}
}

/** Encode rows as one PGCOPY binary payload: header, then per row a field count
 * and each field as `<int32 length><raw bytes>`, then the trailer. */
function encodeBinaryCopy(rows: CopyValue[][]): Buffer {
	const parts: Buffer[] = [HEADER]
	for (const row of rows) {
		const fieldCount = Buffer.alloc(2)
		fieldCount.writeInt16BE(row.length)
		parts.push(fieldCount)
		for (const field of row) {
			const value = encodeValue(field)
			const len = Buffer.alloc(4)
			len.writeInt32BE(value.length)
			parts.push(len, value)
		}
	}
	parts.push(TRAILER)
	return Buffer.concat(parts)
}

/**
 * COPY `rows` into `target` (a temp staging table shaped from `target`'s columns,
 * then `INSERT … SELECT … ON CONFLICT DO NOTHING`). `tx` must be a
 * transaction-scoped porsager `Sql`. `target` and `columns` are internal constants
 * (never client input), interpolated as SQL identifiers.
 */
export async function copyInsert(
	tx: TransactionSql,
	target: string,
	columns: readonly string[],
	rows: CopyValue[][],
): Promise<void> {
	if (rows.length === 0) return
	const cols = columns.join(", ")
	const staging = `copy_stg_${target}`
	// `CREATE TABLE AS … WITH NO DATA` shapes the staging table from exactly the
	// inserted columns (their types, no NOT NULL / defaults / constraints), so COPY
	// fills every column it declares and the final insert lets `target` apply its
	// own defaults (e.g. git_object.created_at) to the unlisted ones.
	await tx.unsafe(
		`create temp table ${staging} on commit drop as select ${cols} from ${target} with no data`,
	)
	const writable =
		await tx`copy ${tx(staging)} (${tx.unsafe(cols)}) from stdin (format binary)`.writable()
	await new Promise<void>((resolve, reject) => {
		writable.on("error", reject)
		writable.on("finish", () => resolve())
		writable.write(encodeBinaryCopy(rows), (err) => {
			if (err) reject(err)
			else writable.end()
		})
	})
	await tx.unsafe(
		`insert into ${target} (${cols}) select ${cols} from ${staging} on conflict do nothing`,
	)
}
